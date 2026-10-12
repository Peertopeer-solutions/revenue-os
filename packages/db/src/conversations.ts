// The console's conversation reads: the live monitor's list and one conversation's transcript (shown as text,
// docs/security.md S7.1). Each filters by company, on top of the database's per-company rules: another company's
// conversation is not found, so the transcript read returns null (the route maps that to 404 and never leaks that
// it exists); the company's own conversation with no messages is a valid empty array.
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import { ConversationIdSchema } from "@revenue-os/shared";
import type pg from "pg";
import { withOrg } from "./client";

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
