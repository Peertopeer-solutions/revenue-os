// What becomes of a lead whose call can't go ahead, or whose call's result never comes: its sequence never just stops.
// A cause that passes (outside the calling hours) has the call tried again later; a lasting one (do-not-call, the
// company's call limit, no active agent, no number) ends the run as failed and hands the lead to a person, the reason
// saved on the run and in a review task. A run waits CALL_RESULT_WAIT_MS for its call's result; the scheduler then
// picks it up again (pickUpCall) and never places the call twice. The choices are in docs/decisions-in-force/.
import { createTask } from "@revenue-os/db";
import type { PoolClient } from "pg";
import { findSend, handOver, type Send, sendKey } from "./sends";

/** The call and WhatsApp jobs' dead-letter queue (jobs.ts drains it with handleCallPost). */
export const CALL_POST_QUEUE = "call.post";
/** How long a run parked on a call waits for the call's result before the scheduler picks it up again. */
export const CALL_RESULT_WAIT_MS = 60 * 60_000;
/** How long after the calling hours held a call back it is tried again. */
export const HELD_CALL_RETRY_MS = 60 * 60_000;

/** Why a run was handed to a person: saved on the run (`reason`), and the task's title and reason code. */
export type Stop = { reason: string; title: string; code: string };

export const NO_NUMBER: Stop = {
  reason: "no number to call",
  title: "Call not placed — no number to call",
  code: "no_number",
};
export const noAgent = (key: string): Stop => ({
  reason: `no active agent "${key}" to place the call or record its result`,
  title: "Call stopped — no active agent",
  code: "no_agent",
});
const NO_RESULT: Stop = {
  reason: `the call went out, but no result came within ${CALL_RESULT_WAIT_MS / 60_000} minutes`,
  title: "This call went out, but no result came",
  code: "no_result",
};
const NOT_PLACED: Stop = {
  reason: "its call job ended without placing the call",
  title: "Call not placed — its job stopped",
  code: "job_stopped",
};
const REFUSED: Record<string, string> = {
  dnc: "the lead is on the do-not-call list",
  attempt_cap: "the lead has had the most calls the company allows for now",
};
const refused = (code: string): Stop => ({
  reason: `the guardrails refused the call: ${REFUSED[code] ?? code}`,
  title: `Call not placed — ${REFUSED[code] ?? `refused (${code})`}`,
  code,
});

/**
 * Ends the run of `send`'s call and hands its lead to a person: the run is failed with the reason saved, and one review
 * task on the lead and run says why, however often a job asks. The caller holds the run locked.
 */
export async function handToPerson(
  tx: PoolClient,
  orgId: string,
  send: Send,
  stop: Stop,
): Promise<void> {
  await endRun(tx, orgId, send.runId, stop.reason);
  await createTask(tx, orgId, {
    contactId: send.contactId,
    workflowRunId: send.runId,
    kind: "review",
    title: stop.title,
    payload: { reason: stop.code, sendKey: send.key },
    actor: { type: "system" },
    once: `${send.key}:stopped`,
  });
}

/** Fails a run that is still pending or waiting, saving why. */
export async function endRun(
  tx: PoolClient,
  orgId: string,
  runId: string,
  reason: string,
): Promise<void> {
  await tx.query(
    `update workflow_runs set status = 'failed', last_error = $2, updated_at = now()
      where id = $1 and org_id = $3 and status in ('pending', 'waiting')`,
    [runId, reason, orgId],
  );
}

/**
 * A call the guardrails held back, for the reason its send saved. Outside the calling hours it is tried again
 * HELD_CALL_RETRY_MS later: the run waits on the same call step, no longer names this call, and gives back the call
 * attempt the scheduler counted for it, as the lead was never rung. Any other reason hands the lead to a person. The
 * caller holds the run locked, still waiting for this call.
 */
