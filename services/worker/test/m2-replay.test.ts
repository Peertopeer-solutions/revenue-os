// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step field (data, not a
// thenable) in the workflow definition JSON, e.g. { kind:"wait", for:"PT2H", then:"…" } — the same
// suppression scheduler.test.ts / handlers.test.ts carry. The interpreter reads step.then.
//
// THE MULTI-DAY REPLAY (once the program's acceptance gate). A multi-day lifecycle —
//   call_1 → no_answer → (wait 2h) → WhatsApp → (wait_until 11:00 next day) → call_2 → BOOKED
// replayed DETERMINISTICALLY on a SimClock with synthetic providers (FakeVoice/FakeWa/fake-LLM):
// no real telephony, no real waits, no ANTHROPIC key. The drive is the real spine end-to-end —
// startRun + scheduler.tick + the job handlers, dispatched directly (not boss.work) so time is
// controlled. Real local database (Postgres + pg-boss's installed schema + FOR UPDATE SKIP LOCKED),
// so it runs with the local stack's settings (`bun run gate`, CI). Each `it` checks one assertion
// of the replay.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import { buildCatalog, type LlmTurn } from "@revenue-os/harness";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { OPTED_IN } from "../../../tests/opted-in";
import { testCompanies } from "../../../tests/test-companies";
import {
  handlePlaceCall,
  type PlaceCallDeps,
  type PlaceCallJob,
} from "../src/handlers/place-call";
import {
  handleSendWa,
  type SendWaDeps,
  type SendWaJob,
} from "../src/handlers/send-wa";
import { startRun } from "../src/runs";
import { tick } from "../src/scheduler";
import {
  type GuardCall,
  makeFakeVoice,
  makeFakeWa,
  makeGuardSpy,
  makeScriptedLlm,
} from "./fixtures/fake-channels";
import { SimClock } from "./fixtures/sim-clock";

// app_service (RLS-bound) = the role the handlers connect as through withOrg — exactly production —
// and the owner of pg-boss's tables, so it also does the pgboss.job reads/deletes the drive needs.
// admin (superuser, BYPASSRLS) = seeds + assertions.
const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = createPool(DB_URL);
const boss = new PgBoss({
  connectionString: DB_URL,
  schema: "pgboss",
  createSchema: false,
});
const QUEUES = ["place_call", "send_wa"];

// A fixed FAR-FUTURE anchor: 2030-06-03T04:30Z = 10:00 IST. Daytime (outside the seeded 21:00–07:00
// quiet window); India has no DST, so every derived instant is exact. Far future so the pending run
// (startRun stamps wake_at = now()) is due the moment the sim clock is set here.
const START = "2030-06-03T04:30:00.000Z";
const TZ = "Asia/Kolkata";
const clock = new SimClock(START);

// The replay's workflow. DESIGN DECISION:
// call_2 routes completed → end DIRECTLY, with NO separate `book` tool step. The site visit is
// booked DURING call_2's turn by the closer calling book_appointment (that tool writes BOTH the
// appointment AND the attributed outcome). A separate write_outcome `book` step would double the
// outcome, so the faithful design omits it.
const M2_WF = {
  entry: "call_1",
  steps: {
    call_1: {
      kind: "call",
      agent: "closer",
      on: { no_answer: "wait_2h", completed: "end" },
    },
    wait_2h: { kind: "wait", for: "PT2H", then: "wa" },
    wa: { kind: "whatsapp", template: "followup", then: "wait_11" },
    wait_11: { kind: "wait_until", localTime: "11:00", then: "call_2" },
    call_2: {
      kind: "call",
      agent: "closer",
      on: { completed: "end", no_answer: "giveup" },
    },
    giveup: { kind: "end" },
    end: { kind: "end" },
  },
};

// A minimal one-call workflow for the exactly-once / cross-tenant cases (fresh runs, own singletons).
const CALL_WF = {
  entry: "c",
  steps: {
    c: {
      kind: "call",
      agent: "closer",
      on: { completed: "end", no_answer: "end" },
    },
    end: { kind: "end" },
  },
};

