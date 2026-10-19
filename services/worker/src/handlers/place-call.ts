// The place_call job handler. A call is never blindly repeated: the job may run twice (delivered twice, or run again
// after it failed), but it dials at most once, and no database transaction is open while the dialer answers. Every
// query also filters by the job's company (the run's sequence and the call's agent may be shared templates).
//   1. In one short transaction: reload the run FOR UPDATE and NO-OP if stale (it no longer waits for this job's
//      call: an outcome is folded, status != 'waiting', current_step is no longer a call step, or the run is not the
//      one this job's call was queued for), look up this job's saved call, and load the active agent and the lead's
//      number. A call saved before means this job ran before: never dial again — go on from its saved answer, or hand
//      the lead to a person when none was saved.
//   2. Send the call at most once (src/sends.ts sendOnce): guard() BEFORE the dial, through the channels voice
//      doorway (voice.place), the call saved with the guard's verdict; the dial with no transaction open; its answer
//      saved. A blocking verdict => no dial. A dial that throws may still have placed the call, so the lead is handed
//      to a person and the run parked as failed instead.
//   3. Record the call's conversation (provider vapi, provider_ref), drive it via runTurn(injected provider) so
//      messages + usage land, resolve the call OUTCOME via the injected `outcome` port, FOLD it into
//      state.lastDisposition, and RE-ARM (status waiting, wake_at now, current_step UNCHANGED) so the next tick
//      routes it.
// @revenue-os/channels is an internal workspace dep (no BOM row, like @revenue-os/harness).

import type { ToolRegistry } from "@harness/registry";
import type {
  GuardedAction,
  LlmProvider,
  OrgCtx,
  Verdict,
} from "@harness/types";
import { voice } from "@revenue-os/channels";
import { createTask, leadNumber, withOrg } from "@revenue-os/db";
import { runTurn } from "@revenue-os/harness";
import type { Pool, PoolClient } from "pg";
import {
  findSend,
  handOver,
  type Send,
  type SendJob,
  sendKey,
  sendOnce,
} from "../sends";

/** Voice sender port — a structural superset of channels' VoiceSender (kept local so the type
 *  surface needs no channels dep). The handler passes the injected sender into voice.place. */
