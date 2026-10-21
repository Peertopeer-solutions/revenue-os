// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow-step field (data, not a
// thenable) in the workflow definition JSON (packages/harness/src/workflow/schema.ts), the same
// suppression the scheduler, handlers and interpreter carry.
//
// `bun run demo` sequences the FULL engine cycle locally with NO telephony and NO LLM cost, then
// prints the run's journey. Everything it sequences already exists (startRun · scheduler.tick ·
// the place_call handler with a stubbed VOICE sender · the real Vapi webhook receiver): the driver
// only orders it and records a structured journey the CLI renders
// (services/worker/test/demo-driver.test.ts drives `demo()`).

import type {
  GuardedAction,
  LlmProvider,
  OrgCtx,
  Verdict,
} from "@harness/types";
import type { Pool } from "pg";
// scripts/ is NOT a workspace, so `@revenue-os/*` package names have no node_modules symlink here,
// and the `@db/*` / `@harness/*` tsconfig aliases resolve for TYPE-ONLY imports (erased at runtime)
// but NOT for value imports. Value imports must reach the package SOURCE by relative path — exactly
// how this file already imports `../services/worker/src/...` below. bun + tsc both resolve these.
import { withOrg } from "../packages/db/src/client";
import { recordWhatsAppOptIn } from "../packages/db/src/consent";
import { buildCatalog } from "../packages/harness/src/tools";
import {
  handlePlaceCall,
  type OutcomePort,
  type PlaceCallDeps,
  type PlaceCallJob,
  type VoiceSenderPort,
} from "../services/worker/src/handlers/place-call";
import { startRun } from "../services/worker/src/runs";
import { tick } from "../services/worker/src/scheduler";

/** Ordered stages the driver records — one per milestone of the engine cycle. */
export type JourneyStage =
  | "enrolled"
  | "tick_advanced"
  | "call_placed"
  | "webhook_simulated"
  | "run_advanced"
  | "terminal";

/** One journey entry: structured data (NOT a formatted string) so the CLI owns rendering. */
export interface JourneyEvent {
  stage: JourneyStage;
  detail: string;
}

/** The guard the send path MUST pass before any effect (guardrails run before every send). Tests inject a spy. */
export type GuardPort = (
  ctx: OrgCtx,
  action: GuardedAction,
) => Promise<Verdict>;

/** A minimal Hono-app shape: enough to POST the signed webhook to the REAL receiver route. */
export interface FetchApp {
  fetch(req: Request): Response | Promise<Response>;
}

/**
 * Injected seams for one demo run (NO real telephony, NO Anthropic, NO network beyond localhost). `pool` is the app_service door; `app` is the real receiver; every effect port is a
 * stub/fake supplied by the caller. `webhookSecret` is passed in — the driver NEVER reads .env.
 */
export interface DemoDeps {
  pool: Pool;
  app: FetchApp;
  webhookSecret: string;
  orgId: string;
  workflowId: string;
  contact: { firstName: string; phone: string };
  disposition: string; // which branch to exercise (e.g. "site_visit_agreed" | "callback")
  callId: string; // unique per run so the webhook dedupe_key does not collide across re-runs
  voice: VoiceSenderPort; // stubbed voice sender (no telephony)
  provider: LlmProvider; // stubbed LLM (no Anthropic cost)
  guard: GuardPort;
  outcome: OutcomePort; // resolves the scripted disposition (no live end-of-call report)
  now: () => Date;
}

/** The demo's structured result — the journey plus the run's terminal facts and created ids. */
export interface DemoResult {
  runId: string;
  contactId: string;
  conversationId: string | null;
  journey: JourneyEvent[];
  terminalStatus: string;
  terminalStep: string;
}

/**
 * Run ONE full engine cycle for a seeded org: create + enroll a named contact (startRun), drive
 * tick() directly (no cron wait), place the call through the stubbed sender, simulate the Vapi
 * webhook through the REAL receiver, advance the waiting run through the disposition branch, and
 * return the ordered journey + terminal state.
 */
