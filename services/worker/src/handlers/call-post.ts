// The call.post handler: the dead-letter SINK for a call or WhatsApp job that failed every try its queue allows. In
// ONE withOrg(orgId) tx it hands the lead to a person, by what the job saved of its send (src/sends.ts):
//   - saved and still waiting for the provider's answer: it may have reached the provider, so it is handed over as
//     unknown, never sent again;
//   - saved as sent: the provider took it, but what follows (a call's outcome, a message's record) kept failing: a
//     review task says so, so nobody sends it again;
//   - saved as blocked, or handed over already: nothing more;
//   - never saved: the job failed before it reached the provider: a review task, and the failure on the run.
// A call's run, which waits on the call and can't route without its result, is parked as failed in the last two. Each
// task is made by createTask, with its audit row, once per failed job however often the sink is handed it; a run the
// company doesn't have gets none.
// A partial or malformed payload resolves without throwing; a database failure throws, so this queue retries it.
import { createTask, withOrg } from "@revenue-os/db";
import { OrgIdSchema } from "@revenue-os/shared";
import type { Pool, PoolClient } from "pg";
import { findSend, handOver, type Send, type SendJob, sendKey } from "../sends";

export type CallPostDeps = {
  pool: Pool;
  now?: () => Date;
};

/** A failed/exhausted job's payload as pg-boss hands it to the dead-letter handler: the original job's data, whose
 *  ids may be partial. Everything is optional on purpose — the handler must survive a malformed payload. */
export type CallPostJob = Partial<SendJob> & {
  orgId: string;
  action?: { kind: string; contactId?: string };
  error?: string;
};

export async function handleCallPost(
  deps: CallPostDeps,
  job: CallPostJob,
): Promise<void> {
  const { orgId, runId } = job;
  // malformed payload — resolve without throwing (the sink can't crash)
  if (!runId || !OrgIdSchema.safeParse(orgId).success) return;
  const send = sendOf(job, runId);

  await withOrg(deps.pool, orgId, async (tx) => {
    const saved = send && (await findSend(tx, orgId, send.key));
    if (send && saved?.status === "sending") {
      await handOver(tx, orgId, send, new Error(EXHAUSTED));
      return;
    }
    if (saved && saved.status !== "sent") return; // blocked, or handed over already
    await recordFailure(tx, job, runId, saved);
  });
}

/** The send the failed job saved, as its handler named it, when its payload names the lead. */
function sendOf(job: CallPostJob, runId: string): Send | undefined {
  const { action } = job;
  if (!action?.contactId) return;
  return {
    key: sendKey(action.kind, { ...job, runId }),
    channel: action.kind === "send_wa" ? "whatsapp" : "voice",
    contactId: action.contactId,
    runId,
    payload: {},
  };
}

/** Records the failure on the run, parking a call's run, and gives a person a review task on the run's lead. */
async function recordFailure(
  tx: PoolClient,
  job: CallPostJob,
  runId: string,
  saved: { providerRef: string | null } | undefined,
): Promise<void> {
  const { orgId, error, action } = job;
  const call = action?.kind !== "send_wa";
  const went = saved ? "went" : "not";
  const run = await tx.query(
    `update workflow_runs
        set last_error = $2, updated_at = now(),
            status = case when $4::boolean and status = 'waiting' then 'failed' else status end
      where id = $1 and org_id = $3
      returning contact_id`,
    [runId, error ?? FAILED[went], orgId, call],
  );
  const contactId = run.rows[0]?.contact_id;
  if (typeof contactId !== "string") return; // not this company's run, or gone
  await createTask(tx, orgId, {
    contactId,
    workflowRunId: runId,
    kind: "review",
    title: TITLES[`${call ? "call" : "message"} ${went}` as const],
    payload: {
      error: error ?? null,
      action: action ?? null,
      providerRef: saved?.providerRef ?? null,
    },
    actor: { type: "system" },
    once: `call.post:${sendKey(action?.kind ?? "job", { ...job, runId })}`, // the same failed job handed over again
  });
}

/** Why the sink hands a lead over: the job saved its send, then failed every try before it saved the answer. */
const EXHAUSTED =
  "its job saved the send, then failed every try before it saved the provider's answer";
const FAILED = {
  went: "the provider took the send, then its job failed every try",
  not: "its job failed every try before the send was saved",
};
const TITLES: Record<`${"call" | "message"} ${"went" | "not"}`, string> = {
  "call went": "This call went out, but its result was never recorded",
  "message went": "This WhatsApp message went out, but it was never recorded",
  "call not": "Call failed — needs review",
  "message not": "WhatsApp message failed — needs review",
};
