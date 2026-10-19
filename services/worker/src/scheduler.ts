// The scheduler tick. Selects an org's due runs, drives each through the pure interpreter
// (packages/harness), and applies the resulting transitions in ONE per-run tx: external actions
// become pgboss.job rows, inline actions are written in the same tx, then the run row advances.
// Every query on a company table also filters by the org (a run's sequence may be a shared
// template). The clock is a seam: ctx.now decides dueness (the tests' simulated clock,
// test/fixtures/sim-clock.ts, drives it).
//
// Isolation (load-bearing): every run runs in its OWN withOrg tx. A run selected FOR UPDATE
// SKIP LOCKED that another tick holds is skipped, not blocked. A run whose apply hits a DB error
// rolls its whole tx back — enqueue included — and is left 'waiting', never advanced (atomicity).
// A run whose definition dangles (interpret throws) is dead-lettered: status 'failed', last_error
// captured, and the tick keeps going.
import { randomUUID } from "node:crypto";
import { createTask, type TaskKind, withOrg } from "@revenue-os/db";
import {
  type Action,
  interpret,
  type Transition,
  WorkflowDefinitionSchema,
  type WorkflowState,
} from "@revenue-os/harness";
import type { Pool, PoolClient } from "pg";
import { logger } from "./logger";

/** The clock seam: the tests' simulated clock injects `now`; production passes new Date(). */
export type TickCtx = { now: Date };

/** One tick's summary — how many due runs were advanced (or dead-lettered) this tick. */
export type TickResult = { processed: number };

/**
 * External-action queues, one per action kind. The worker (jobs.ts) MUST createQueue()
 * each of these (policy 'short') at startup: enqueueJob below copies each job's settings from its
 * queue's row and refuses a queue that does not exist yet.
 */
export const ACTION_QUEUES = [
  "place_call",
  "send_wa",
  "run_agent_turn",
] as const;

const EXTERNAL = new Set<string>(ACTION_QUEUES);

// ponytail: routing-cycle guard. A definition that loops through 'running' steps (branch→branch)
// would spin forever and hang the tick; cap the in-tick walk and dead-letter past it.
const MAX_STEPS = 64;

// Apply-phase retry ceiling. A rolled-back apply leaves the run 'waiting' with the SAME wake_at,
// so the next tick re-selects it: without a bound a deterministically poisoned run burns a tick
// slot every minute forever and never surfaces to an operator. Failures below the ceiling are
// still RETRIED (docs/decisions-in-force/2026-09-25-scheduler-database-error-policy.md); at it the run
// is dead-lettered.
const MAX_APPLY_FAILURES = 3;
/** attempts key for the apply-failure log. Not a channel — guardrails read 'voice' / 'whatsapp'. */
const APPLY_ERRORS = "apply_errors";

type RunRow = {
  id: string;
  workflow_id: string;
  contact_id: string;
  current_step: string;
  state: Record<string, unknown> | null;
  attempts: unknown;
};

/** Per-channel attempt log: ISO-timestamp arrays (NOT a counter) — guardrails read this. */
type Attempts = Record<string, string[]>;

/**
 * Which orgs have runs due right now — the cron tick's fan-out list, asked BEFORE there is an org
 * to scope to. app_service is RLS-bound, so an unscoped `select distinct org_id from
 * workflow_runs` returns nothing; the answer comes from `app.due_org_ids()` (migration 016), a
 * SECURITY DEFINER function that returns org IDS ONLY and widens no row visibility.
 */
export async function discoverDueOrgs(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ org_id: string }>(
    `select org_id from app.due_org_ids() as org_id`,
  );
  return r.rows.map((row) => row.org_id);
}

/**
 * Select this org's due runs (status waiting/pending, wake_at <= ctx.now) and process each in
 * its own withOrg tx. Returns how many runs were advanced or dead-lettered.
 */
export async function tick(
  pool: Pool,
  orgId: string,
  ctx: TickCtx,
): Promise<TickResult> {
  const { now } = ctx;

  // Enumerate candidate ids (this org's, by RLS and by filter). A plain read is enough: the per-run
  // tx below re-locks each id FOR UPDATE SKIP LOCKED, which is the authoritative concurrency guard.
  const ids = await withOrg(pool, orgId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `select id from workflow_runs
        where org_id = $2 and status in ('pending', 'waiting') and wake_at <= $1
        order by wake_at`,
      [now, orgId],
    );
    return r.rows.map((row) => row.id);
  });

  let processed = 0;
  for (const id of ids) {
    try {
      const did = await withOrg(pool, orgId, (tx) =>
        processRun(tx, orgId, id, now),
      );
      if (did) processed += 1;
    } catch (err) {
      // A DB / inline-apply error: withOrg has already ROLLED BACK this run's tx (enqueue and
      // advance undone; the run stays 'waiting'). One poisoned run must not abort the tick or
      // starve the other due runs — log, count the failure, continue. Interpret throws never
      // reach here; processRun dead-letters those in-tx.
      logger.error(
        { err, org_id: orgId, run_id: id },
        "tick: run apply rolled back",
      );
      await recordApplyFailure(pool, orgId, id, err, now);
    }
  }
  return { processed };
}

