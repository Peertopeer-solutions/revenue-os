// The worker's record of each call and WhatsApp message it sends (the sends table, migration 021), and the one way a
// job handler sends: at most once. A job can run twice: delivered twice, or run again after it failed once the
// provider had already taken the send. So the send is saved before the provider is called, under a key that is the
// same however often its job runs, and a run that finds the key saved never sends again: it goes on from the saved
// answer or, when none was saved, hands the lead to a person
// (docs/decisions-in-force/2026-09-25-scheduler-database-error-policy.md).
import type { GuardedAction, OrgCtx, Verdict } from "@harness/types";
import type { DoorwayResult, GuardFn } from "@revenue-os/channels";
import { withOrg } from "@revenue-os/db";
import type { Pool, PoolClient } from "pg";

export type SendStatus = "sending" | "sent" | "blocked" | "unknown";

/** One send, as a job handler saves it before the provider is called. */
export type Send = {
  key: string;
  channel: "voice" | "whatsapp";
  contactId: string;
  runId: string;
  payload: object; // what is about to be sent: the number, a template and its values
};

/** What a job carries to name its send: the scheduler gives each job a send id, the same on every run of the job. */
export type SendJob = {
  runId: string;
  sendId?: string;
  step?: string;
  idx?: number;
};

/** The key a job's send is saved under. A job without a send id (queued before send ids existed, or built by hand
 *  in a test) is keyed by its run's step and position instead; the dead-letter sink keys it the same way. */
export const sendKey = (kind: string, job: SendJob) =>
  `${kind}:${job.runId}:${job.sendId ?? `${job.step}:${job.idx}`}`;

/** What became of the send saved under `key`, if one was. */
export async function findSend(
  tx: PoolClient,
  orgId: string,
  key: string,
): Promise<{ status: SendStatus; providerRef: string | null } | undefined> {
  const r = await tx.query<{
    status: SendStatus;
    provider_ref: string | null;
  }>(
    `select status, provider_ref from sends where org_id = $1 and send_key = $2`,
    [orgId, key],
  );
  const row = r.rows[0];
  return row && { status: row.status, providerRef: row.provider_ref };
}

/** The guardrail check every send passes, given its database by sendOnce (the handlers' GuardPort). */
type GuardPort = (ctx: OrgCtx, action: GuardedAction) => Promise<Verdict>;

/** Another run of the same job saved this send between this run's look and its own save: that run sends, not this. */
class SavedMeanwhile extends Error {}

/**
 * Sends `send` through `through` (a channel doorway, which runs the guardrail check before the provider) at most
 * once, and says what became of it: sent (the provider's id for it), blocked (the guardrail's reason), or nothing
 * (handed to a person, or sent by another run of the job). The check and the saving of the send share one short
 * transaction, so a failure before the provider is called saves and sends nothing, and the error goes back to the
 * job's queue, which may run it again. Once saved, the provider is called with no transaction open; a call that
 * throws may still have reached the provider, so the lead is handed to a person instead of sending again; the
 * provider's answer is saved on its own, so nothing that follows can undo it.
 */
export async function sendOnce(
  pool: Pool,
  orgId: string,
  send: Send,
  guard: GuardPort,
  through: (guard: GuardFn) => Promise<DoorwayResult>,
): Promise<{ sent: string } | { blocked: string } | undefined> {
  let saved = false;
  let answer: DoorwayResult;
  try {
    answer = await through(async (_ctx, action) => {
      const verdict = await withOrg(pool, orgId, async (tx) => {
        const v = await guard({ orgId, db: tx }, action);
        const blocked = v.ok ? null : v.reason;
        if (!(await saveSend(tx, orgId, send, blocked)))
          throw new SavedMeanwhile();
        return v;
      });
      saved = true;
      return verdict;
    });
  } catch (err) {
    if (err instanceof SavedMeanwhile) return;
    if (!saved) throw err; // nothing was saved, nothing sent: the job may run again
    await withOrg(pool, orgId, (tx) => handOver(tx, orgId, send, err));
    return;
  }
  if (!answer.ok) return { blocked: answer.reason };
  const { providerRef } = answer.result;
  await withOrg(pool, orgId, (tx) =>
    tx.query(
      `update sends set status = 'sent', provider_ref = $3, updated_at = now()
        where org_id = $1 and send_key = $2 and status in ('sending', 'unknown')`,
      [orgId, send.key, providerRef],
    ),
  );
  return { sent: providerRef };
}

/** Saves `send`, about to go out or blocked with the guardrail's reason. False when its key is saved already. */
async function saveSend(
  tx: PoolClient,
  orgId: string,
  send: Send,
  blocked: string | null,
): Promise<boolean> {
  const r = await tx.query(
    `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, payload, status, reason)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     on conflict (org_id, send_key) do nothing`,
    [
      orgId,
      send.key,
      send.channel,
      send.contactId,
      send.runId,
      JSON.stringify(send.payload),
      blocked ? "blocked" : "sending",
      blocked,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

const TITLES: Record<Send["channel"], string> = {
  voice: "Check whether this call went out before calling again",
  whatsapp: "Check whether this WhatsApp message went out before sending again",
};

/**
 * The provider may have taken `send`, but its answer was never saved: never send again. A send still `sending` is
 * marked unknown and its lead handed to a person (a review task on the lead and its run, saying why); a call's run is
 * parked as failed too, as it can't route a call whose result is unknown. A send whose answer was saved meanwhile, or
 * that was handed over already, is left as it is. Says whether it handed the lead over.
 */
export async function handOver(
  tx: PoolClient,
  orgId: string,
  send: Send,
  why: unknown,
): Promise<boolean> {
  const reason =
    `could not tell whether the provider took it: ${why instanceof Error ? why.message : String(why)}`.slice(
      0,
      500,
    );
  const changed = await tx.query(
    `update sends set status = 'unknown', reason = $3, updated_at = now()
      where org_id = $1 and send_key = $2 and status = 'sending'`,
    [orgId, send.key, reason],
  );
  if (!changed.rowCount) return false;
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
  if (send.channel === "voice")
    await tx.query(
      `update workflow_runs set status = 'failed', last_error = $2, updated_at = now()
        where id = $1 and org_id = $3 and status = 'waiting'`,
      [send.runId, reason, orgId],
    );
  return true;
}
