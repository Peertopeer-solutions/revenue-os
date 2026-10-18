// The call.post handler: the dead-letter SINK for a call or WhatsApp job that failed every try its queue allows. In
// ONE withOrg(orgId) tx it hands the lead to a person — and NEVER throws (a poisoned payload, a missing id, or a DB
// error must not crash the queue; the sink is the last line of defense). A job that saved its send and never saved
// the provider's answer may have reached the provider: that send is handed over as unknown (src/sends.ts), never
// sent again. Any other failed job records the failure (workflow_runs.last_error + a `review` task on the run).
import { withOrg } from "@revenue-os/db";
import type { Pool } from "pg";
import { logger } from "../logger";
import { findSend, handOver, type SendJob, sendKey } from "../sends";

export type CallPostDeps = {
  pool: Pool;
  now?: () => Date;
};

/** A failed/exhausted job's payload as pg-boss hands it to the dead-letter handler: the original
 *  ids may be partial and `error` carries the failure reason. Everything is optional on purpose —
 *  the handler must survive a malformed payload without throwing. */
export type CallPostJob = Partial<SendJob> & {
  orgId: string;
  action?: { kind: string; contactId?: string };
  error?: string;
};

export async function handleCallPost(
  deps: CallPostDeps,
  job: CallPostJob,
): Promise<void> {
  const { orgId, runId, error, action } = job;
  if (!orgId || !runId) return; // malformed payload — resolve without throwing (the sink can't crash)

  try {
    await withOrg(deps.pool, orgId, async (tx) => {
      if (action?.contactId) {
        const send = {
          key: sendKey(action.kind, { ...job, runId }),
          channel: action.kind === "send_wa" ? "whatsapp" : "voice",
          contactId: action.contactId,
          runId,
          payload: {},
        } as const;
        const saved = await findSend(tx, orgId, send.key);
        if (saved?.status === "sending") {
          await handOver(tx, orgId, send, new Error(EXHAUSTED));
          return;
        }
      }
      await tx.query(
        `update workflow_runs set last_error = $2, updated_at = now() where id = $1 and org_id = $3`,
        [runId, error ?? "call job failed", orgId],
      );
      await tx.query(
        `insert into tasks (org_id, workflow_run_id, kind, title, payload)
         values ($1, $2, 'review', $3, $4::jsonb)`,
        [
          orgId,
          runId,
          action?.kind === "send_wa"
            ? "WhatsApp message failed — needs review"
            : "Call failed — needs review",
          JSON.stringify({ error: error ?? null, action: action ?? null }),
        ],
      );
    });
  } catch (err) {
    // last resort: a dead-letter sink NEVER re-throws into the queue.
    logger.error(
      { err, org_id: orgId, run_id: runId },
      "call.post sink failed",
    );
  }
}

/** Why the sink hands a lead over: the job saved its send, then failed every try before saving the answer. */
const EXHAUSTED =
  "its job saved the send, then failed every try before it saved the provider's answer";
