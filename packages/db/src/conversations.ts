// Conversations: the one way each is opened, given a message and finished (openConversation, addMessage,
// finishConversation, which every part of the product calls), and the console's reads: the live monitor's list and
// one conversation's transcript (shown as text, docs/security.md S7.1). Each read filters by company, on top of the
// database's per-company rules: another company's conversation is not found, so the transcript read returns null (the
// route maps that to 404 and never leaks that it exists); the company's own conversation with no messages is a valid
// empty array.
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import { ConversationIdSchema } from "@revenue-os/shared";
import type pg from "pg";
import { type Db, withOrg } from "./client";

export interface TranscriptRow {
  seq: number;
  role: string;
  content: string | null;
  ts: string;
}

export async function conversationMessages(
  pool: pg.Pool,
  orgId: string,
  conversationId: string,
): Promise<TranscriptRow[] | null> {
  const convoId = ConversationIdSchema.parse(conversationId); // S5.1 — boundary parse
  return withOrg(pool, orgId, async (tx) => {
    const convo = await tx.query(
      "select id from conversations where org_id = $1 and id = $2",
      [orgId, convoId],
    );
    if (convo.rows.length === 0) return null; // another company's, or none ⇒ route 404s
    const result = await tx.query(
      `select seq, role, content, ts::text as ts
         from messages where org_id = $1 and conversation_id = $2 order by seq`,
      [orgId, convoId],
    );
    return result.rows.map((row) => ({
      seq: row.seq,
      role: row.role,
      content: row.content ?? null,
      ts: row.ts,
    }));
  });
}

