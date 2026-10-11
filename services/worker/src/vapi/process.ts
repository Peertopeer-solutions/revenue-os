// Vapi event processor: the webhook.process.vapi job (jobs.ts) runs it for one company after the receiver stores
// its events. Events arrive OUT OF ORDER (the Vapi gotcha in AGENTS.md), so they are filed in the order their
// timestamps give, onto the company's conversation for that call id, each message taking the next seq. Each event
// is filed on its own: one that fails is marked failed with its reason, and the company's other events still go
// through (ROADMAP.md, Slice 1).
import { withOrg } from "@revenue-os/db";
import { type VapiWebhook, VapiWebhookSchema } from "@revenue-os/shared";
import type pg from "pg";
import { logger } from "../logger";

type Tx = pg.PoolClient;
type Message = VapiWebhook["message"];

const ROLE_MAP = { assistant: "agent", user: "contact" } as const;

/** The company's conversation for this call id, made on its first event. Another company's call id is its own. */
async function ensureConversation(
  tx: Tx,
  orgId: string,
  callId: string,
  startedAt: string | null,
): Promise<string> {
  const r = await tx.query(
    `insert into conversations (org_id, channel, direction, status, provider, provider_ref, started_at)
		 values ($1, 'voice', 'inbound', 'active', 'vapi', $2, $3)
		 on conflict (org_id, provider, provider_ref) where provider_ref is not null
		 do update set provider = excluded.provider
		 returning id`,
    [orgId, callId, startedAt],
  );
  const id = r.rows[0]?.id;
  if (typeof id !== "string")
    throw new Error("conversation upsert returned no id");
  return id;
}

/** One transcript line, appended as the conversation's next message. */
async function fileTranscript(
  tx: Tx,
  orgId: string,
  callId: string,
  m: Message & { transcript: string; role: keyof typeof ROLE_MAP },
) {
  const conversationId = await ensureConversation(
    tx,
    orgId,
    callId,
    m.timestamp ?? null,
  );
  await tx.query(
    `insert into messages (org_id, conversation_id, seq, role, content)
		 select $1, $2, coalesce(max(seq), 0) + 1, $3, $4 from messages where org_id = $1 and conversation_id = $2
		 on conflict (org_id, conversation_id, seq) do nothing`,
    [orgId, conversationId, ROLE_MAP[m.role], m.transcript],
  );
}

/** The call's end: the conversation completes with its summary, which becomes the lead's latest memory. */
async function fileEndOfCall(
  tx: Tx,
  orgId: string,
  callId: string,
  m: Message,
) {
  const conversationId = await ensureConversation(tx, orgId, callId, null);
  const summary = m.summary ?? null;
  const done = await tx.query<{ contact_id: string | null }>(
    `update conversations set status = 'completed', ended_at = $3, summary = $4
		 where org_id = $1 and id = $2 returning contact_id`,
    [orgId, conversationId, m.timestamp ?? new Date().toISOString(), summary],
  );
  const contactId = done.rows[0]?.contact_id;
  // Fold the summary into long-term memory (verbatim, no embedding yet): insert the new live row, then point the
  // contact's previous live summary at it. Scoped by CONTACT, as an org-wide supersede would bury every other
  // contact's memory. An unknown caller (no contact) or a report with nothing to say makes no memory.
  if (!contactId || !summary) return;
  await tx.query(
    `with new_memory as (
		   insert into contact_memories (org_id, contact_id, kind, content, source_conversation_id)
		   values ($1, $2, 'summary', $3, $4) returning id
		 )
		 update contact_memories set superseded_by = new_memory.id
		 from new_memory
		 where contact_memories.org_id = $1 and contact_memories.contact_id = $2
		   and contact_memories.kind = 'summary'
		   and contact_memories.superseded_by is null
		   and contact_memories.id <> new_memory.id`,
    [orgId, contactId, summary, conversationId],
  );
}

/** Files one stored event. Anything not understood is stored and skipped, never guessed at (docs/security.md S6.5). */
async function fileEvent(
  tx: Tx,
  orgId: string,
  payload: unknown,
): Promise<"processed" | "skipped"> {
  const parsed = VapiWebhookSchema.safeParse(payload);
  const m = parsed.success ? parsed.data.message : null;
  const callId = m?.call?.id;
  if (!m || !callId) return "skipped";
  if (m.type === "transcript" && m.transcript && m.role)
    await fileTranscript(tx, orgId, callId, {
      ...m,
      transcript: m.transcript,
      role: m.role,
    });
  else if (m.type === "end-of-call-report")
    await fileEndOfCall(tx, orgId, callId, m);
  else if (m.type === "status-update")
    await ensureConversation(tx, orgId, callId, m.timestamp ?? null);
  else return "skipped";
  return "processed";
}

/**
 * Did the event cause this failure? The database's data and rule errors (classes 22 and 23: a timestamp that names no
 * time, a broken key) and our own errors are the event's; every other database error (a lost connection, a deadlock,
 * a cancelled or timed-out statement, no resources) is the database's, and a later run may well get through.
 */
function eventsFault(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code !== "string" || /^2[23]/.test(code);
}

/** Files every 'received' Vapi event of the company, ordered by payload timestamp, each on its own. */
export async function processVapiEvents(
  pool: pg.Pool,
  orgId: string,
): Promise<void> {
  await withOrg(pool, orgId, async (tx) => {
    const events = await tx.query(
      `select id, payload from webhook_events
			 where org_id = $1 and provider = 'vapi' and status = 'received'
			 order by (payload -> 'message' ->> 'timestamp') asc nulls last, id asc
			 for update`,
      [orgId],
    );

    for (const row of events.rows) {
      // A failure the event causes undoes only that event's writes and marks it failed. Any other fails the whole
      // job, so pg-boss runs it again and no event is marked failed for it; a lost connection also fails this
      // savepoint's rollback.
      await tx.query("savepoint vapi_event");
      let status: string;
      let error: string | null = null;
      try {
        status = await fileEvent(tx, orgId, row.payload);
      } catch (err) {
        if (!eventsFault(err)) throw err;
        await tx.query("rollback to savepoint vapi_event");
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, org_id: orgId, webhook_event_id: row.id },
          "vapi event failed",
        );
      }
      await tx.query("release savepoint vapi_event");
      await tx.query(
        `update webhook_events set status = $3, error = $4, processed_at = now() where org_id = $1 and id = $2`,
        [orgId, row.id, status, error],
      );
    }
  });
}
