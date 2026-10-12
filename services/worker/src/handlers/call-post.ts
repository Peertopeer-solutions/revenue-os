// The call.post handler: the dead-letter SINK for a failed / retry-exhausted call
// job. In ONE withOrg(orgId) tx it records the failure (workflow_runs.last_error + a `review`
// task on the run) so a human can act — and NEVER throws (a poisoned payload, a missing id, or a
// DB error must not crash the queue; the sink is the last line of defense).
import { withOrg } from "@revenue-os/db";
import type { Pool } from "pg";
import { logger } from "../logger";

export type CallPostDeps = {
  pool: Pool;
  now?: () => Date;
};

/** A failed/exhausted job's payload as pg-boss hands it to the dead-letter handler: the original
 *  ids may be partial and `error` carries the failure reason. Everything is optional on purpose —
 *  the handler must survive a malformed payload without throwing. */
export type CallPostJob = {
  orgId: string;
  runId?: string;
  action?: { kind: string };
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
      await tx.query(
        `update workflow_runs set last_error = $2, updated_at = now() where id = $1 and org_id = $3`,
        [runId, error ?? "call job failed", orgId],
      );
      await tx.query(
        `insert into tasks (org_id, workflow_run_id, kind, title, payload)
         values ($1, $2, 'review', 'Call failed — needs review', $3::jsonb)`,
        [
          orgId,
          runId,
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