/**
 * Lock one due run, drive it through the interpreter, and apply the transitions in `tx`.
 * Returns true if the run was advanced or dead-lettered, false if it was skipped (locked by a
 * concurrent tick, or no longer due). A DB error thrown here propagates so withOrg rolls back.
 */
async function processRun(
  tx: PoolClient,
  orgId: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const locked = await tx.query<RunRow>(
    `select id, workflow_id, contact_id, current_step, state, attempts
       from workflow_runs
      where id = $1 and org_id = $3 and status in ('pending', 'waiting') and wake_at <= $2
      for update skip locked`,
    [id, now, orgId],
  );
  const run = locked.rows[0];
  if (!run) return false; // held by another tick (SKIP LOCKED), or no longer due

  // Phase 1 — PURE. Load + validate the definition and walk the interpreter with NO DB writes.
  // Any throw here (unknown step / dangling ref / bad definition) is permanent: dead-letter the
  // run in THIS tx (nothing else is written yet, so the failed status commits cleanly).
  let walk: {
    steps: { step: string; transition: Transition }[];
    state: WorkflowState;
  };
  try {
    const defRow = await tx.query<{ definition: unknown }>(
      `select definition from workflows where id = $1 and (org_id = $2 or org_id is null)`,
      [run.workflow_id, orgId],
    );
    const wf = defRow.rows[0];
    if (!wf) {
      throw new Error(`workflow not found: ${run.workflow_id}`);
    }
    const def = WorkflowDefinitionSchema.parse(wf.definition);
    walk = drive(def, run, now);
  } catch (err) {
    await tx.query(
      `update workflow_runs
          set status = 'failed', last_error = $2, updated_at = now()
        where id = $1 and org_id = $3`,
      [id, errorMessage(err), orgId],
    );
    return true;
  }

  // Phase 2 — APPLY. Enqueue external actions and write inline actions, then advance the run.
  // A DB error (e.g. a CHECK violation on an inline write) propagates → withOrg rolls the whole
  // tx back, so the enqueue never commits and the run is not advanced (atomicity).
  await applyTransitions(tx, orgId, run, walk.steps, walk.state, now);
  return true;
}

/**
 * Bounded retry for the APPLY phase. The run's own tx is already rolled back, so this runs in its
 * OWN withOrg tx (org-scoped: another tenant's run is invisible here) and is the only write that
 * commits for this run this tick. It appends the failure timestamp to attempts.apply_errors and,
 * at MAX_APPLY_FAILURES, dead-letters the run — 'failed' is outside the selection's
 * `status in ('pending','waiting')`, so a poisoned run stops being re-picked. Never throws: a
 * bookkeeping failure may not abort the tick.
 */
async function recordApplyFailure(
  pool: Pool,
  orgId: string,
  id: string,
  err: unknown,
  now: Date,
): Promise<void> {
  try {
    await withOrg(pool, orgId, async (tx) => {
      // SKIP LOCKED: a concurrent tick holding the run owns its bookkeeping — never block here.
      const locked = await tx.query<{ attempts: unknown }>(
        `select attempts from workflow_runs
          where id = $1 and org_id = $2 and status in ('pending', 'waiting')
          for update skip locked`,
        [id, orgId],
      );
      if (!locked.rows[0]) return; // already terminal, or held by another tick
      const attempts = normalizeAttempts(locked.rows[0].attempts);
      pushAttempt(attempts, APPLY_ERRORS, now.toISOString());
      const failures = attempts[APPLY_ERRORS]?.length ?? 0;
      await tx.query(
        `update workflow_runs
            set attempts = $2::jsonb, last_error = $3,
                status = case when $4::boolean then 'failed' else status end,
                updated_at = now()
          where id = $1 and org_id = $5`,
        [
          id,
          JSON.stringify(attempts),
          errorMessage(err),
          failures >= MAX_APPLY_FAILURES,
          orgId,
        ],
      );
    });
  } catch (bookkeepingErr) {
    logger.error(
      { err: bookkeepingErr, org_id: orgId, run_id: id },
      "tick: apply-failure bookkeeping failed",
    );
  }
}