export async function callHeldBack(
  tx: PoolClient,
  orgId: string,
  send: Send,
  reason: string | null,
  now: Date,
): Promise<void> {
  if (reason !== "quiet_hours")
    return handToPerson(tx, orgId, send, refused(reason ?? "unknown"));
  const at = new Date(now.getTime() + HELD_CALL_RETRY_MS);
  await tx.query(
    `update workflow_runs
        set wake_at = $2, state = state - 'callSendId', last_error = $3, updated_at = now(),
            attempts = case when jsonb_typeof(attempts -> 'voice') = 'array'
                            then jsonb_set(attempts, '{voice}', (attempts -> 'voice') - -1) else attempts end
      where id = $1 and org_id = $4`,
    [
      send.runId,
      at,
      `call held back: outside the calling hours, tried again at ${at.toISOString()}`,
      orgId,
    ],
  );
}

/** A run parked on a call, as the scheduler holds it locked. */
type WaitingRun = {
  id: string;
  contact_id: string;
  state: Record<string, unknown> | null;
};

/**
 * The scheduler's pickup of a run whose call's time is up (CALL_RESULT_WAIT_MS). It never places the call again.
 * While the call's job, or its dead letter, is still queued, retrying or running, the run waits again. Otherwise it
 * goes on from what the job saved of its call: the call's result, to fold, once the call's own events finished it; or
 * the lead handed to a person (no result came, the dialer's answer was never saved, or the call was never placed); or,
 * for a call the guardrails held back, what callHeldBack does. The result to fold, or nothing.
 */
export async function pickUpCall(
  tx: PoolClient,
  orgId: string,
  run: WaitingRun,
  sendId: string,
  now: Date,
): Promise<string | undefined> {
  const live = await tx.query(
    `select 1 from pgboss.job_common
      where name in ('place_call', $1) and state in ('created', 'retry', 'active') and data @> $2::jsonb
      limit 1`,
    [CALL_POST_QUEUE, JSON.stringify({ orgId, runId: run.id, sendId })],
  );
  if (live.rowCount) {
    await tx.query(
      `update workflow_runs set wake_at = $2, updated_at = now() where id = $1 and org_id = $3`,
      [run.id, new Date(now.getTime() + CALL_RESULT_WAIT_MS), orgId],
    );
    return;
  }
  const send: Send = {
    key: sendKey("place_call", { runId: run.id, sendId }),
    channel: "voice",
    contactId: run.contact_id,
    runId: run.id,
    payload: {},
  };
  const saved = await findSend(tx, orgId, send.key);
  if (saved?.status === "sending") {
    await handOver(tx, orgId, send, new Error(NO_ANSWER));
    return;
  }
  if (saved?.status === "blocked") {
    await callHeldBack(tx, orgId, send, saved.reason, now);
    return;
  }
  const result = saved?.providerRef
    ? await callResult(tx, orgId, saved.providerRef)
    : undefined;
  if (result) return result;
  await handToPerson(tx, orgId, send, saved ? NO_RESULT : NOT_PLACED);
}

/** Why the pickup hands a call over whose dialer's answer was never saved. */
const NO_ANSWER =
  "its job saved the call, then neither it nor its dead letter saved the dialer's answer";

/** How a call that ended unanswered routes, as the call step's technical outcomes name it. */
const ENDED_AS: Record<string, string> = {
  voicemail: "no_answer",
  canceled: "failed",
};

/** The result of the call the dialer took as `providerRef`, once its own events finished its conversation: the
 *  outcome they gave, else how it ended. */
async function callResult(
  tx: PoolClient,
  orgId: string,
  providerRef: string,
): Promise<string | undefined> {
  const r = await tx.query<{ status: string; outcome: string | null }>(
    `select c.status, d.key as outcome from conversations c
       left join dispositions d on d.org_id = $1 and d.id = c.disposition_id
      where c.org_id = $1 and c.provider = 'vapi' and c.provider_ref = $2
        and c.status not in ('queued', 'ringing', 'active')`,
    [orgId, providerRef],
  );
  const row = r.rows[0];
  return row && (row.outcome ?? ENDED_AS[row.status] ?? row.status);
}
