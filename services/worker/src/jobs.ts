// The worker's job runner (pg-boss; docs/tech-stack.md, "Jobs & durability"): receivers enqueue, this consumer drains.
// RLS shapes the design — app_service cannot discover orgs cross-tenant, so the org id
// rides the JOB and the processor re-scopes itself via withOrg. A lost enqueue is safe
// by construction: processVapiEvents drains ALL 'received' events for the org, so any
// later job for that org catches strays. pgboss.* has no RLS (CLAUDE.md gotcha) —
// job payloads carry ids only, never PII.
import {
  buildCatalog,
  createAnthropicProvider,
  guard,
  type LlmProvider,
  type SendPort,
} from "@revenue-os/harness";
import { OrgIdSchema } from "@revenue-os/shared";
import type { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { CALL_POST_QUEUE } from "./call-stops";
import { pool } from "./db";
import { type Env, env } from "./env";
import { type AgentTurnJob, handleAgentTurn } from "./handlers/agent-turn";
import { type CallPostJob, handleCallPost } from "./handlers/call-post";
import {
  handlePlaceCall,
  type OutcomePort,
  type PlaceCallJob,
  type VoiceSenderPort,
} from "./handlers/place-call";
import {
  handleSendWa,
  type SendWaJob,
  type WaSenderPort,
} from "./handlers/send-wa";
import { logger } from "./logger";
import { ACTION_QUEUES, discoverDueOrgs, tick } from "./scheduler";
import { TIME_LIMITS, type TimeLimits } from "./time-limits";
import { processVapiEvents } from "./vapi/process";

export const WEBHOOK_PROCESS_VAPI = "webhook.process.vapi";
// CALL_POST_QUEUE: the call and WhatsApp jobs' dead-letter SINK (handleCallPost drains it; src/call-stops.ts names it)
// A send job and its dead letter retry a few times with a growing delay (about 2, 4 and 8 seconds, and some random
// part), so a short database outage doesn't use up every try at once; a retry never sends twice (src/sends.ts).
const RETRIES = { retryLimit: 3, retryDelay: 2, retryBackoff: true };
const TICK_QUEUE = "scheduler.tick"; // the durable pg-boss schedule that fires the scheduler tick
// A running job's worker tells pg-boss it is alive every 15 seconds. A job not heard from for 30 (its worker crashed or
// was killed) is failed by a live worker's check, run every CHECK_SECONDS, and so runs again within about a minute
// rather than at its 15-minute expiry; its send is never repeated (src/sends.ts). test/restarts.test.ts kills a worker.
const HEARTBEAT_SECONDS = 30;
const CHECK_SECONDS = 15;
// How long a stopping worker lets its running jobs finish. A job still running then is handed back to its queue, and
// the next worker runs it again without repeating a send. docker/docker-compose.yml's stop_grace_period allows for it.
export const STOP_WAIT_MS = 60_000;
// A job payload is a boundary (docs/security.md S5.1): validate the tenancy field before a handler re-scopes on it.
const JobEnvelope = z.object({ orgId: OrgIdSchema });

/**
 * Construct the production Claude provider — but ONLY when a key is configured. Returns null with
 * no key so the worker still BOOTS (no LLM until a key is set). Pure construction: no network until
 * .complete() is first called (the raw-fetch adapter only fetches inside complete). Returns the
 * provider itself, not a registry entry — the caller injects it straight into the handler deps. It names no model:
 * each turn asks for the one its role version names.
 */
export function makeProvider(env: Env): LlmProvider | null {
  return env.ANTHROPIC_API_KEY
    ? createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY })
    : null;
}

// Live telephony (Vapi voice + Meta WhatsApp senders), the call-outcome port, the confirmation
// send seam, and the LLM provider when no key is set are all STUBBED here, each listed as Stub in
// STATE.md → What works today: production boot wires the SHAPE, and tests hand the job runner
// (startJobs' ports) or the handlers pretend providers instead. Every stub THROWS when invoked so a
// misconfigured effect fails LOUDLY rather than silently no-op'ing; boot stays green because a
// stub is a plain object, constructed without a throw.
function notWired(what: string): never {
  throw new Error(`${what} not wired (stub, listed in STATE.md)`); // done-gate: allow reworded only; each stub here is a Stub row in STATE.md
}
const VOICE_STUB: VoiceSenderPort = {
  place: () => notWired("voice sender (Vapi)"),
};
const WA_STUB: WaSenderPort = {
  send: () => notWired("whatsapp sender (Meta)"),
};
const OUTCOME_STUB: OutcomePort = () => notWired("call outcome port");
const UNWIRED_SEND: SendPort = () => notWired("confirmation send");
const UNCONFIGURED_PROVIDER: LlmProvider = {
  complete: () => notWired("LLM provider — set ANTHROPIC_API_KEY"),
};