export async function demo(deps: DemoDeps): Promise<DemoResult> {
  const {
    pool,
    app,
    webhookSecret,
    orgId,
    workflowId,
    contact,
    callId,
    voice,
    provider,
    guard,
    outcome,
    now,
  } = deps;

  const journey: JourneyEvent[] = [];
  const record = (stage: JourneyStage, detail: string): void => {
    journey.push({ stage, detail });
  };

  // 1. ENROLL — create the named contact (+ its phone identity) and start a run at the workflow's
  //    entry step. startRun stamps wake_at = now() (wall clock); the far-future sim `now` already
  //    covers it, so the very first tick finds the run due — no cron wait.
  const contactId = await withOrg(pool, orgId, async (tx) => {
    const c = await tx.query<{ id: string }>(
      `insert into contacts (org_id, first_name) values ($1, $2) returning id`,
      [orgId, contact.firstName],
    );
    const id = c.rows[0]?.id as string;
    await tx.query(
      `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
       values ($1, $2, 'phone', $3, true)`,
      [orgId, id, contact.phone],
    );
    // The scripted lead agreed to WhatsApp messages on the enquiry form, so the guard lets the confirmation through.
    await recordWhatsAppOptIn(tx, orgId, id, { source: "demo enquiry form" });
    return id;
  });
  const runId = await startRun(pool, orgId, {
    workflowId,
    contactId,
    state: { timezone: "Asia/Kolkata" },
  });
  record("enrolled", `contact ${contact.firstName} enrolled as run ${runId}`);

  const placeDeps: PlaceCallDeps = {
    pool,
    guard,
    sender: voice,
    provider,
    // The call turn is a single text turn (no tool calls), so the catalog's send is never invoked:
    // the booking side effect lands later, inline, through the workflow's own tool step.
    registry: buildCatalog({ send: async () => ({ ok: true }) }),
    outcome,
    now,
  };

  // 2. TICK — drive the due run directly. The fresh call step enqueues a place_call job and parks
  //    the run 'waiting'.
  await tick(pool, orgId, { now: now() });
  record(
    "tick_advanced",
    "scheduler tick enqueued the call and parked the run",
  );

  // 3. PLACE THE CALL — pull the exact place_call action the tick wrote and run the REAL handler:
  //    guard() before the stubbed voice send, a voice conversation + metered turn, then the scripted
  //    outcome folds into state.lastDisposition and re-arms the run (no telephony, no Anthropic).
  const jobs = await pool.query<{ id: string; data: PlaceCallJob }>(
    `select id, data from pgboss.job
      where name = 'place_call' and state = 'created' and data ->> 'runId' = $1
      order by created_on`,
    [runId],
  );
  for (const job of jobs.rows) {
    await handlePlaceCall(placeDeps, job.data);
    await pool.query(`delete from pgboss.job where id = $1`, [job.id]);
  }
  record(
    "call_placed",
    `dispatched ${jobs.rows.length} place_call job(s) through the stubbed voice sender`,
  );

  // 4. SIMULATE THE WEBHOOK — POST a signed end-of-call report through the REAL Vapi receiver so a
  //    webhook_events row lands (dedupe by provider ref). No network beyond the localhost app.
  const res = await app.fetch(
    new Request(`http://localhost/webhooks/vapi/${orgId}`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-vapi-secret": webhookSecret,
      }),
      body: JSON.stringify({
        message: {
          type: "end-of-call-report",
          call: { id: callId },
          timestamp: now().toISOString(),
          id: `${callId}-eocr`,
          summary: `Demo call for ${contact.firstName}.`,
          endedReason: "hangup",
        },
      }),
    }),
  );
  record("webhook_simulated", `real receiver returned ${res.status}`);

  // 5. ADVANCE — the run is re-armed 'waiting' at now(); this tick routes the folded disposition
  //    through the workflow (call re-entry → branch/tool) to a terminal step.
  await tick(pool, orgId, { now: now() });
  record(
    "run_advanced",
    "scheduler tick routed the disposition through the workflow",
  );

  // 6. TERMINAL — read back the run's resting state and its voice conversation.
  const terminal = await withOrg(pool, orgId, async (tx) => {
    const r = await tx.query<{ status: string; current_step: string }>(
      `select status, current_step from workflow_runs where org_id = $1 and id = $2`,
      [orgId, runId],
    );
    const convo = await tx.query<{ id: string }>(
      `select id from conversations
        where org_id = $1 and workflow_run_id = $2 and channel = 'voice'
        order by created_at limit 1`,
      [orgId, runId],
    );
    return {
      status: r.rows[0]?.status ?? "unknown",
      step: r.rows[0]?.current_step ?? "unknown",
      conversationId: convo.rows[0]?.id ?? null,
    };
  });
  record("terminal", `run ${terminal.status} at step ${terminal.step}`);

  return {
    runId,
    contactId,
    conversationId: terminal.conversationId,
    journey,
    terminalStatus: terminal.status,
    terminalStep: terminal.step,
  };
}