const companies = testCompanies(admin, appPool);
// captured by the beforeAll drive; the assertion `it`s read these
let orgId = "";
let contactId = "";
let m2RunId = "";
let guardCalls: GuardCall[] = [];
let voicePlaceCount = 0;
let waSendCount = 0;

let wfSeq = 0;
async function seedWorkflow(def: unknown, org = orgId): Promise<string> {
  wfSeq += 1;
  const r = await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [org, `m2wf-${Date.now()}-${wfSeq}`, JSON.stringify(def)],
  );
  return r.rows[0].id;
}

async function seedRun(
  workflowId: string,
  opts: { org?: string; contact?: string; wakeAt?: Date },
): Promise<string> {
  const r = await admin.query(
    `insert into workflow_runs
       (org_id, workflow_id, contact_id, status, current_step, state, wake_at, attempts)
     values ($1, $2, $3, 'pending', 'c', $4::jsonb, $5, '{}'::jsonb) returning id`,
    [
      opts.org ?? orgId,
      workflowId,
      opts.contact ?? contactId,
      JSON.stringify({ contactId: opts.contact ?? contactId }),
      opts.wakeAt ?? new Date(),
    ],
  );
  return r.rows[0].id;
}

async function getRun(id: string) {
  const r = await admin.query(
    `select status, current_step, state, attempts, wake_at, completed_at
       from workflow_runs where id = $1`,
    [id],
  );
  return r.rows[0];
}

/** Every pgboss.job row for a singleton_key (the scheduler's dedup key runId:step:idx). */
async function jobsFor(singletonKey: string) {
  const r = await appPool.query(
    `select name, data, singleton_key from pgboss.job where singleton_key = $1`,
    [singletonKey],
  );
  return r.rows;
}

/**
 * The deterministic drive: tick → dispatch the enqueued handlers directly → advance the clock to the
 * run's next wake_at → repeat, until the run completes. This is the production loop with pg-boss's
 * worker and its real waits removed: enqueue still lands in pgboss.job_common (enqueueJob in src/scheduler.ts), but
 * WE pull the due job and invoke handlePlaceCall / handleSendWa in-line so time never actually
 * passes. place_call parks (wake_at NULL) then its handler RE-ARMS to clock.now(); a wait/wait_until
 * parks at a FUTURE wake_at we jump the clock to. No wake_at is ever hand-edited.
 */
async function driveToCompletion(
  runId: string,
  placeDeps: PlaceCallDeps,
  sendDeps: SendWaDeps,
): Promise<void> {
  for (let iter = 0; iter < 40; iter++) {
    await tick(appPool, orgId, { now: clock.now() });

    const jobs = await appPool.query(
      `select id, name, data from pgboss.job
        where data ->> 'runId' = $1 and state = 'created' order by created_on`,
      [runId],
    );
    for (const job of jobs.rows) {
      if (job.name === "place_call") {
        await handlePlaceCall(placeDeps, job.data as PlaceCallJob);
      } else if (job.name === "send_wa") {
        await handleSendWa(sendDeps, job.data as SendWaJob);
      }
      // consume the job so the next iteration's tick/read doesn't re-dispatch it
      await appPool.query(`delete from pgboss.job where id = $1`, [job.id]);
    }

    const run = await getRun(runId);
    if (run.status === "completed" || run.status === "failed") return;
    if (run.wake_at) {
      const w = new Date(run.wake_at).getTime();
      if (w > clock.now().getTime()) clock.set(new Date(w)); // jump to the next due instant
    } else if (jobs.rows.length === 0) {
      throw new Error(
        `replay drive stalled at step=${run.current_step} status=${run.status}`,
      );
    }
  }
  throw new Error(
    "replay drive exceeded its 40-iteration budget without completing",
  );
}