let boss: PgBoss | null = null;

/** What the job handlers reach outside the worker: its database pool, the dialer, the WhatsApp sender, the call's
 *  outcome and the AI model, and how long they wait for each (src/time-limits.ts). */
export type JobPorts = {
  pool: Pool;
  voice: VoiceSenderPort;
  wa: WaSenderPort;
  outcome: OutcomePort;
  provider: LlmProvider;
  limits: Partial<TimeLimits>;
};

/**
 * Starts the job runner. `settings` overrides pg-boss's own: a test passes a schema of its own and no clock
 * (test/fixtures/test-job-schema.ts), so the runner it starts never works another company's queued jobs or ticks
 * every company's due runs. `ports` replaces what the handlers reach outside the worker: a test passes pretend
 * providers there. The worker itself passes neither.
 */
export async function startJobs(
  settings: {
    schema?: string;
    schedule?: boolean;
    superviseIntervalSeconds?: number;
    monitorIntervalSeconds?: number;
  } = {},
  ports: Partial<JobPorts> = {},
): Promise<void> {
  if (boss) return;
  // What the handlers reach outside the worker. A missing key yields a stub provider (boot stays green — see
  // makeProvider), and live telephony / send seams are the stubs above, unless a test passes its own.
  const {
    pool: db,
    voice,
    wa,
    outcome,
    provider,
    limits,
  } = {
    pool,
    voice: VOICE_STUB,
    wa: WA_STUB,
    outcome: OUTCOME_STUB,
    provider: makeProvider(env) ?? UNCONFIGURED_PROVIDER,
    limits: TIME_LIMITS,
    ...ports,
  };
  const b = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: "pgboss",
    // The schema itself ships in migration 015 — app_service has CREATE inside it,
    // not on the database, so pg-boss must not attempt CREATE SCHEMA (verified: it
    // fails with 42501 otherwise).
    createSchema: false,
    superviseIntervalSeconds: CHECK_SECONDS,
    monitorIntervalSeconds: CHECK_SECONDS,
    ...settings,
  });
  b.on("error", (err) => logger.error({ err }, "pg-boss"));
  await b.start();
  // Retry posture (docs/tech-stack.md, "Jobs & durability — the exact wiring"): 3 tries, 60s
  // apart, 15-minute expiry; permanently failed jobs stay queryable in pgboss.job.
  await b.createQueue(WEBHOOK_PROCESS_VAPI, {
    retryLimit: 3,
    retryDelay: 60,
    expireInSeconds: 900,
  });

  // --- the external-action queues and their handlers (src/handlers/) -------------------------
  // The call.post dead-letter SINK first so the send queues can reference it as their deadLetter: a call or
  // WhatsApp job that keeps failing reaches a person there. Each action queue is policy 'short': the scheduler's
  // singleton_key dedup rides pgboss.job's job_i1 index (state='created' AND policy='short'), and
  // scheduler.enqueueJob refuses a queue on any other policy. Each job the scheduler queues takes its queue's
  // settings below: its retries, their delay and its dead letter. pg-boss's createQueue leaves a queue that already
  // exists as it was, so updateQueue gives an existing queue these settings too. A retry runs the handler again,
  // which never sends twice: it finds the send it saved (src/sends.ts).
  await b.createQueue(CALL_POST_QUEUE);
  await b.updateQueue(CALL_POST_QUEUE, RETRIES);
  for (const q of ACTION_QUEUES) {
    await b.createQueue(q, { policy: "short" });
    if (q !== "run_agent_turn")
      await b.updateQueue(q, { ...RETRIES, deadLetter: CALL_POST_QUEUE });
  }
  await b.createQueue(TICK_QUEUE);
  // Every queue's jobs say they are alive while they run, from before the first is taken (HEARTBEAT_SECONDS).
  for (const q of [
    WEBHOOK_PROCESS_VAPI,
    CALL_POST_QUEUE,
    ...ACTION_QUEUES,
    TICK_QUEUE,
  ])
    await b.updateQueue(q, { heartbeatSeconds: HEARTBEAT_SECONDS });

  await b.work(WEBHOOK_PROCESS_VAPI, async (jobs) => {
    for (const job of jobs) {
      const { orgId } = JobEnvelope.parse(job.data); // a job payload is a boundary
      await processVapiEvents(db, orgId);
    }
  });

  // Shared handler deps. The guard pipeline is the real one (guardrails run before every send). Each work loop
  // parses the payload's org id as a boundary.
  const registry = buildCatalog({ send: UNWIRED_SEND });

  await b.work<PlaceCallJob>("place_call", async (jobs) => {
    for (const job of jobs) {
      JobEnvelope.parse(job.data);
      await handlePlaceCall(
        { pool: db, guard, sender: voice, provider, registry, outcome, limits },
        job.data,
      );
    }
  });
  await b.work<SendWaJob>("send_wa", async (jobs) => {
    for (const job of jobs) {
      JobEnvelope.parse(job.data);
      await handleSendWa({ pool: db, guard, sender: wa, limits }, job.data);
    }
  });
  await b.work<AgentTurnJob>("run_agent_turn", async (jobs) => {
    for (const job of jobs) {
      JobEnvelope.parse(job.data);
      await handleAgentTurn({ pool: db, provider, registry, limits }, job.data);
    }
  });
  // The dead-letter SINK tolerates a partial/malformed payload by design (handleCallPost self-guards: it resolves
  // on one, and throws only when the database fails it, so its queue retries), so it takes the raw job data
  // without the strict envelope parse.
  await b.work<CallPostJob>(CALL_POST_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await handleCallPost({ pool: db }, job.data);
    }
  });

  // --- the scheduler tick, scheduled DURABLY via pg-boss (survives restarts, unlike a
  // per-process setInterval a redeploy would silently drop). 1-minute cron is pg-boss's finest
  // granularity — fine for day-scale runs; the call replay test drives tick() per-org directly.
  await b.work(TICK_QUEUE, async () => {
    await runScheduledTick();
  });
  await b.schedule(TICK_QUEUE, "* * * * *");

  boss = b;
}