// --- `bun run demo` CLI shell -------------------------------------------------------------------
// Composes REAL local deps and pretty-prints the journey. CLI-only deps (createPool, the real
// guard, the real receiver app, pg) load via dynamic import INSIDE this block so the tested `demo()`
// surface above stays free of them. The place_call QUEUE must already exist (created when the worker
// runs — `bun run dev`); pg-boss itself is a worker dep `scripts/` cannot import. Refuses a database
// that is not on this machine (scripts/local-url.ts) before it loads or connects to anything. It
// self-seeds a throwaway demo company whose qualifier goes live through its test set (the real_estate
// seed ships a DRAFT), so the demo is self-contained and re-runnable, and its clean-up touches only that
// company's rows and queued jobs.
// Usage: `bun scripts/demo.ts [disposition]`.

/**
 * The demo company's qualifier role, version 1, every part of it rows (migration 026), put live as any version is: its
 * one test conversation runs through the eval runner on the real turn and tools, with this demo's scripted model, and
 * the database lets it be tested, then live, only once that stored run passes.
 */
async function putQualifierLive(
  admin: Pick<Pool, "query">,
  pool: Pool,
  orgId: string,
  tz: string,
): Promise<void> {
  const { createCaptureSend, runEvals } = await import("./eval-runner");
  const { RoleRulesSchema } = await import("../packages/shared/src/role");
  const rules = RoleRulesSchema.parse({
    outcomes: ["site_visit_booked"],
    booking: { kind: "site_visit", outcome: "site_visit_booked" },
  });
  const versionId = (
    await admin.query(
      `insert into agents (org_id, key, version, status, model, system_prompt, rules, tools_allowed, test_set)
       values ($1, 'qualifier', 1, 'draft', 'anthropic:claude-sonnet-5-5', 'You are a qualifier.', $2::jsonb,
               '{book_appointment}', '{books_a_visit}') returning id`,
      [orgId, JSON.stringify(rules)],
    )
  ).rows[0].id;
  await admin.query(
    `insert into eval_scenarios (org_id, key, persona, script, assertions)
     values ($1, 'books_a_visit', '{"name":"Eval lead","language":"en"}', '{"turns":["Can I visit on Saturday?"]}',
             '{"expect_outcome":"site_visit_booked"}')`,
    [orgId],
  );
  // The runner's conversation is with the company's first lead, made here so the scripted model can name it.
  const evalLead = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Eval lead') returning id`,
      [orgId],
    )
  ).rows[0].id;
  let asked = 0;
  const tried = await withOrg(pool, orgId, (tx) =>
    runEvals(
      {
        provider: {
          complete: async () =>
            asked++ === 0
              ? {
                  toolCalls: [
                    {
                      name: "book_appointment",
                      args: {
                        contactId: evalLead,
                        startsAt: "2030-06-08T05:30:00.000Z",
                        endsAt: "2030-06-08T06:30:00.000Z",
                        timezone: tz,
                      },
                    },
                  ],
                  usage: { in: 6, out: 4 },
                }
              : { text: "Booked for Saturday.", usage: { in: 8, out: 3 } },
        },
        player: async (scenario, i) => scenario.script.turns[i] ?? null,
        send: createCaptureSend().send,
        agentId: versionId,
        model: "anthropic:claude-sonnet-5-5",
        systemPrompt: "You are a qualifier.",
        toolsAllowed: ["book_appointment"],
        rules,
      },
      { orgId, db: tx },
    ),
  );
  if (tried.exitCode !== 0)
    throw new Error(`the qualifier's test set failed:\n${tried.summary}`);
  for (const status of ["tested", "active"])
    await admin.query(
      `update agents set status = $3 where id = $1 and org_id = $2`,
      [versionId, orgId, status],
    );
  console.log(
    `\n  version 1 of the qualifier passed its test set (${tried.results.length} conversation) and went live`,
  );
}

