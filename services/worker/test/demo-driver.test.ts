// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow-step field (data, not a
// thenable) in the workflow definition JSON — the same suppression scheduler/handlers/m2-replay carry.
//
// THE DEMO DRIVER suite. `bun run demo` sequences the full engine cycle locally with NO telephony
// and NO LLM cost and prints the run's journey. This suite drives the exported demo()
// (scripts/demo.ts) against the REAL local stack (Postgres + pg-boss + the real Vapi webhook
// receiver), with the voice sender / LLM / outcome ports STUBBED — the multi-day replay's seam
// pattern (m2-replay.test.ts). It needs a migrated local database AND VAPI_WEBHOOK_SECRET in the
// process env (the receiver reads it directly and answers 501 without it), so it runs with the
// local stack's settings (`bun run gate`, CI).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import pg from "pg";
import { PgBoss } from "pg-boss";
import {
  type DemoDeps,
  type DemoResult,
  demo,
  type JourneyStage,
} from "../../../scripts/demo";
import { putLive } from "../../../tests/live-version";
import { testCompanies } from "../../../tests/test-companies";
import app from "../src/index";
import {
  makeFakeVoice,
  makeGuardSpy,
  makeScriptedLlm,
} from "./fixtures/fake-channels";
import { SimClock } from "./fixtures/sim-clock";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = createPool(DB_URL); // also owns pg-boss's tables: reads and clears this file's jobs
const companies = testCompanies(admin, appPool);
const boss = new PgBoss({
  connectionString: DB_URL,
  schema: "pgboss",
  createSchema: false,
});
const SECRET = process.env.VAPI_WEBHOOK_SECRET || "local-test-secret";

// Far-future daytime IST anchor (India has no DST) so guard's quiet-hours read is deterministic and
// the pending run (startRun stamps wake_at = wall now, ~2026) is due at this sim instant.
const START = "2030-06-03T04:30:00.000Z"; // 10:00 IST
const TZ = "Asia/Kolkata";