/** The job runner is started and reaches its queue tables (pg-boss's schema) in the database: GET /ready asks it. */
export async function jobQueueReachable(): Promise<boolean> {
  return boss !== null && (await boss.isInstalled());
}

/** Stops the job runner: it takes no new job, and lets running ones finish for up to STOP_WAIT_MS. */
export async function stopJobs(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  await b.stop({ graceful: true, timeout: STOP_WAIT_MS });
}

/** On a restart or deploy (SIGTERM) or Ctrl-C (SIGINT), the worker stops its job runner (stopJobs), then calls `exit`. */
export function stopOnSignal(exit: () => void): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      logger.info({ signal }, "stopping: no new jobs; running jobs finish");
      stopJobs()
        .catch((err) => logger.error({ err }, "job runner stop failed"))
        .finally(exit);
    });
}

/** Nudge the consumer after a webhook insert commits. Never throws into the receiver:
 * the 202 already happened at the provider's side of the contract, and the event row
 * (status 'received') is the durable fact a later drain recovers. */
export async function enqueueVapiProcess(orgId: string): Promise<void> {
  if (!boss) return; // receiver-only contexts (e.g. unit tests) run without a consumer
  try {
    await boss.send(WEBHOOK_PROCESS_VAPI, { orgId });
  } catch (err) {
    logger.error({ err, org_id: orgId }, "enqueue webhook.process.vapi failed");
  }
}

/**
 * The pg-boss-scheduled tick: discover orgs with due runs and drive each through the scheduler's
 * per-org `tick`. Discovery is the RLS-exempt `app.due_org_ids()` enumerator (migration 016) —
 * ids only, no row payload — so the fan-out is genuinely cross-tenant while every subsequent read
 * stays org-scoped through withOrg. A discovery failure means "tick what's visible" (nothing),
 * never a crashed tick. The call replay test drives tick() per-org directly.
 */
async function runScheduledTick(): Promise<void> {
  const now = new Date();
  let orgIds: string[] = [];
  try {
    orgIds = await discoverDueOrgs(pool);
  } catch (err) {
    logger.error({ err }, "scheduler tick: org discovery unavailable");
  }
  for (const orgId of orgIds) {
    try {
      await tick(pool, orgId, { now });
    } catch (err) {
      logger.error({ err, org_id: orgId }, "scheduler tick failed for org");
    }
  }
}
