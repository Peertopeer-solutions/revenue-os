// Vapi event processor: the webhook.process.vapi job (jobs.ts) runs it for one company after the receiver stores
// its events. Events arrive OUT OF ORDER (the Vapi gotcha in AGENTS.md), so they are filed in the order their
// timestamps give, onto the company's conversation for that call id, each message taking the next seq. Each event
// is filed on its own: one that fails is marked failed with its reason, and the company's other events still go
// through (ROADMAP.md, Slice 1).
import {
  addMessage,
  type ConvoStatus,
  finishConversation,
  leadsWithNumber,
  openConversation,
  recordDoNotCall,
  withOrg,
} from "@revenue-os/db";
import {
  normalizePhoneE164,
  VapiCustomerSchema,
  VapiReadingSaysDoNotCallSchema,
  type VapiWebhook,
  VapiWebhookSchema,
} from "@revenue-os/shared";
import type pg from "pg";
import { logger } from "../logger";

type Tx = pg.PoolClient;
type Message = VapiWebhook["message"];

const ROLE_MAP = { assistant: "agent", user: "contact" } as const;

/** A message's time as Postgres takes it: Vapi's epoch milliseconds become an ISO time; a string goes as it came. */
const callTime = (t: Message["timestamp"]) =>
  typeof t === "number" ? new Date(t).toISOString() : (t ?? null);

/** The company's conversation for this call id, opened on its first event (or by the job that placed the call). */
const ensureConversation = (
  tx: Tx,
  orgId: string,
  callId: string,
  startedAt: string | null,
) =>
  openConversation(tx, orgId, {
    channel: "voice",
    direction: "inbound",
    provider: "vapi",
    providerRef: callId,
    startedAt,
  });

/** One transcript line, added as the conversation's next message at the time Vapi gives it. */
async function fileTranscript(
  tx: Tx,
  orgId: string,
  callId: string,
  m: Message & { transcript: string; role: keyof typeof ROLE_MAP },
) {
  const at = callTime(m.timestamp);
  const conversationId = await ensureConversation(tx, orgId, callId, at);
  await addMessage(tx, orgId, conversationId, {
    role: ROLE_MAP[m.role],
    content: m.transcript,
    at,
  });
}

/** How a call ended, from Vapi's endedReason; the call's outcome arrives with Slice 4's end-of-call item. */
const ENDED_AS: [RegExp, ConvoStatus][] = [
  [/did-not-answer|no-answer/, "no_answer"],
  [/busy/, "busy"],
  [/voicemail/, "voicemail"],
  [/error|fail/, "failed"],
];
const callStatus = (reason = ""): ConvoStatus =>
  ENDED_AS.find(([re]) => re.test(reason))?.[1] ?? "completed";

/**
 * The call's end: the conversation finishes with how it ended, its start and end times and its summary, which becomes
 * the lead's latest memory. A request in the AI's reading not to be contacted was recorded before this, on its own
 * (blockFirst).
 */
async function fileEndOfCall(
  tx: Tx,
  orgId: string,
  callId: string,
  m: Message,
) {
  const conversationId = await ensureConversation(
    tx,
    orgId,
    callId,
    m.startedAt ?? null,
  );
  const summary = m.summary ?? null;
  const { contactId } = await finishConversation(tx, orgId, conversationId, {
    status: callStatus(m.endedReason),
    endedAt: m.endedAt ?? callTime(m.timestamp),
    summary,
  });
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

/**
 * An end-of-call report whose AI reading says the lead asked not to be contacted: the call's lead is blocked before
 * the report is filed, in a savepoint of its own, so a part of the report that can't be filed (an end time Postgres
 * can't read) never undoes the block. A failure the report causes here undoes only the block, and filing the report
 * then fails the same way; the database's own trouble fails the whole job, which runs again.
 */
async function blockFirst(tx: Tx, orgId: string, payload: unknown) {
  const m = VapiWebhookSchema.safeParse(payload).data?.message;
  const callId = m?.call?.id;
  if (
    m?.type !== "end-of-call-report" ||
    !callId ||
    !VapiReadingSaysDoNotCallSchema.safeParse(m).success
  )
    return;
  await tx.query("savepoint vapi_block");
  try {
    const conversationId = await ensureConversation(tx, orgId, callId, null);
    await blockCallsLead(tx, orgId, conversationId, m);
  } catch (err) {
    if (!eventsFault(err)) throw err;
    await tx.query("rollback to savepoint vapi_block");
  }
  await tx.query("release savepoint vapi_block");
}

/**
 * The AI's reading of the call asked not to be contacted: block the call's lead, the conversation's own or, on a call
 * no lead is linked to (one that came in), the company's leads with the number the call came from.
 */
async function blockCallsLead(
  tx: Tx,
  orgId: string,
  conversationId: string,
  m: Message,
) {
  const linked = await tx.query<{ contact_id: string | null }>(
    "select contact_id from conversations where org_id = $1 and id = $2",
    [orgId, conversationId],
  );
  const contactId = linked.rows[0]?.contact_id;
  const customer =
    VapiCustomerSchema.safeParse(m).data ??
    VapiCustomerSchema.safeParse(m.call).data;
  const number = normalizePhoneE164(customer?.customer.number ?? "");
  const leads = contactId
    ? [contactId]
    : number
      ? await leadsWithNumber(tx, orgId, number)
      : [];
  for (const lead of leads)
    await recordDoNotCall(tx, orgId, lead, { from: "call", conversationId });
  if (!leads.length)
    logger.warn(
      { org_id: orgId, conversation_id: conversationId },
      "a do-not-call request was heard on a call no lead of the company is linked to or called from",
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
    await ensureConversation(tx, orgId, callId, callTime(m.timestamp));
  else return "skipped";
  return "processed";
}

/**
 * Did the event cause this failure? Only the database's own trouble is not the event's, as a later run may get
 * through it: a lost connection (08), a deadlock or serialization failure (40), no resources (53), a cancelled or
 * timed-out statement (57), a system or internal error (58, XX), a lock wait that timed out (55P03). Anything else
 * fails the same way on every run (a timestamp that names no time, a broken key, a call id too long for its key, an
 * error of our own code), so retrying it would block the company's other events for good. A dead connection also
 * fails the savepoint's rollback, whatever its error says.
 */
function eventsFault(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code !== "string" || !/^(08|40|53|57|58|XX)|^55P03$/.test(code);
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
      await blockFirst(tx, orgId, row.payload);
      // A failure the event causes undoes only that event's writes and marks it failed. The database's own trouble
      // fails the whole job, so pg-boss runs it again and no event is marked failed for it.
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