// The demo workflow: a call that routes the BUSINESS disposition straight into the branch's side
// effect — site_visit_agreed → book (writes a site_visit_booked outcome), callback → a callback
// task. Mirrors the seeded real_estate qualification branch's SEMANTICS (the seeded workflow's
// intermediate `route` branch has its own test at the end of this file).
const DEMO_WF = {
  entry: "qualify_call",
  steps: {
    qualify_call: {
      kind: "call",
      agent: "qualifier",
      on: {
        site_visit_agreed: "book",
        callback: "callback_task",
        no_answer: "end",
        failed: "end",
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
      args: {
        kind: "callback",
        title: "Call back the buyer about the site visit",
      },
      then: "end",
    },
    end: { kind: "end" },
  },
};

let orgId = "";
let workflowId = "";

beforeAll(async () => {
  await boss.start();
  try {
    await boss.createQueue("place_call", { policy: "short" });
  } catch {
    // idempotent across reruns
  }
  orgId = (await companies.add("Demo Org")).id;
  await putLive(admin, orgId, {
    key: "qualifier",
    systemPrompt: "You are a qualifier.",
    toolsAllowed: ["book_appointment"],
    rules: {
      outcomes: ["site_visit_booked"],
      booking: { kind: "site_visit", outcome: "site_visit_booked" },
    },
  });
  await admin.query(
    `insert into guardrail_policies (org_id, key, config, active)
     values ($1, 'quiet_hours', $2::jsonb, true), ($1, 'attempt_caps', $3::jsonb, true)`,
    [
      orgId,
      JSON.stringify({ start: "21:00", end: "07:00", tz: TZ }),
      JSON.stringify({
        voice: { max: 3, per_hours: 72 },
        whatsapp: { max: 2, per_hours: 24 },
      }),
    ],
  );
  workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, 'demo-qual', 1, 'active', $2::jsonb) returning id`,
      [orgId, JSON.stringify(DEMO_WF)],
    )
  ).rows[0].id;
}, 60_000);

afterAll(async () => {
  await companies.cleanup();
  await boss.stop({ graceful: true, timeout: 5_000 });
  await appPool.end();
  await admin.end();
});

let demoSeq = 0;

/** Build injected deps for ONE demo run and invoke demo(). Every effect port is a stub/fake: no
 *  telephony, no Anthropic, no network beyond the localhost receiver. Returns the result plus the
 *  fakes so a test can assert placeCount / the guard ledger (guardrails before every send). */
async function runDemo(
  disposition: string,
  opts: { workflowId?: string } = {},
): Promise<{
  result: DemoResult;
  voice: ReturnType<typeof makeFakeVoice>;
  guardCalls: ReturnType<typeof makeGuardSpy>["calls"];
}> {
  demoSeq += 1;
  const clock = new SimClock(START);
  const voice = makeFakeVoice([disposition]);
  const guardSpy = makeGuardSpy(clock);
  const deps: DemoDeps = {
    pool: appPool,
    app,
    webhookSecret: SECRET,
    orgId,
    workflowId: opts.workflowId ?? workflowId,
    contact: {
      firstName: `Asha${demoSeq}`,
      phone: `+91987650${String(1000 + demoSeq)}`,
    },
    disposition,
    callId: `demo-call-${randomUUID()}`, // call ids are unique across every company and every run
    voice,
    provider: makeScriptedLlm([
      {
        text: "Hi, a quick chat about your enquiry.",
        usage: { in: 5, out: 3 },
      },
    ]),
    guard: guardSpy.fn,
    outcome: voice.outcome,
    now: () => clock.now(),
  };
  const result = await demo(deps);
  return { result, voice, guardCalls: guardSpy.calls };
}

/** The expected ordered stage sequence for a completed disposition path. */
const EXPECTED_STAGES: JourneyStage[] = [
  "enrolled",
  "tick_advanced",
  "call_placed",
  "webhook_simulated",
  "run_advanced",
  "terminal",
];

describe("demo driver — golden path", () => {
  it("enrolls a named contact via startRun and drives the run to a terminal state", async () => {
    const { result } = await runDemo("site_visit_agreed");
    expect(result.runId).toBeTruthy();
    expect(result.contactId).toBeTruthy();
    // enrolled → advanced → completed, with NO cron wait (tick driven directly).
    expect(result.terminalStatus).toBe("completed");

    const run = await admin.query(
      `select status, contact_id from workflow_runs where id = $1`,
      [result.runId],
    );
    expect(run.rows[0]?.status).toBe("completed");
    expect(run.rows[0]?.contact_id).toBe(result.contactId);
    // the enrolled contact exists under the demo org with the given name
    const contact = await admin.query(
      `select first_name from contacts where id = $1 and org_id = $2`,
      [result.contactId, orgId],
    );
    expect(contact.rows[0]?.first_name).toMatch(/^Asha/);
  });

  it("returns the journey as ordered structured {stage, detail} data", async () => {
    const { result } = await runDemo("site_visit_agreed");
    // structured data, not a formatted blob
    for (const ev of result.journey) {
      expect(typeof ev.stage).toBe("string");
      expect(typeof ev.detail).toBe("string");
    }
    // the golden sequence, in order
    expect(result.journey.map((e) => e.stage)).toEqual(EXPECTED_STAGES);
  });

  it("[golden] site_visit_agreed advances the waiting run through the branch → a booking side effect", async () => {
    const { result } = await runDemo("site_visit_agreed");
    // the run left 'waiting' and completed by WALKING the branch to a terminal step
    const run = await admin.query(
      `select status, current_step from workflow_runs where id = $1`,
      [result.runId],
    );
    expect(run.rows[0]?.status).not.toBe("waiting");
    // the book branch's side effect: a site_visit_booked outcome attributed to THIS run's contact
    const outcome = await admin.query(
      `select id from outcomes where org_id = $1 and contact_id = $2 and kind = 'site_visit_booked'`,
      [orgId, result.contactId],
    );
    expect(outcome.rows.length).toBe(1);
  });

  it("no real side effects: the stubbed voice sender fires exactly once and every send passed guard()", async () => {
    const { result, voice, guardCalls } = await runDemo("site_visit_agreed");
    expect(result.terminalStatus).toBe("completed");
    expect(voice.placeCount).toBe(1); // one stubbed placement — no telephony, no re-placement
    // guardrails before every send: the send went through the real guard pipeline; no send bypassed the doorway
    const voiceGuards = guardCalls.filter((c) => c.channel === "voice");
    expect(voiceGuards.length).toBe(1);
    expect(voiceGuards.every((c) => c.ok)).toBe(true);
  });
});

/** POST a signed body to the REAL Vapi receiver route for the demo org (mirrors vapi-webhook.test). */
function postSigned(body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/webhooks/vapi/${orgId}`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-vapi-secret": SECRET,
      }),
      body: JSON.stringify(body),
    }),
  );
}