/**
 * Walk the interpreter from the run's current step, in memory, until it PARKS ('waiting') or
 * ENDS ('completed'). 'running' means "keep interpreting this tick" (routing steps chain), so
 * we re-interpret from the next step. Pure: interpret does no I/O and never reads the clock.
 */
function drive(
  def: Parameters<typeof interpret>[0],
  run: RunRow,
  now: Date,
): { steps: { step: string; transition: Transition }[]; state: WorkflowState } {
  const out: { step: string; transition: Transition }[] = [];
  let state: WorkflowState = {
    ...(run.state ?? {}),
    currentStep: run.current_step,
  };
  for (let i = 0; i < MAX_STEPS; i++) {
    const step = state.currentStep ?? def.entry;
    const transition = interpret(def, state, { type: "wake" }, now);
    out.push({ step, transition });
    if (transition.runStatus !== "running") return { steps: out, state };
    // Advancing OUT of a routing step (a `call` re-entry or a `branch`) CONSUMES lastDisposition:
    // clear it so a same-tick chain (call->call) sees the next routing step FRESH, and so
    // applyTransitions persists a cleared state — never a stale disposition for the next tick.
    // EXCEPTION: keep it alive across a call->branch hop, so the branch routes on the SAME qualified
    // disposition (the seeded qualification path: qualify_call -> route -> book). The branch's own
    // advance (nextKind != branch) then clears it, so nothing stale is ever persisted.
    const kind = def.steps[step]?.kind;
    const nextStepId = transition.nextStep ?? step;
    const nextKind = def.steps[nextStepId]?.kind;
    state = { ...state, currentStep: nextStepId };
    if ((kind === "call" || kind === "branch") && nextKind !== "branch") {
      delete state.lastDisposition;
    }
  }
  throw new Error(`workflow step limit exceeded (${MAX_STEPS})`);
}

/** Apply every transition's actions in `tx`, then advance the run row exactly once. */
async function applyTransitions(
  tx: PoolClient,
  orgId: string,
  run: RunRow,
  steps: { step: string; transition: Transition }[],
  finalState: WorkflowState,
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  const attempts = normalizeAttempts(run.attempts);
  delete attempts[APPLY_ERRORS]; // this apply commits — an earlier transient failure is spent

  let final: Transition | undefined;
  let callSendId: string | undefined; // the call job this run will wait for, when the walk queues one
  for (const { step, transition } of steps) {
    final = transition;
    for (const [idx, action] of transition.actions.entries()) {
      if (EXTERNAL.has(action.kind)) {
        // Record the channel attempt only when the job is actually enqueued (singleton_key may
        // dedupe a re-tick of a still-parked run — no new job means no new attempt).
        const sendId = randomUUID();
        const enqueued = await enqueueJob(
          tx,
          orgId,
          { runId: run.id, step, idx, sendId },
          action,
        );
        if (enqueued && action.kind === "place_call") {
          pushAttempt(attempts, "voice", iso);
          callSendId = sendId;
        } else if (enqueued && action.kind === "send_wa") {
          pushAttempt(attempts, "whatsapp", iso);
        }
      } else {
        await applyInlineAction(tx, orgId, run.id, run, action);
      }
    }
  }
  if (!final) return; // drive never yields an empty walk; this guards the type-checker

  // Where the run now rests. A PARKED run resumes at final.nextStep (a wait's `then`, a fresh
  // call's own step). A run that COMPLETED by WALKING onto a terminal `end` has final.nextStep=null,
  // so land on the walked step (finalState.currentStep reached 'end') — never the pre-terminal step.
  // run.current_step is a last-ditch type guard (finalState.currentStep is always a set string).
  const nextStep = final.nextStep ?? finalState.currentStep ?? run.current_step;
  // Persist the WALKED state (lastDisposition cleared on routing advance), dropping the transient
  // currentStep field — the run's step lives in its own column. undefined values are omitted by
  // JSON.stringify, so no stale currentStep leaks into the state jsonb.
  await tx.query(
    `update workflow_runs
        set status = $2, current_step = $3, state = $4::jsonb, wake_at = $5,
            attempts = $6::jsonb, completed_at = $7, updated_at = now()
      where id = $1 and org_id = $8`,
    [
      run.id,
      final.runStatus,
      nextStep,
      JSON.stringify({ ...finalState, currentStep: undefined, callSendId }),
      final.wakeAt,
      JSON.stringify(attempts),
      final.runStatus === "completed" ? iso : null,
      orgId,
    ],
  );
}