beforeAll(async () => {
  // pg-boss installs pgboss.* at start(); createQueue makes the LIST partition the raw enqueue
  // FK-needs.
  await boss.start();
  for (const q of QUEUES) {
    try {
      await boss.createQueue(q, { policy: "short" });
    } catch {
      // idempotent across reruns: the queue partition already exists
    }
  }

  // --- seed one org: contact (+ phone & whatsapp E.164 identities), an ACTIVE closer agent that
  // may book_appointment, benign guardrail policies, and the ACTIVE replay workflow ----------------
  orgId = (await companies.add("Replay Org")).id;
  contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name, timezone, consent) values ($1, 'Asha', $2, $3) returning id`,
      [orgId, TZ, OPTED_IN],
    )
  ).rows[0].id;
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'phone', '+919876500001', true),
            ($1, $2, 'whatsapp', '+919876500001', false)`,
    [orgId, contactId],
  );
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, 'closer', 1, 'active', 'claude-fake', 'You are a closer.', '{book_appointment}')`,
    [orgId],
  );
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
  const wfId = await seedWorkflow(M2_WF);

  // startRun is the faithful entry (status pending, current_step = entry). It stamps wake_at = now()
  // (real clock); re-point it to the sim START so the very first tick finds it due — the sim clock,
  // not the wall clock, owns time from here (deterministic regardless of when CI runs).
  m2RunId = await startRun(appPool, orgId, {
    workflowId: wfId,
    contactId,
    state: { timezone: TZ },
  });
  await admin.query(
    `update workflow_runs set wake_at = $2, status = 'pending' where id = $1`,
    [m2RunId, START],
  );
  clock.set(START);

  // --- synthetic providers + the guard spy, wired EXACTLY like services/worker/src/jobs.ts boot,
  // stubs swapped for fakes. The fake LLM: call_1 = a text turn (no booking), call_2 = book then a
  // closing text (runTurn books ONCE, then the tool-less turn ends the loop). ------------------------
  const bookTurn: LlmTurn = {
    toolCalls: [
      {
        name: "book_appointment",
        args: {
          contactId,
          startsAt: "2030-06-04T05:30:00.000Z",
          endsAt: "2030-06-04T06:00:00.000Z",
          timezone: TZ,
        },
      },
    ],
    usage: { in: 40, out: 20 },
  };
  const fakeLlm = makeScriptedLlm([
    { text: "Ringing — no pickup.", usage: { in: 8, out: 2 } },
    bookTurn,
    { text: "Great, your site visit is booked!", usage: { in: 12, out: 6 } },
  ]);
  const fakeVoice = makeFakeVoice(["no_answer", "completed"]);
  const fakeWa = makeFakeWa();
  const guardSpy = makeGuardSpy(clock);
  const placeDeps: PlaceCallDeps = {
    pool: appPool,
    guard: guardSpy.fn,
    sender: fakeVoice,
    provider: fakeLlm,
    registry: buildCatalog({ send: async () => ({ ok: true }) }),
    outcome: fakeVoice.outcome,
    now: () => clock.now(),
  };
  const sendDeps: SendWaDeps = {
    pool: appPool,
    guard: guardSpy.fn,
    sender: fakeWa,
    now: () => clock.now(),
  };

  await driveToCompletion(m2RunId, placeDeps, sendDeps);
  guardCalls = guardSpy.calls;
  voicePlaceCount = fakeVoice.placeCount;
  waSendCount = fakeWa.sendCount;
}, 60_000);

afterAll(async () => {
  await companies.cleanup();
  await boss.stop({ graceful: true, timeout: 5_000 });
  await appPool.end();
  await admin.end();
});

const HOUR = 3_600_000;

describe("multi-day replay — the lifecycle proof", () => {
  it("[assert 1] the run COMPLETES with attempts {voice:[2], whatsapp:[1]} spanning days", async () => {
    const run = await getRun(m2RunId);
    expect(run.status).toBe("completed");
    expect(run.completed_at).not.toBeNull();

    // per-channel attempt LOGS (ISO arrays, not counters): two calls, one whatsapp
    const voice = run.attempts.voice ?? [];
    const whatsapp = run.attempts.whatsapp ?? [];
    expect(voice.length).toBe(2);
    expect(whatsapp.length).toBe(1);

    // the temporal SHAPE is the milestone: whatsapp fires 2h after call_1 (the `wait PT2H`), and
    // call_2 lands the NEXT day (the `wait_until 11:00` crossed midnight IST) — a real multi-day run.
    const t0 = new Date(voice[0]).getTime();
    const t1 = new Date(voice[1]).getTime();
    const w0 = new Date(whatsapp[0]).getTime();
    expect(w0 - t0).toBe(2 * HOUR); // whatsapp exactly 2h after the first call
    expect(t1 - t0).toBeGreaterThanOrEqual(24 * HOUR); // re-call on a later day
  });

  it("[assert 1] a completed run rests at current_step='end'", async () => {
    // A `call`→`end` route walks the terminal `end` step, and the scheduler lands current_step on
    // that terminal step at completion, not on the pre-terminal 'call_2'.
    const run = await getRun(m2RunId);
    expect(run.current_step).toBe("end");
  });

  it("[assert 2] two VOICE conversations, each a distinct provider_ref; messages strictly monotonic by seq", async () => {
    const convos = await admin.query(
      `select id, channel, provider, provider_ref from conversations
        where workflow_run_id = $1 order by created_at`,
      [m2RunId],
    );
    const voice = convos.rows.filter((c) => c.channel === "voice");
    const wa = convos.rows.filter((c) => c.channel === "whatsapp");

    // the two CALLS are two conversations with DISTINCT, non-null provider_refs (out-of-order-safe
    // upsert-by-provider_ref, unique index convo_provider_ref_uq). send_wa opens its own conversation too
    // (provider_ref NULL — the wamid rides the message), so the run holds 3 conversations total.
    expect(voice.length).toBe(2);
    expect(wa.length).toBe(1);
    const refs = voice.map((c) => c.provider_ref);
    expect(refs.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
    expect(new Set(refs).size).toBe(2); // distinct

    for (const convo of convos.rows) {
      const msgs = await admin.query(
        `select seq from messages where conversation_id = $1 order by seq`,
        [convo.id],
      );
      expect(msgs.rows.length).toBeGreaterThan(0);
      for (let i = 1; i < msgs.rows.length; i++) {
        expect(msgs.rows[i].seq).toBeGreaterThan(msgs.rows[i - 1].seq); // strictly monotonic
      }
    }
  });

  it("[assert 3] the booking wrote exactly ONE appointment + ONE site_visit_booked outcome, linked", async () => {
    // The closer booked DURING call_2 via the book_appointment tool (the design decision above) — which writes BOTH
    // the appointment and the attributed outcome atomically, on the run's contact.
    const appts = await admin.query(
      `select id from appointments where org_id = $1 and contact_id = $2`,
      [orgId, contactId],
    );
    expect(appts.rows.length).toBe(1);

    const outs = await admin.query(
      `select id, appointment_id, kind from outcomes
        where org_id = $1 and contact_id = $2 and kind = 'site_visit_booked'`,
      [orgId, contactId],
    );
    expect(outs.rows.length).toBe(1);
    expect(outs.rows[0].appointment_id).toBe(appts.rows[0].id); // outcome ↔ appointment linked
  });

  it("[assert 3] the site_visit_booked outcome is ATTRIBUTED to the run", async () => {
    // The outcomes table's whole point is attribution (AGENTS.md → Conventions: every business
    // result is an outcomes row with attribution), so the booking outcome must trace to THIS run,
    // through its conversation_id or its workflow_run_id, not only to the contact and appointment.
    const attributed = await admin.query(
      `select o.id from outcomes o
        where o.org_id = $1 and o.kind = 'site_visit_booked'
          and ( o.workflow_run_id = $2
             or o.conversation_id in (select id from conversations where workflow_run_id = $2) )`,
      [orgId, m2RunId],
    );
    expect(attributed.rows.length).toBe(1);
  });

  it("[assert 4] the call turns and the wa send are METERED to usage_events", async () => {
    const usage = await admin.query(
      `select kind, count(*)::int n from usage_events
        where conversation_id in (select id from conversations where workflow_run_id = $1)
        group by kind`,
      [m2RunId],
    );
    const byKind = new Map<string, number>(
      usage.rows.map((r) => [r.kind as string, r.n as number]),
    );
    expect(byKind.get("llm") ?? 0).toBeGreaterThanOrEqual(2); // both call turns metered
    expect(byKind.get("wa_message") ?? 0).toBe(1); // the whatsapp send metered
  });

  it("[assert 5] EVERY send passed guard() first — no send bypassed the doorway", async () => {
    // guardCalls is the spy's complete ledger: the real guard ran (seeded quiet_hours/attempt_caps/
    // dnc pipeline at SIM time) before every doorway send. No blocking verdict, and the guard-call
    // count matches the sender-invocation count per channel ⇒ no send reached a provider un-guarded.
    expect(guardCalls.every((c) => c.ok)).toBe(true);
    const voiceGuards = guardCalls.filter((c) => c.channel === "voice").length;
    const waGuards = guardCalls.filter((c) => c.channel === "whatsapp").length;
    expect(voiceGuards).toBe(2);
    expect(waGuards).toBe(1);
    expect(voiceGuards).toBe(voicePlaceCount); // one guard per actual voice send
    expect(waGuards).toBe(waSendCount); // one guard per actual wa send
  });
});

describe("multi-day replay — exactly-once + tenancy", () => {
  it("[assert 6a] a duplicate tick over a due call step enqueues EXACTLY ONE job (singleton_key)", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {});

    await tick(appPool, orgId, { now: new Date() }); // tick 1 → enqueue place_call (runId:c:0), park
    // re-poll the still-parked call step (a retry): re-arm and tick again — the duplicate enqueue
    // must conflict on singleton_key and no-op, NOT throw and NOT double.
    // an hour in the PAST, so it is due even if the database clock runs ahead of the host's
    await admin.query(
      `update workflow_runs set wake_at = now() - interval '1 hour', status = 'waiting' where id = $1`,
      [runId],
    );
    await expect(
      tick(appPool, orgId, { now: new Date() }),
    ).resolves.toBeDefined();

    expect((await jobsFor(`${runId}:c:0`)).length).toBe(1); // exactly one
  });

  it("[assert 6b] a duplicate place_call DELIVERY is a no-op: one send, one conversation, one fold", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {});
    // seedRun parks at 'c' (pending). A place_call handler expects status 'waiting' — mark it so the
    // reload's own staleness guards (not the seed) decide, mirroring a real post-enqueue delivery.
    await admin.query(
      `update workflow_runs set status = 'waiting' where id = $1`,
      [runId],
    );
    const fakeVoice = makeFakeVoice(["no_answer"]);
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: fakeVoice,
      provider: makeScriptedLlm([
        { text: "no pickup", usage: { in: 3, out: 1 } },
      ]),
      registry: buildCatalog({ send: async () => ({ ok: true }) }),
      outcome: fakeVoice.outcome,
    };
    const job: PlaceCallJob = {
      orgId,
      runId,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    };

    await handlePlaceCall(deps, job);
    await handlePlaceCall(deps, job); // re-delivery of the same job

    expect(fakeVoice.placeCount).toBe(1); // sent exactly once (2nd reload NO-OPs on the folded state)
    const convos = await admin.query(
      `select count(*)::int n from conversations where workflow_run_id = $1`,
      [runId],
    );
    expect(convos.rows[0].n).toBe(1);
    expect((await getRun(runId)).state.lastDisposition).toBe("no_answer"); // folded once
  });

  it("[cross-tenant denial] tick(org A) never advances org B's due run (RLS)", async () => {
    const orgB = (await companies.add("Replay Org B")).id;
    const contactB = (
      await admin.query(
        `insert into contacts (org_id, first_name) values ($1, 'Ben') returning id`,
        [orgB],
      )
    ).rows[0].id;
    const wfB = await seedWorkflow(CALL_WF, orgB);
    const runB = await seedRun(wfB, { org: orgB, contact: contactB });

    await tick(appPool, orgId, { now: new Date() }); // tick scoped to org A

    expect((await jobsFor(`${runB}:c:0`)).length).toBe(0); // org B's run untouched
    const rb = await getRun(runB);
    expect(rb.current_step).toBe("c");
    expect(rb.attempts.voice ?? []).toEqual([]); // no attempt recorded — never processed
  });
});