if (import.meta.main) {
  const { isLocalUrl } = await import("./local-url");
  const dbUrl =
    process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
  const adminUrl =
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!isLocalUrl(dbUrl) || !isLocalUrl(adminUrl)) {
    throw new Error("demo refuses to run against a non-local database");
  }
  const { createPool } = await import("../packages/db/src/client");
  const { guard } = await import("../packages/harness/src/index");
  const { default: app } = await import("../services/worker/src/index");
  const pg = (await import("pg")).default;
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret)
    throw new Error("demo needs VAPI_WEBHOOK_SECRET for the receiver");

  const disposition = process.argv[2] ?? "site_visit_agreed";
  const TZ = "Asia/Kolkata";
  const admin = new pg.Pool({ connectionString: adminUrl });
  const pool = createPool(dbUrl);

  // A hand copy of the seeded `qualification` shape (call, branch on the result, then the booking or
  // callback tool); Slice 3's demo item replaces it with the sequence a real company gets.
  const def = {
    entry: "qualify_call",
    steps: {
      qualify_call: {
        kind: "call",
        agent: "qualifier",
        on: {
          completed: "route",
          no_answer: "retry_wait",
          busy: "retry_wait",
          failed: "end",
        },
      },
      retry_wait: { kind: "wait", for: "PT2H", then: "whatsapp_followup" },
      whatsapp_followup: {
        kind: "whatsapp",
        template: "followup_1",
        then: "recall_wait",
      },
      recall_wait: { kind: "wait_until", localTime: "11:00", then: "recall" },
      recall: {
        kind: "call",
        agent: "qualifier",
        on: {
          completed: "route",
          no_answer: "end",
          busy: "end",
          failed: "end",
        },
      },
      route: {
        kind: "branch",
        onDisposition: {
          site_visit_agreed: "book",
          callback: "callback_task",
          "*": "end",
        },
      },
      book: {
        kind: "tool",
        tool: "book_appointment",
        outcome: "site_visit_booked",
        args: {},
        then: "end",
      },
      callback_task: {
        kind: "tool",
        tool: "create_task",
        args: { kind: "callback", title: "Call back the buyer" },
        then: "end",
      },
      end: { kind: "end" },
    },
  };

  const stamp = Date.now();
  const orgId = (
    await admin.query(
      `insert into orgs (id, name, slug) values ($1, 'Demo Org', $2) returning id`,
      [crypto.randomUUID(), `demo-cli-${stamp}`],
    )
  ).rows[0].id;
  await putQualifierLive(admin, pool, orgId, TZ);
  await admin.query(
    `insert into guardrail_policies (org_id, key, config, active)
     values ($1, 'quiet_hours', $2::jsonb, true), ($1, 'attempt_caps', $3::jsonb, true)`,
    [
      orgId,
      JSON.stringify({ start: "21:00", end: "07:00", tz: TZ }),
      JSON.stringify({ voice: { max: 3, per_hours: 72 } }),
    ],
  );
  const workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, 'qualification', 1, 'active', $2::jsonb) returning id`,
      [orgId, JSON.stringify(def)],
    )
  ).rows[0].id;

  // A far-future daytime IST anchor so the guard's quiet-hours read is deterministic. No real waits.
  const at = new Date("2030-06-03T04:30:00.000Z");
  let placed = 0;
  const result = await demo({
    pool,
    app,
    webhookSecret: secret,
    orgId,
    workflowId,
    contact: {
      firstName: "Asha",
      phone: `+9198765${String(10000 + (stamp % 90000))}`,
    },
    disposition,
    callId: `demo-cli-call-${stamp}`,
    voice: {
      place: async () => {
        placed += 1;
        return { providerRef: `vapi-cli-${stamp}-${placed}` };
      },
    },
    provider: {
      complete: async () => ({
        text: "Hi, a quick chat about your enquiry.",
        usage: { in: 5, out: 3 },
      }),
    },
    guard: (ctx, action) => guard({ ...ctx, now: () => at }, action),
    outcome: async () => disposition,
    now: () => at,
  });

  console.log(`\n  bun run demo — ${disposition}`);
  console.log("  ─────────────────────────────────────────────");
  for (const ev of result.journey) {
    console.log(`  ${ev.stage.padEnd(18)} ${ev.detail}`);
  }
  console.log("  ─────────────────────────────────────────────");
  console.log(
    `  run ${result.runId} → ${result.terminalStatus} at step '${result.terminalStep}'\n`,
  );

  // Tidy the throwaway company and nothing else: its rows that don't cascade, its own queued jobs
  // (through app_service, which owns pg-boss's tables), then the company with the rest.
  await admin.query(`delete from usage_events where org_id = $1`, [orgId]);
  await admin.query(`delete from audit_log where org_id = $1`, [orgId]);
  await admin.query(`delete from eval_runs where org_id = $1`, [orgId]);
  await pool.query(`delete from pgboss.job where data ->> 'orgId' = $1`, [
    orgId,
  ]);
  await admin.query(`delete from orgs where id = $1`, [orgId]);
  await pool.end();
  await admin.end();
  process.exit(0);
}
