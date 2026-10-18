// The worker's record of each call and WhatsApp message it sends (the sends table, migration 021). A job can run
// twice: delivered twice, or run again after it failed once the provider had already taken the send. So a handler
// saves the send before it calls the provider, under a key that is the same however often its job runs, and a run
// that finds the key saved never sends again: it goes on from the saved result or, when the provider's answer was
// never saved, hands the lead to a person (docs/decisions-in-force/2026-09-25-scheduler-database-error-policy.md).
import type { PoolClient } from "pg";

export type SendStatus = "sending" | "sent" | "blocked" | "unknown";

/** One send, as a job handler saves it before the provider is called. */
export type Send = {
  key: string;
  channel: "voice" | "whatsapp";
  contactId: string;
  runId: string;
  payload: Record<string, unknown>; // what is about to be sent: the number, a template and its values
};

/** What a job carries to name its send: the scheduler gives each job a send id, the same on every run of the job. */
export type SendJob = {
  runId: string;
  sendId?: string;
  step?: string;
  idx?: number;
};

/** The key a job's send is saved under. A job without a send id (made by hand, or queued before send ids existed) is
 *  keyed by its run's step instead. */
export const sendKey = (kind: string, job: SendJob) =>
  `${kind}:${job.runId}:${job.sendId ?? `${job.step}:${job.idx}`}`;

/** Saves `send` as about to be sent. When its key was saved before, saves nothing and says what became of that send. */
export async function saveSend(
  tx: PoolClient,
  orgId: string,
  send: Send,
): Promise<{ status: SendStatus; providerRef: string | null } | undefined> {
  const saved = await tx.query(
    `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (org_id, send_key) do nothing`,
    [
      orgId,
      send.key,
      send.channel,
      send.contactId,
      send.runId,
      JSON.stringify(send.payload),
    ],
  );
  if (saved.rowCount) return;
  const earlier = await tx.query<{
    status: SendStatus;
    provider_ref: string | null;
  }>(
    `select status, provider_ref from sends where org_id = $1 and send_key = $2`,
    [orgId, send.key],
  );
  const row = earlier.rows[0];
  return row && { status: row.status, providerRef: row.provider_ref };
}

/** Saves what became of a send: `sent` with the provider's id for it, or `blocked` with the guardrail that refused it. */
export async function settleSend(
  tx: PoolClient,
  orgId: string,
  key: string,
  outcome: { sent: string } | { blocked: string },
): Promise<void> {
  await tx.query(
    `update sends set status = $3, provider_ref = $4, reason = $5, updated_at = now()
      where org_id = $1 and send_key = $2`,
    "sent" in outcome
      ? [orgId, key, "sent", outcome.sent, null]
      : [orgId, key, "blocked", null, outcome.blocked],
  );
}

const TITLES: Record<Send["channel"], string> = {
  voice: "Check whether this call went out before calling again",
  whatsapp: "Check whether this WhatsApp message went out before sending again",
};

/**
 * The provider may have taken `send`, but its answer was never saved: never send again. Marks the send unknown and
 * hands the lead to a person (a review task on the lead and its run, saying why). Returns the reason it saved.
 */
export async function handOver(
  tx: PoolClient,
  orgId: string,
  send: Send,
  why: unknown,
): Promise<string> {
  const reason =
    `could not tell whether the provider took it: ${why instanceof Error ? why.message : String(why)}`.slice(
      0,
      500,
    );
  await tx.query(
    `update sends set status = 'unknown', reason = $3, updated_at = now()
      where org_id = $1 and send_key = $2`,
    [orgId, send.key, reason],
  );
  await tx.query(
    `insert into tasks (org_id, contact_id, workflow_run_id, kind, title, payload)
     values ($1, $2, $3, 'review', $4, $5::jsonb)`,
    [
      orgId,
      send.contactId,
      send.runId,
      TITLES[send.channel],
      JSON.stringify({ reason, sendKey: send.key, channel: send.channel }),
    ],
  );
  return reason;
}