describe("demo driver — alternate branch", () => {
  it("[alternate] callback advances the run through the branch → a callback task row", async () => {
    const { result } = await runDemo("callback");
    expect(result.terminalStatus).toBe("completed");
    const task = await admin.query(
      `select kind from tasks where org_id = $1 and contact_id = $2 and kind = 'callback'`,
      [orgId, result.contactId],
    );
    expect(task.rows.length).toBe(1);
    // and NO booking outcome on the callback path
    const booked = await admin.query(
      `select id from outcomes where org_id = $1 and contact_id = $2 and kind = 'site_visit_booked'`,
      [orgId, result.contactId],
    );
    expect(booked.rows.length).toBe(0);
  });
});

describe("demo driver — real receiver + dedupe", () => {
  it("the demo's webhook goes through the REAL receiver and lands a webhook_events row", async () => {
    const { result } = await runDemo("site_visit_agreed");
    expect(result.terminalStatus).toBe("completed");
    const evs = await admin.query(
      `select count(*)::int n from webhook_events where org_id = $1 and provider = 'vapi'`,
      [orgId],
    );
    expect(evs.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("posting the SAME event twice does not double-apply (dedupe_key honored)", async () => {
    const callId = `demo-dedupe-${randomUUID()}`;
    const event = {
      message: {
        type: "end-of-call-report",
        call: { id: callId },
        timestamp: "2030-06-03T04:31:00.000Z",
        id: `${callId}-eocr`,
        summary: "Qualified — agreed to a site visit.",
        endedReason: "hangup",
      },
    };
    expect((await postSigned(event)).status).toBe(202);
    expect((await postSigned(event)).status).toBe(202); // replay
    const r = await admin.query(
      `select count(*)::int n from webhook_events where dedupe_key = $1`,
      [`vapi:${callId}-eocr`],
    );
    expect(r.rows[0].n).toBe(1); // one row despite two posts
  });
});

describe("demo driver — re-runnable", () => {
  it("running demo() twice enrolls a FRESH run each time with no unique-collision crash", async () => {
    const first = await runDemo("site_visit_agreed");
    const second = await runDemo("site_visit_agreed");
    expect(second.result.runId).not.toBe(first.result.runId);
    expect(first.result.terminalStatus).toBe("completed");
    expect(second.result.terminalStatus).toBe("completed");
  });
});

describe("demo driver — tenancy (RLS on every table)", () => {
  it("[cross-tenant denial] a demo run scoped to org A never advances org B's due run", async () => {
    const orgB = (await companies.add("Demo Org B")).id;
    const contactB = (
      await admin.query(
        `insert into contacts (org_id, first_name) values ($1, 'Ben') returning id`,
        [orgB],
      )
    ).rows[0].id;
    const wfB = (
      await admin.query(
        `insert into workflows (org_id, key, version, status, definition)
         values ($1, 'demo-qual', 1, 'active', $2::jsonb) returning id`,
        [orgB, JSON.stringify(DEMO_WF)],
      )
    ).rows[0].id;
    const runB = (
      await admin.query(
        `insert into workflow_runs
           (org_id, workflow_id, contact_id, status, current_step, state, wake_at, attempts)
         values ($1, $2, $3, 'pending', 'qualify_call', $4::jsonb, now(), '{}'::jsonb) returning id`,
        [orgB, wfB, contactB, JSON.stringify({ contactId: contactB })],
      )
    ).rows[0].id;

    await runDemo("site_visit_agreed"); // demo drives ONLY org A

    const rb = await admin.query(
      `select status, current_step, attempts from workflow_runs where id = $1`,
      [runB],
    );
    expect(rb.rows[0].current_step).toBe("qualify_call"); // untouched
    expect(rb.rows[0].status).toBe("pending");
    expect(rb.rows[0].attempts.voice ?? []).toEqual([]); // never processed
    const jobsB = await appPool.query(
      `select count(*)::int n from pgboss.job where data ->> 'runId' = $1`,
      [runB],
    );
    expect(jobsB.rows[0].n).toBe(0); // no place_call enqueued for org B
  });
});

// A copy of the seeded qualification definition (from supabase/seeds/real_estate.sql; Slice 3's
// demo item replaces such copies with the sequence a real company gets — entry qualify_call, the retry/whatsapp/recall path, the `route`
// BRANCH, and the book/handoff/callback tool steps). Unlike DEMO_WF, the call step routes
// on.completed → `route`, and the BRANCH then routes onDisposition. This is the definition
// `bun run demo` faces against a real seeded org, so the acceptance suite MUST prove the golden
// path through it — not only through the simplified DEMO_WF (lessons.md: "a green test proved
// nothing twice — the fixture encoded a false world").
const SEEDED_QUAL_WF = {
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
      on: { completed: "route", no_answer: "end", busy: "end", failed: "end" },
    },
    route: {
      kind: "branch",
      onDisposition: {
        site_visit_agreed: "book",
        interested: "handoff_task",
        callback: "callback_task",
        dnc: "end",
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
    handoff_task: {
      kind: "tool",
      tool: "create_task",
      args: {
        kind: "handoff",
        title: "Hand a high-intent buyer to a human closer",
      },
      then: "end",
    },
    callback_task: {
      kind: "tool",
      tool: "create_task",
      args: {
        kind: "callback",
        title: "Call back the buyer about the site visit",
      },
      then: "end",
    },
    end: { kind: "end" },
  },
};

describe("demo driver — the seeded qualification workflow", () => {
  it("[seeded def] completed → route → site_visit_agreed → book yields a booking, same outcomes as the golden path", async () => {
    // Seed the exact real_estate.sql `qualification` definition as ACTIVE and enroll a demo run into
    // IT (not DEMO_WF). The call resolves the qualified disposition; the run must WALK
    // qualify_call → route(branch) → book(tool) and complete with a site_visit_booked outcome.
    //
    // DO NOT WEAKEN: this once failed, because the business disposition did not survive to `route`
    // (place-call.ts folds ONE state.lastDisposition, and the scheduler's drive() cleared it when
    // advancing out of a step), so the run fell through onDisposition["*"] → end and never booked.
    // This assertion is the spec for `bun run demo` against a genuine seeded org.
    const seededWfId = (
      await admin.query(
        `insert into workflows (org_id, key, version, status, definition)
         values ($1, 'qualification', 1, 'active', $2::jsonb) returning id`,
        [orgId, JSON.stringify(SEEDED_QUAL_WF)],
      )
    ).rows[0].id;

    const { result } = await runDemo("site_visit_agreed", {
      workflowId: seededWfId,
    });

    // same terminal assertions as the golden path
    expect(result.terminalStatus).toBe("completed");
    const run = await admin.query(
      `select status from workflow_runs where id = $1`,
      [result.runId],
    );
    expect(run.rows[0]?.status).toBe("completed");

    // the book branch's side effect must exist — the run reached `book`, not `route`→"*"→end
    const outcome = await admin.query(
      `select id from outcomes where org_id = $1 and contact_id = $2 and kind = 'site_visit_booked'`,
      [orgId, result.contactId],
    );
    expect(outcome.rows.length).toBe(1);
  });
});