export interface ConversationRow {
  id: string;
  channel: string;
  status: string;
  direction: string;
  contact_name: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export async function listConversations(
  pool: pg.Pool,
  orgId: string,
): Promise<ConversationRow[]> {
  return withOrg(pool, orgId, async (tx) => {
    const result = await tx.query(
      `select c.id, c.channel, c.status, c.direction,
              nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as contact_name,
              c.started_at::text as started_at, c.ended_at::text as ended_at
         from conversations c
         left join contacts ct on ct.org_id = $1 and ct.id = c.contact_id
        where c.org_id = $1
        order by c.started_at desc nulls last
        limit 100`,
      [orgId],
    );
    return result.rows;
  });
}

// ── The one way each conversation operation is written (`bun run guards` fails an insert into conversations or
// messages, or any other write to them, in any other file). Each takes the caller's withOrg transaction as a plain
// `Db`, so its rows commit or roll back with the caller's change.

export type ConvoStatus =
  | "completed"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "failed"
  | "canceled";

/**
 * Opens a conversation and returns its id; its start time is the time given, or now.
 * - A call (a provider and its call id): the company's conversation for that call id, whichever writer comes first
 *   (the call's own events, or the job that placed it). A second open only fills what is still missing, keeps the
 *   earliest start time, and marks the call outbound when the job that placed it says so; it never overwrites.
 * - A thread (a lead, no call id: WhatsApp now): the lead's open thread on that channel is reused, and follows the
 *   newest run that writes to it (docs/decisions-in-force/2026-10-19-a-lead-s-open-thread-is-reused.md).
 * - Anyone else (no lead, no call id): a new conversation.
 */
export async function openConversation(
  db: Db,
  orgId: string,
  c: {
    channel: "voice" | "whatsapp" | "sms" | "email";
    direction: "inbound" | "outbound";
    contactId?: string;
    workflowRunId?: string;
    agentId?: string;
    provider?: string;
    providerRef?: string;
    startedAt?: string | null;
  },
): Promise<string> {
  const values = [
    orgId,
    c.contactId ?? null,
    c.workflowRunId ?? null,
    c.agentId ?? null,
    c.channel,
    c.direction,
    c.provider ?? null,
    c.providerRef ?? null,
    c.startedAt ?? null,
  ];
  const opened = c.providerRef
    ? await db.query(
        `insert into conversations
           (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status, provider, provider_ref, started_at)
         values ($1, $2, $3, $4, $5, $6, 'active', $7, $8, coalesce($9::timestamptz, now()))
         on conflict (org_id, provider, provider_ref) where provider_ref is not null do update set
           contact_id = coalesce(conversations.contact_id, excluded.contact_id),
           workflow_run_id = coalesce(conversations.workflow_run_id, excluded.workflow_run_id),
           agent_id = coalesce(conversations.agent_id, excluded.agent_id),
           direction = case when excluded.direction = 'outbound' then excluded.direction
                            else conversations.direction end,
           started_at = least(conversations.started_at, excluded.started_at)
         returning id`,
        values,
      )
    : c.contactId
      ? await db.query(
          `insert into conversations
             (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status, provider, provider_ref, started_at)
           values ($1, $2, $3, $4, $5, $6, 'active', $7, $8, coalesce($9::timestamptz, now()))
           on conflict (org_id, contact_id, channel)
             where contact_id is not null and provider_ref is null and status in ('queued', 'ringing', 'active')
           do update set
             workflow_run_id = coalesce(excluded.workflow_run_id, conversations.workflow_run_id),
             agent_id = coalesce(conversations.agent_id, excluded.agent_id),
             provider = coalesce(conversations.provider, excluded.provider)
           returning id`,
          values,
        )
      : await db.query(
          `insert into conversations
             (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status, provider, provider_ref, started_at)
           values ($1, $2, $3, $4, $5, $6, 'active', $7, $8, coalesce($9::timestamptz, now()))
           returning id`,
          values,
        );
  return String(opened.rows[0]?.id);
}

/**
 * Adds a message as the conversation's next line and returns its seq. Two writers at once take turns on the
 * conversation's row, and the insert, a statement of its own after the lock, sees the other's line, so every line gets
 * the next seq and none is lost. Seq is the order lines were saved; `at` is the event's own time
 * (docs/decisions-in-force/2026-10-19-a-message-s-seq-is-the-order-it-was-saved.md). Another company's conversation,
 * or none, is refused.
 */
export async function addMessage(
  db: Db,
  orgId: string,
  conversationId: string,
  m: {
    role: "agent" | "contact" | "human_agent" | "system" | "tool";
    content?: string | null;
    toolCall?: unknown;
    at?: string | null;
  },
): Promise<number> {
  const convo = await db.query(
    "select id from conversations where org_id = $1 and id = $2 for no key update",
    [orgId, conversationId],
  );
  if (!convo.rows[0])
    throw new Error(
      `conversation ${conversationId} is not one of this company's`,
    );
  const added = await db.query(
    `insert into messages (org_id, conversation_id, seq, role, content, tool_call, ts)
     select $1, $2, coalesce(max(seq), 0) + 1, $3, $4, $5::jsonb, coalesce($6::timestamptz, now())
       from messages where org_id = $1 and conversation_id = $2
     returning seq`,
    [
      orgId,
      conversationId,
      m.role,
      m.content ?? null,
      m.toolCall === undefined ? null : JSON.stringify(m.toolCall),
      m.at ?? null,
    ],
  );
  return Number(added.rows[0]?.seq);
}

/**
 * Finishes a conversation with its status and, when one is known, its outcome: one of this company's dispositions, by
 * key (interested, not_interested, callback…); a key the company doesn't have is refused. It finishes once: a later
 * finish keeps the status and end time and only fills what is still missing. Returns the conversation's lead.
 */
export async function finishConversation(
  db: Db,
  orgId: string,
  conversationId: string,
  f: {
    status: ConvoStatus;
    endedAt?: string | null;
    summary?: string | null;
    outcome?: string;
  },
): Promise<{ contactId: string | null }> {
  let dispositionId: unknown = null;
  if (f.outcome !== undefined) {
    dispositionId = (
      await db.query(
        "select id from dispositions where org_id = $1 and key = $2",
        [orgId, f.outcome],
      )
    ).rows[0]?.id;
    if (!dispositionId)
      throw new Error(`"${f.outcome}" is not one of this company's outcomes`);
  }
  const done = await db.query(
    `update conversations
        set status = case when status in ('queued', 'ringing', 'active') then $3::app.convo_status else status end,
            ended_at = coalesce(ended_at, $4::timestamptz, now()),
            summary = coalesce(summary, $5),
            disposition_id = coalesce(disposition_id, $6)
      where org_id = $1 and id = $2
      returning contact_id`,
    [
      orgId,
      conversationId,
      f.status,
      f.endedAt ?? null,
      f.summary ?? null,
      dispositionId,
    ],
  );
  const row = done.rows[0];
  if (!row)
    throw new Error(
      `conversation ${conversationId} is not one of this company's`,
    );
  return { contactId: (row.contact_id as string | null) ?? null };
}