/**
 * Enqueue an external action as a pgboss job on the queue named after the action kind. Writes the
 * DEFAULT partition `pgboss.job_common` directly: pg-boss v12 partitions `job` BY LIST(name) and
 * every writer — pg-boss's own `send` included — targets the leaf partition, never the parent
 * routing shell. Non-partitioned queues (policy 'short', the queues' default) land in job_common,
 * which is where the `job_i1` dedup index lives and which app_service owns (migration 015). This
 * also sidesteps a privilege split: app_service is not the parent `job`'s effective DML owner in
 * some stacks, but always owns the partition it works through (proven by the pg-boss send path).
 * Every job takes its queue's own retry and failure settings from pgboss.queue, as pg-boss's own
 * `send` gives them (retries, their delay, expiry, how long it is kept, the dead-letter queue), so
 * changing a queue in jobs.ts changes its scheduled jobs too; a queue missing, or not policy 'short'
 * in job_common, fails the apply rather than queue a job its settings or dedupe would not hold.
 * Idempotent by singleton_key `<runId>:<step>:<idx>` + policy 'short' (job_i1 dedupes while
 * state='created'), so a re-tick of a still-parked run no-ops. Payload = ids + action only; the
 * job handler re-scopes via withOrg. `sendId` is this job's own: every delivery and retry of the job
 * carries it, so the handler saves its send under it (src/sends.ts) and never sends twice, while a
 * later visit to the same step is a new job with a new id. `step`/`idx` ride the payload too.
 * Returns true iff a row was inserted.
 */
async function enqueueJob(
  tx: PoolClient,
  orgId: string,
  job: { runId: string; step: string; idx: number; sendId: string },
  action: Action,
): Promise<boolean> {
  const { runId, step, idx, sendId } = job;
  const singletonKey = `${runId}:${step}:${idx}`;
  const r = await tx.query<{ queue: string | null; queued: number }>(
    `with q as (select * from pgboss.queue where name = $1),
          queued as (
            insert into pgboss.job_common
              (name, data, singleton_key, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max,
               expire_seconds, deletion_seconds, keep_until, dead_letter, heartbeat_seconds)
            select name, $2::jsonb, $3, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max,
                   expire_seconds, deletion_seconds, now() + retention_seconds * interval '1 second',
                   dead_letter, heartbeat_seconds
              from q where policy = 'short' and table_name = 'job_common'
            on conflict do nothing
            returning 1)
     select (select policy || ' in ' || table_name from q) as queue,
            (select count(*) from queued)::int as queued`,
    [
      action.kind,
      JSON.stringify({
        orgId,
        runId,
        step,
        idx,
        sendId,
        action,
      }),
      singletonKey,
    ],
  );
  const { queue, queued } = r.rows[0] ?? { queue: null, queued: 0 };
  if (queue === "short in job_common") return queued > 0;
  // coverage gap: every database the tests use has the action queues, policy 'short', so none meets a missing one
  throw new Error(`queue ${action.kind}: ${queue ?? "missing"}`);
}

/** Apply an inline (no job hop) action in the same tx: outcomes / tasks writes. */
async function applyInlineAction(
  tx: PoolClient,
  orgId: string,
  runId: string,
  run: RunRow,
  action: Action,
): Promise<void> {
  if (action.kind === "write_outcome") {
    const { kind, contactId, ...attributes } = action.outcome as {
      kind: string;
      contactId?: string;
    } & Record<string, unknown>;
    await tx.query(
      `insert into outcomes
         (org_id, workflow_run_id, contact_id, kind, source, attributes)
       values ($1, $2, $3, $4, 'agent', $5::jsonb)`,
      [
        orgId,
        runId,
        contactId ?? run.contact_id,
        kind,
        JSON.stringify(attributes),
      ],
    );
    return;
  }
  if (action.kind === "create_task") {
    // The step's own kind and title, as its definition gives them; the database refuses a kind it doesn't know.
    const { kind, title, ...payload } = action.task as {
      kind: TaskKind;
      title: string;
    } & Record<string, unknown>;
    await createTask(tx, orgId, {
      contactId: run.contact_id,
      workflowRunId: runId,
      kind,
      title,
      payload,
      actor: { type: "system" },
    });
    return;
  }
  throw new Error(`unhandled inline action: ${action.kind}`);
}

function normalizeAttempts(raw: unknown): Attempts {
  const out: Attempts = {};
  if (raw && typeof raw === "object") {
    for (const [channel, value] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) out[channel] = value.map(String);
    }
  }
  return out;
}

function pushAttempt(attempts: Attempts, channel: string, iso: string): void {
  const arr = attempts[channel] ?? [];
  arr.push(iso);
  attempts[channel] = arr;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