export type VoiceSenderPort = {
  place(payload: {
    to: string;
    assistantId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ providerRef: string }>;
};

/** The guard the doorway MUST call before any send (guardrails run before every send). Test injects a spy. */
export type GuardPort = (
  ctx: OrgCtx,
  action: GuardedAction,
) => Promise<Verdict>;

/** DESIGN DECISION (disposition flow): a "disposition port" — how the call OUTCOME reaches the
 *  handler (vs extending the voice result, or a call.post hop). Tests inject the fake voice provider
 *  (test/fixtures/fake-channels.ts), which resolves the scripted outcome; the worker still wires a
 *  stub that throws (jobs.ts OUTCOME_STUB, listed as a stub in STATE.md). */
export type OutcomePort = (
  ctx: OrgCtx,
  conversationId: string,
) => Promise<string>;

export type PlaceCallDeps = {
  pool: Pool;
  guard: GuardPort;
  sender: VoiceSenderPort;
  provider: LlmProvider; // the runTurn bridge's LLM (tests inject a scripted one)
  registry: ToolRegistry; // runTurn's tool catalog (empty is fine for a text-only turn)
  outcome: OutcomePort;
  now?: () => Date;
};

export type PlaceCallJob = SendJob & {
  orgId: string;
  action: { kind: "place_call"; contactId: string; agentKey: string };
};

/** The run's state; callSendId names the call job whose call it waits for (src/scheduler.ts). */
type RunState = { lastDisposition?: string; callSendId?: string } & Record<
  string,
  unknown
>;
type Agent = {
  id: string;
  system_prompt: string | null;
  tools_allowed: string[] | null;
};

export async function handlePlaceCall(
  deps: PlaceCallDeps,
  job: PlaceCallJob,
): Promise<void> {
  const { orgId, runId, action } = job;

  // 1. reload (the stale checks NO-OP before the guard) and look up this job's saved call.
  const claim = await withOrg(deps.pool, orgId, async (tx) => {
    if (!(await waitingForCall(tx, job))) return;
    const to = await leadNumber(tx, orgId, action.contactId, "voice");
    const send: Send = {
      key: sendKey("place_call", job),
      channel: "voice",
      contactId: action.contactId,
      runId,
      payload: { to },
    };
    const earlier = await findSend(tx, orgId, send.key);
    // dialled before with no answer saved: hand over (once), whatever has happened to the agent since
    if (earlier?.status === "sending")
      return {
        handedOver: await handOver(tx, orgId, send, new Error(UNANSWERED)),
      };
    const agent = (
      await tx.query(
        `select id, system_prompt, tools_allowed from agents
          where key = $1 and status = 'active' and (org_id = $2 or org_id is null)
          order by version desc limit 1`,
        [action.agentKey, orgId],
      )
    ).rows[0] as Agent | undefined;
    if (!agent) return; // no active agent to place the call, or to drive its turn
    if (!earlier && !to) {
      // No number to call (none on file, or the lead was deleted or merged): nothing is placed, the reason is saved
      // and a person is handed the lead, never a silent stop.
      await tx.query(
        `update workflow_runs set last_error = $2, updated_at = now() where id = $1 and org_id = $3`,
        [runId, "no number to call", orgId],
      );
      await createTask(tx, orgId, {
        contactId: action.contactId,
        workflowRunId: runId,
        kind: "review",
        title: "Call not placed — no number to call",
        payload: { reason: "no_number" },
        actor: { type: "system" },
        once: `${send.key}:no-number`,
      });
    }
    return { agent, to, send, earlier };
  });
  if (!claim || "handedOver" in claim) return;
  const { agent, to, send, earlier } = claim;
  if (earlier?.status === "sent" && earlier.providerRef)
    return fold(deps, job, agent, earlier.providerRef); // dialled before; its outcome is still to fold
  if (earlier || !to) return; // blocked or already handed over; or no number, handed to a person above

  // 2. guard BEFORE the dial; the call is saved with the guard's verdict, then dialled with no transaction open.
  const placed = await sendOnce(deps.pool, orgId, send, deps.guard, (guard) =>
    voice.place(
      { sender: deps.sender, guard },
      { orgId },
      {
        contactId: action.contactId,
        autonomy: "auto",
        toolName: "place_call",
        payload: { to },
      },
    ),
  );
  if (placed && "sent" in placed) await fold(deps, job, agent, placed.sent);
  // blocked → no dial, no conversation, no fold; handed over, or another run of the job dials: nothing more
}

/** Why a run of the job hands the lead over when an earlier run saved the call but not the dialer's answer. */
const UNANSWERED =
  "an earlier run of this job saved the call but not the dialer's answer";

/** 3. record the call's conversation, drive its turn, then FOLD the outcome and RE-ARM (the next tick routes). */
async function fold(
  deps: PlaceCallDeps,
  job: PlaceCallJob,
  agent: Agent,
  providerRef: string,
): Promise<void> {
  const { orgId, runId, action } = job;
  const now = deps.now?.() ?? new Date();
  await withOrg(deps.pool, orgId, async (tx) => {
    // The call's conversation, keyed by the dialer's call id as the call's own events file it (src/vapi/process.ts),
    // so whichever of the two comes first makes it, and this fills in its lead, run and agent.
    const conversationId = (
      await tx.query(
        `insert into conversations
           (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status, provider, provider_ref)
         values ($1, $2, $3, $4, 'voice', 'outbound', 'active', 'vapi', $5)
         on conflict (org_id, provider, provider_ref) where provider_ref is not null
         do update set contact_id = excluded.contact_id, workflow_run_id = excluded.workflow_run_id,
                       agent_id = excluded.agent_id, direction = excluded.direction
         returning id`,
        [orgId, action.contactId, runId, agent.id, providerRef],
      )
    ).rows[0]?.id as string;
    const state = await waitingForCall(tx, job);
    if (!state) return; // folded by an earlier run of this job, or handed to a person
    const ctx: OrgCtx = { orgId, db: tx };
    await runTurn(
      {
        provider: deps.provider,
        registry: deps.registry,
        toolsAllowed: agent.tools_allowed ?? [],
        systemPrompt: agent.system_prompt ?? "",
      },
      ctx,
      conversationId,
    );
    const disposition = await deps.outcome(ctx, conversationId);
    await tx.query(
      `update workflow_runs
          set state = $2::jsonb, status = 'waiting', wake_at = $3, updated_at = now()
        where id = $1 and org_id = $4`,
      [
        runId,
        JSON.stringify({ ...state, lastDisposition: disposition }),
        now,
        orgId,
      ],
    );
  });
}

/**
 * The run, locked, while it still waits for this job's call: status waiting, no outcome folded, on a call step, and,
 * for a job the scheduler queued, on the step it was queued for, with the run's state naming its send id (the
 * scheduler writes it as it parks the run, src/scheduler.ts). So a late run of an older call job never folds its old
 * outcome into a later wait, a later call or the same step visited again. Its state, or nothing.
 */
async function waitingForCall(
  tx: PoolClient,
  { orgId, runId, sendId, step }: PlaceCallJob,
): Promise<RunState | undefined> {
  const run = (
    await tx.query(
      `select workflow_id, current_step, status, state
         from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    )
  ).rows[0];
  const state = (run?.state ?? {}) as RunState;
  if (run?.status !== "waiting" || state.lastDisposition != null) return; // RLS-hidden (cross-tenant) or gone, already advanced, or the outcome is folded (re-delivery)
  if (sendId && state.callSendId !== sendId) return; // the run waits for another call job's call, or none
  if (step !== undefined && step !== run.current_step) return; // the run has moved on to another step
  const def = (
    await tx.query(
      `select definition from workflows where id = $1 and (org_id = $2 or org_id is null)`,
      [run.workflow_id, orgId],
    )
  ).rows[0]?.definition as
    | { steps?: Record<string, { kind?: string } | undefined> }
    | undefined;
  return def?.steps?.[run.current_step as string]?.kind === "call"
    ? state
    : undefined;
}
