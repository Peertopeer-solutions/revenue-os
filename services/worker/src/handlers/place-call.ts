// The place_call job handler. A call is never blindly repeated: the job may run twice (delivered twice, or run again
// after it failed), but it dials at most once, and no database transaction is open while the dialer answers. Every
// query also filters by the job's company (the run's sequence and the call's agent may be shared templates).
//   1. In one short transaction: reload the run FOR UPDATE and NO-OP if stale (it no longer waits for this call: an
//      outcome is folded, status != 'waiting', or current_step is no longer a call step), load the active agent and
//      the lead's number, and save the call about to be placed (src/sends.ts). A send saved before means this job ran
//      before: never dial again — go on from its saved answer, or hand the lead to a person when none was saved.
//   2. guard() BEFORE the dial, through the channels voice doorway (voice.place), with the guard in a short
//      transaction of its own. A blocking verdict => no dial; the send is saved as blocked.
//   3. Save the dialer's answer with the call's conversation (provider vapi, provider_ref). A dial that throws may
//      still have placed the call, so the lead is handed to a person and the run parked as failed instead.
//   4. Drive the call's conversation via runTurn(injected provider) so messages + usage land, resolve the call
//      OUTCOME via the injected `outcome` port, FOLD it into state.lastDisposition, and RE-ARM (status waiting,
//      wake_at now, current_step UNCHANGED) so the next tick routes it.
// @revenue-os/channels is an internal workspace dep (no BOM row, like @revenue-os/harness).

import type { ToolRegistry } from "@harness/registry";
import type {
  GuardedAction,
  LlmProvider,
  OrgCtx,
  Verdict,
} from "@harness/types";
import { type DoorwayResult, voice } from "@revenue-os/channels";
import { withOrg } from "@revenue-os/db";
import { runTurn } from "@revenue-os/harness";
import type { Pool, PoolClient } from "pg";
import {
  handOver,
  type Send,
  type SendJob,
  saveSend,
  sendKey,
  settleSend,
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

type RunState = { lastDisposition?: string } & Record<string, unknown>;
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
  const send: Send = {
    key: sendKey("place_call", job),
    channel: "voice",
    contactId: action.contactId,
    runId,
    payload: {},
  };

  // 1. reload (the stale checks NO-OP before the guard) and save the call about to be placed.
  const claim = await withOrg(deps.pool, orgId, async (tx) => {
    if (!(await waitingForCall(tx, orgId, runId))) return;
    const agent = (
      await tx.query(
        `select id, system_prompt, tools_allowed from agents
          where key = $1 and status = 'active' and (org_id = $2 or org_id is null)
          order by version desc limit 1`,
        [action.agentKey, orgId],
      )
    ).rows[0] as Agent | undefined;
    if (!agent) return; // no active agent to place the call
    send.payload = { to: await resolveTo(tx, orgId, action.contactId) };
    return { agent, earlier: await saveSend(tx, orgId, send) };
  });
  if (!claim) return;
  const { agent, earlier } = claim;
  if (earlier?.status === "sent" && earlier.providerRef)
    return fold(deps, job, agent, earlier.providerRef); // dialled before; its outcome is still to fold
  if (earlier) {
    // dialled before with no answer saved: hand over (once); blocked or already handed over: nothing to do
    if (earlier.status === "sending")
      await withOrg(deps.pool, orgId, (tx) =>
        parkForAPerson(tx, orgId, send, new Error(UNANSWERED)),
      );
    return;
  }

  // 2. guard BEFORE the dial, the guard in a short transaction of its own; no transaction is open while it dials.
  let placed: DoorwayResult;
  try {
    placed = await voice.place(
      {
        sender: deps.sender,
        guard: (_ctx, a) =>
          withOrg(deps.pool, orgId, (tx) => deps.guard({ orgId, db: tx }, a)),
      },
      { orgId },
      {
        contactId: action.contactId,
        autonomy: "auto",
        toolName: "place_call",
        payload: { to: send.payload.to as string },
      },
    );
  } catch (err) {
    // the dialer may have placed the call: never dial again; a person checks.
    await withOrg(deps.pool, orgId, (tx) =>
      parkForAPerson(tx, orgId, send, err),
    );
    return;
  }
  if (!placed.ok) {
    const { reason } = placed;
    await withOrg(deps.pool, orgId, (tx) =>
      settleSend(tx, orgId, send.key, { blocked: reason }),
    );
    return; // blocked → no dial, no conversation, no fold
  }

  // 3. save the dialer's answer with the voice conversation carrying the provider ref.
  const { providerRef } = placed.result;
  await withOrg(deps.pool, orgId, async (tx) => {
    await settleSend(tx, orgId, send.key, { sent: providerRef });
    await tx.query(
      `insert into conversations
         (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status, provider, provider_ref)
       values ($1, $2, $3, $4, 'voice', 'outbound', 'active', 'vapi', $5)`,
      [orgId, action.contactId, runId, agent.id, providerRef],
    );
  });
  await fold(deps, job, agent, providerRef);
}

/** Why a run of the job hands the lead over when an earlier run saved the call but not the dialer's answer. */
const UNANSWERED =
  "an earlier run of this job saved the call but not the dialer's answer";

/** 4. drive the call's turn, then FOLD its outcome and RE-ARM (current_step UNCHANGED — the next tick routes). */
async function fold(
  deps: PlaceCallDeps,
  job: PlaceCallJob,
  agent: Agent,
  providerRef: string,
): Promise<void> {
  const { orgId, runId } = job;
  const now = deps.now?.() ?? new Date();
  await withOrg(deps.pool, orgId, async (tx) => {
    const state = await waitingForCall(tx, orgId, runId);
    if (!state) return; // folded by an earlier run of this job, or handed to a person
    const ctx: OrgCtx = { orgId, db: tx };
    const conversationId = (
      await tx.query(
        `select id from conversations where org_id = $1 and provider = 'vapi' and provider_ref = $2`,
        [orgId, providerRef],
      )
    ).rows[0]?.id as string;
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

/** The run, locked, while it still waits for this call (status waiting, no outcome folded, on a call step): its state. */
async function waitingForCall(
  tx: PoolClient,
  orgId: string,
  runId: string,
): Promise<RunState | undefined> {
  const run = (
    await tx.query(
      `select workflow_id, current_step, status, state
         from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    )
  ).rows[0];
  const state = (run?.state ?? {}) as RunState;
  if (!run || run.status !== "waiting" || state.lastDisposition != null)
    return; // RLS-hidden (cross-tenant) or gone, already advanced, or the outcome is folded (re-delivery)
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

/** Hands the lead to a person (src/sends.ts) and parks the run as failed with the reason: it can't route a call
 *  whose result is unknown, and must not dial it again. */
async function parkForAPerson(
  tx: PoolClient,
  orgId: string,
  send: Send,
  why: unknown,
): Promise<void> {
  const reason = await handOver(tx, orgId, send, why);
  await tx.query(
    `update workflow_runs set status = 'failed', last_error = $2, updated_at = now()
      where id = $1 and org_id = $3 and status = 'waiting'`,
    [send.runId, reason, orgId],
  );
}

/** Resolve an E.164 destination for the company's contact (any phone-bearing identity, primary first). */
async function resolveTo(
  tx: PoolClient,
  orgId: string,
  contactId: string,
): Promise<string> {
  const r = await tx.query(
    `select value from contact_identities
      where org_id = $1 and contact_id = $2 and kind in ('phone','whatsapp')
      order by is_primary desc, created_at asc limit 1`,
    [orgId, contactId],
  );
  return (r.rows[0]?.value as string) ?? "";
}
