// The place_call job handler. In ONE withOrg(orgId) tx, with every query also filtered by the job's company
// (the run's sequence and the call's agent may be shared templates):
//   1. reload the run FOR UPDATE; NO-OP if stale (state.lastDisposition already folded, status
//      != 'waiting', or current_step no longer a call step) — exactly-once, BEFORE the guard.
//   2. guard() BEFORE the send (guardrails run before every send) via the channels voice doorway
//      (voice.place). A blocking verdict => NO send, no conversation, return.
//   3. record a `conversations` row (channel voice, provider vapi, provider_ref = sender result).
//   4. drive the call's conversation via runTurn(injected provider) so messages + usage land.
//   5. resolve the call OUTCOME via the injected `outcome` port, FOLD it into state.lastDisposition,
//      and RE-ARM (status waiting, wake_at now, current_step UNCHANGED) so the next tick routes it.
// @revenue-os/channels is an internal workspace dep (no BOM row, like @revenue-os/harness).

import type { ToolRegistry } from "@harness/registry";
import type {
  GuardedAction,
  LlmProvider,
  OrgCtx,
  Verdict,
} from "@harness/types";
import { voice } from "@revenue-os/channels";
import { leadNumber, withOrg } from "@revenue-os/db";
import { runTurn } from "@revenue-os/harness";
import type { Pool } from "pg";

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

export type PlaceCallJob = {
  orgId: string;
  runId: string;
  action: { kind: "place_call"; contactId: string; agentKey: string };
};

type RunState = { lastDisposition?: string } & Record<string, unknown>;

export async function handlePlaceCall(
  deps: PlaceCallDeps,
  job: PlaceCallJob,
): Promise<void> {
  const { orgId, runId, action } = job;
  const now = deps.now?.() ?? new Date();

  await withOrg(deps.pool, orgId, async (tx) => {
    const ctx: OrgCtx = { orgId, db: tx };

    // 1. reload FOR UPDATE; the stale checks NO-OP before the guard (exactly-once).
    const reload = await tx.query(
      `select workflow_id, current_step, status, state
         from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    );
    const run = reload.rows[0];
    if (!run) return; // RLS-hidden (cross-tenant) or gone
    const state = (run.state ?? {}) as RunState;
    if (run.status !== "waiting") return; // already advanced past the parked call
    if (state.lastDisposition != null) return; // outcome already folded (re-delivery)
    const def = (
      await tx.query(
        `select definition from workflows where id = $1 and (org_id = $2 or org_id is null)`,
        [run.workflow_id, orgId],
      )
    ).rows[0]?.definition as
      | { steps?: Record<string, { kind?: string } | undefined> }
      | undefined;
    if (def?.steps?.[run.current_step as string]?.kind !== "call") return;

    // 2. load the run's active agent (place_call carries the agent key).
    const agent = (
      await tx.query(
        `select id, system_prompt, tools_allowed from agents
          where key = $1 and status = 'active' and (org_id = $2 or org_id is null)
          order by version desc limit 1`,
        [action.agentKey, orgId],
      )
    ).rows[0];
    if (!agent) return; // no active agent to place the call

    // 3. guard BEFORE the send — a blocking verdict returns before any effect.
    const to = await leadNumber(tx, orgId, action.contactId, "voice");
    if (!to) return; // no number to call: nothing is placed
    const doorway = await voice.place(
      { sender: deps.sender, guard: deps.guard },
      ctx,
      {
        contactId: action.contactId,
        autonomy: "auto",
        toolName: "place_call",
        payload: { to },
      },
    );
    if (!doorway.ok) return; // blocked → no send, no conversation, no fold

    // 4. record the voice conversation carrying the provider ref.
    const convo = await tx.query(
      `insert into conversations
         (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status, provider, provider_ref)
       values ($1, $2, $3, $4, 'voice', 'outbound', 'active', 'vapi', $5) returning id`,
      [orgId, action.contactId, runId, agent.id, doorway.result.providerRef],
    );
    const conversationId = convo.rows[0]?.id as string;

    // 5. drive the call's turn — transcript + usage land through the runTurn bridge.
    await runTurn(
      {
        provider: deps.provider,
        registry: deps.registry,
        toolsAllowed: (agent.tools_allowed as string[] | null) ?? [],
        systemPrompt: (agent.system_prompt as string | null) ?? "",
      },
      ctx,
      conversationId,
    );

    // 6. resolve + FOLD the outcome, then RE-ARM (current_step UNCHANGED — the next tick routes).
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
