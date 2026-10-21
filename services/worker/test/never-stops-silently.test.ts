// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step field (data, not a thenable) in the
// workflow definition JSON, e.g. { kind:"wait", for:"P1D", then:"c" } — the same suppression scheduler.test.ts carries.
// A lead's sequence never stops silently (ROADMAP.md, Slice 1): a call that can't go ahead (the guardrails hold it back,
// no active agent, its job failing) has the lead tried again later or handed to a person with the reason saved, and a
// call still waiting for its result an hour after it was queued is picked up again by the scheduler, which never
// places it twice. Against the real local database and pg-boss's job table: the scheduler ticks (src/scheduler.ts), the
// place_call handler runs as its job would (src/handlers/place-call.ts), and a job's end (failed every try, its dead
// letter too, or still running) is the state pg-boss leaves its row in.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomInt, randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import { ToolRegistry, type Verdict } from "@revenue-os/harness";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { putLive } from "../../../tests/live-version";
import { OPTED_IN } from "../../../tests/opted-in";
import { testCompanies } from "../../../tests/test-companies";
import {
  handlePlaceCall,
  type PlaceCallDeps,
  type PlaceCallJob,
} from "../src/handlers/place-call";
import { tick } from "../src/scheduler";
import { processVapiEvents } from "../src/vapi/process";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
// pg-boss installs its tables at start() (migration 015 ships only the schema); the scheduler queues each call on the
// place_call queue, whose dead letter is call.post.
const boss = new PgBoss({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
  schema: "pgboss",
  createSchema: false,
});
const companies = testCompanies(admin, appPool);
let orgId = "";
const HOUR = 3_600_000;

/** c → (no answer) → wait a day → c2; answered → end. */
const CALL_WF = {
  entry: "c",
  steps: {
    c: {
      kind: "call",
      agent: "closer",
      on: { completed: "end", no_answer: "w" },
    },
    w: { kind: "wait", for: "P1D", then: "c2" },
    c2: {
      kind: "call",
      agent: "closer",
      on: { completed: "end", no_answer: "end" },
    },
    end: { kind: "end" },
  },
};

/** A lead with a number and a WhatsApp opt-in, in a run of CALL_WF (or `def`) due now at its call step. */
async function leadInSequence(def: unknown = CALL_WF) {
  const contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name, consent) values ($1, 'Meera', $2::jsonb) returning id`,
      [orgId, OPTED_IN],
    )
  ).rows[0].id as string;
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'phone', $3, true)`,
    [orgId, contactId, `+9197${randomInt(10_000_000, 99_999_999)}`],
  );
  const wf = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', $3::jsonb) returning id`,
      [orgId, `never-silent-${randomUUID()}`, JSON.stringify(def)],
    )
  ).rows[0].id;
  const runId = (
    await admin.query(
      `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state, wake_at, attempts)
       values ($1, $2, $3, 'pending', $4, $5::jsonb, $6, '{}'::jsonb) returning id`,
      [
        orgId,
        wf,
        contactId,
        (def as { entry: string }).entry,
        JSON.stringify({ contactId }),
        new Date(Date.now() - HOUR),
      ],
    )
  ).rows[0].id as string;
  return { contactId, runId };
}

async function getRun(id: string) {
  return (
    await admin.query(
      `select status, current_step, state, attempts, wake_at, last_error from workflow_runs where id = $1`,
      [id],
    )
  ).rows[0];
}

/** The place_call jobs pg-boss holds for a run, oldest first. */
async function callJobs(runId: string) {
  return (
    await appPool.query<{ id: string; state: string; data: PlaceCallJob }>(
      `select id, state, data from pgboss.job_common
        where name = 'place_call' and data ->> 'runId' = $1 order by created_on`,
      [runId],
    )
  ).rows;
}

/** A job's end as pg-boss leaves its row: every try used up ('failed'), or still at work ('active', 'retry'). */
const jobEnds = (jobId: string, state: string) =>
  appPool.query(`update pgboss.job_common set state = $2 where id = $1`, [
    jobId,
    state,
  ]);

/** The dead letter pg-boss queues for a call job that failed every try, carrying the job's data, left as `state`. */
const deadLetter = (job: PlaceCallJob, state: string) =>
  appPool.query(
    `insert into pgboss.job_common (name, data, state, policy) values ('call.post', $1::jsonb, $2, 'standard')`,
    [JSON.stringify(job), state],
  );

async function reviewTasks(runId: string) {
  return (
    await admin.query(
      `select contact_id, title, payload ->> 'reason' as reason from tasks where workflow_run_id = $1 and kind = 'review'`,
      [runId],
    )
  ).rows;
}

async function sends(runId: string) {
  return (
    await admin.query(
      `select status, reason from sends where workflow_run_id = $1 order by created_at`,
      [runId],
    )
  ).rows;
}

/** The place_call handler's ports: the guard answers `verdict`, the dialer counts its calls, the outcome `outcome`. */
function deps(
  verdict: Verdict,
  at: Date,
  outcome: () => Promise<string> = async () => "completed",
): PlaceCallDeps & { dialled: () => number; asked: () => number } {
  let dialled = 0;
  let asked = 0;
  return {
    pool: appPool,
    guard: async () => {
      asked += 1;
      return verdict;
    },
    sender: {
      place: async () => {
        dialled += 1;
        return { providerRef: `vapi-silent-${randomUUID()}` };
      },
    },
    provider: {
      complete: async () => ({ text: "Namaste.", usage: { in: 1, out: 1 } }),
    },
    registry: new ToolRegistry(),
    outcome: async () => outcome(),
    now: () => at,
    dialled: () => dialled,
    asked: () => asked,
  };
}

/** Ticks the run's call step at `at`: its call job queued and the run parked on it. That job. */
async function parkOnCall(runId: string, at: Date) {
  await tick(appPool, orgId, { now: at });
  const jobs = await callJobs(runId);
  expect(jobs).toHaveLength(1);
  return jobs[0];
}

/** A run parked on its call at t0, the call placed by its job, whose outcome never came (the job failed). */
async function placedWithoutResult() {
  const lead = await leadInSequence();
  const t0 = new Date();
  const job = await parkOnCall(lead.runId, t0);
  const call = deps({ ok: true }, t0, async () => {
    throw new Error("no outcome");
  });
  await expect(handlePlaceCall(call, job.data)).rejects.toThrow("no outcome");
  expect(call.dialled()).toBe(1);
  return { ...lead, t0, job };
}

beforeAll(async () => {
  await boss.start();
  await boss.createQueue("place_call", { policy: "short" });
  await boss.createQueue("call.post");
  orgId = (await companies.add("Never silent")).id;
  await putLive(admin, orgId, { key: "closer", systemPrompt: "You call." });
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await boss.stop({ graceful: true, timeout: 5_000 });
  await appPool.end();
  await admin.end();
});

describe("a call that can't go ahead never stops the lead's sequence silently", () => {
  it("outside the calling hours the call is tried again an hour later, the held-back try is not counted as an attempt, and the next try dials once", async () => {
    const { runId } = await leadInSequence();
    const t0 = new Date();
    const first = await parkOnCall(runId, t0);
    expect((await getRun(runId)).attempts.voice).toHaveLength(1);

    const night = deps({ ok: false, reason: "quiet_hours" }, t0);
    await handlePlaceCall(night, first.data);
    await jobEnds(first.id, "completed");

    const held = await getRun(runId);
    expect(night.dialled()).toBe(0);
    expect(held).toMatchObject({ status: "waiting", current_step: "c" });
    expect(held.state.callSendId).toBeUndefined(); // waits for no call now: the next tick places a fresh one
    expect(new Date(held.wake_at).getTime()).toBe(t0.getTime() + HOUR);
    expect(held.last_error).toBe(
      `call held back: outside the calling hours, tried again at ${new Date(t0.getTime() + HOUR).toISOString()}`,
    );
    expect(held.attempts.voice).toEqual([]); // the lead was never rung
    expect(await sends(runId)).toEqual([
      { status: "blocked", reason: "quiet_hours" },
    ]);
    expect(await reviewTasks(runId)).toEqual([]);

    await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR / 2) }); // not yet
    expect(await callJobs(runId)).toHaveLength(1);
    const t1 = new Date(t0.getTime() + HOUR);
    await tick(appPool, orgId, { now: t1 });
    const jobs = await callJobs(runId);
    expect(jobs).toHaveLength(2);
    const second = jobs[1];
    expect(second.data.sendId).not.toBe(first.data.sendId);
    const morning = deps({ ok: true }, t1, async () => "completed");
    await handlePlaceCall(morning, second.data);
    expect(morning.dialled()).toBe(1);
    await tick(appPool, orgId, { now: t1 });
    expect(await getRun(runId)).toMatchObject({
      status: "completed",
      attempts: { voice: [expect.any(String)] },
    });
  });

  it("a lead on the do-not-call list, or past the company's call limit, is handed to a person with the reason, once however often the job runs", async () => {
    for (const [reason, title, why] of [
      [
        "dnc",
        "Call not placed — the lead is on the do-not-call list",
        "the lead is on the do-not-call list",
      ],
      [
        "attempt_cap",
        "Call not placed — the lead has had the most calls the company allows for now",
        "the lead has had the most calls the company allows for now",
      ],
    ] as const) {
      const { runId, contactId } = await leadInSequence();
      const t0 = new Date();
      const job = await parkOnCall(runId, t0);
      const refused = deps({ ok: false, reason }, t0);
      await handlePlaceCall(refused, job.data);
      await handlePlaceCall(refused, job.data); // delivered again

      expect(refused.dialled()).toBe(0);
      expect(refused.asked()).toBe(1);
      expect(await getRun(runId)).toMatchObject({
        status: "failed",
        last_error: `the guardrails refused the call: ${why}`,
      });
      expect(await reviewTasks(runId)).toEqual([
        { contact_id: contactId, title, reason },
      ]);
    }
  });

  it("with no active agent for the call, nothing is dialled and the lead is handed to a person with the reason", async () => {
    const { runId, contactId } = await leadInSequence({
      entry: "c",
      steps: {
        c: { kind: "call", agent: "nobody", on: { completed: "end" } },
        end: { kind: "end" },
      },
    });
    const t0 = new Date();
    const job = await parkOnCall(runId, t0);
    const call = deps({ ok: true }, t0);
    await handlePlaceCall(call, job.data);

    expect(call.dialled()).toBe(0);
    expect(call.asked()).toBe(0);
    expect(await getRun(runId)).toMatchObject({
      status: "failed",
      last_error:
        'no active agent "nobody" to place the call or record its result',
    });
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "Call stopped — no active agent",
        reason: "no_agent",
      },
    ]);
  });

  it("a held-back call whose job failed before acting on it is acted on when the job runs again, without asking the guardrails twice", async () => {
    const { runId } = await leadInSequence();
    const t0 = new Date();
    const job = await parkOnCall(runId, t0);
    // the job's first run saved the call as held back, then failed before it re-scheduled the lead
    await admin.query(
      `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, payload, status, reason)
       values ($1, $2, 'voice', $3, $4, '{}'::jsonb, 'blocked', 'quiet_hours')`,
      [
        orgId,
        `place_call:${runId}:${job.data.sendId}`,
        job.data.action.contactId,
        runId,
      ],
    );
    const again = deps({ ok: true }, t0);
    await handlePlaceCall(again, job.data);

    expect(again.asked()).toBe(0);
    expect(again.dialled()).toBe(0);
    const run = await getRun(runId);
    expect(run).toMatchObject({ status: "waiting", current_step: "c" });
    expect(new Date(run.wake_at).getTime()).toBe(t0.getTime() + HOUR);
    expect(await reviewTasks(runId)).toEqual([]);
  });
});

describe("a held-back call leaves a run that has moved on as it is", () => {
  // behaviour already on main: main acts on no held-back call at all; this pins that acting on one never touches a run that has moved on
  it("a run a person ended while the guardrails were answering is not woken or handed over again", async () => {
    for (const reason of ["quiet_hours", "dnc"] as const) {
      const { runId } = await leadInSequence();
      const t0 = new Date();
      const job = await parkOnCall(runId, t0);
      const call = deps({ ok: true }, t0);
      call.guard = async () => {
        await admin.query(
          `update workflow_runs set status = 'canceled', last_error = 'ended by a person' where id = $1`,
          [runId],
        );
        return { ok: false, reason };
      };
      await handlePlaceCall(call, job.data);

      const run = await getRun(runId);
      expect(run).toMatchObject({
        status: "canceled",
        last_error: "ended by a person",
      });
      expect(run.state.callSendId).toBe(job.data.sendId);
      expect(run.attempts.voice).toHaveLength(1);
      expect(await reviewTasks(runId)).toEqual([]);
    }
  });
});

describe("a call still waiting for its result an hour after it was queued is picked up again", () => {
  it("no result came and the job and its dead letter failed every try: the lead is handed to a person, and the call is never placed again", async () => {
    const { runId, contactId, t0, job } = await placedWithoutResult();
    await jobEnds(job.id, "failed");
    await deadLetter(job.data, "failed");
    expect(new Date((await getRun(runId)).wake_at).getTime()).toBe(
      t0.getTime() + HOUR,
    );

    await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR - 60_000) }); // a minute early: still waiting
    expect(await getRun(runId)).toMatchObject({
      status: "waiting",
      last_error: null,
    });
    await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR) });

    expect(await getRun(runId)).toMatchObject({
      status: "failed",
      last_error: "the call went out, but no result came within 60 minutes",
    });
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "This call went out, but no result came",
        reason: "no_result",
      },
    ]);
    expect(await callJobs(runId)).toHaveLength(1); // no second call job
    expect(await sends(runId)).toEqual([{ status: "sent", reason: null }]);
  });

  it("the call's result came through its own events: the result is folded and the sequence goes on, a voicemail routed as no answer", async () => {
    for (const [ended, step, status] of [
      ["customer-did-not-answer", "c2", "waiting"],
      ["voicemail", "c2", "waiting"],
      ["customer-ended-call", "end", "completed"],
    ] as const) {
      const { runId, t0, job } = await placedWithoutResult();
      await jobEnds(job.id, "failed");
      await deadLetter(job.data, "failed");
      const ref = (
        await admin.query(
          `select provider_ref from sends where workflow_run_id = $1`,
          [runId],
        )
      ).rows[0].provider_ref;
      await admin.query(
        `insert into webhook_events (org_id, provider, event_type, dedupe_key, payload)
         values ($1, 'vapi', 'end-of-call-report', $2, $3::jsonb)`,
        [
          orgId,
          `vapi:${ref}-end`,
          JSON.stringify({
            message: {
              type: "end-of-call-report",
              call: { id: ref },
              endedReason: ended,
            },
          }),
        ],
      );
      await processVapiEvents(appPool, orgId);

      await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR) });
      expect(await getRun(runId)).toMatchObject({
        status,
        current_step: step,
        last_error: null,
      });
      expect(await reviewTasks(runId)).toEqual([]);
      expect(await callJobs(runId)).toHaveLength(1);
    }
  });

  it("while the call's job is still running or retrying, or its dead letter is still queued, the run waits again and no second call job is queued", async () => {
    const { runId, t0, job } = await placedWithoutResult();
    let at = t0.getTime();
    for (const [state, letter] of [
      ["active", null],
      ["retry", null],
      ["failed", "created"],
    ] as const) {
      await jobEnds(job.id, state);
      if (letter) await deadLetter(job.data, letter);
      at += HOUR;
      await tick(appPool, orgId, { now: new Date(at) });
      const run = await getRun(runId);
      expect(run).toMatchObject({
        status: "waiting",
        current_step: "c",
        last_error: null,
      });
      expect(run.state.callSendId).toBe(job.data.sendId);
      expect(new Date(run.wake_at).getTime()).toBe(at + HOUR);
      expect(await callJobs(runId)).toHaveLength(1);
      expect(await reviewTasks(runId)).toEqual([]);
    }
  });

  it("the dialer's answer was never saved and the dead letter failed every try: the lead is handed to a person as unknown, never called again", async () => {
    const { runId, contactId } = await leadInSequence();
    const t0 = new Date();
    const job = await parkOnCall(runId, t0);
    await admin.query(
      `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, payload, status)
       values ($1, $2, 'voice', $3, $4, '{}'::jsonb, 'sending')`,
      [orgId, `place_call:${runId}:${job.data.sendId}`, contactId, runId],
    );
    await jobEnds(job.id, "failed");
    await deadLetter(job.data, "failed");

    await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR) });
    const why =
      "could not tell whether the provider took it: its job saved the call, then neither it nor its dead letter saved the dialer's answer";
    expect(await getRun(runId)).toMatchObject({
      status: "failed",
      last_error: why,
    });
    expect(await sends(runId)).toEqual([{ status: "unknown", reason: why }]);
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "Check whether this call went out before calling again",
        reason: why,
      },
    ]);
    expect(await callJobs(runId)).toHaveLength(1);
  });

  it("the call job failed every try before placing the call, and its dead letter too: the lead is handed to a person", async () => {
    const { runId, contactId } = await leadInSequence();
    const t0 = new Date();
    const job = await parkOnCall(runId, t0);
    await jobEnds(job.id, "failed");
    await deadLetter(job.data, "failed");

    await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR) });
    expect(await getRun(runId)).toMatchObject({
      status: "failed",
      last_error: "its call job ended without placing the call",
    });
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "Call not placed — its job stopped",
        reason: "job_stopped",
      },
    ]);
    expect(await callJobs(runId)).toHaveLength(1);
  });

  it("a held-back call left waiting (its job and dead letter failed before acting on it) is tried again an hour after the pickup", async () => {
    const { runId } = await leadInSequence();
    const t0 = new Date();
    const job = await parkOnCall(runId, t0);
    await admin.query(
      `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, payload, status, reason)
       values ($1, $2, 'voice', $3, $4, '{}'::jsonb, 'blocked', 'quiet_hours')`,
      [
        orgId,
        `place_call:${runId}:${job.data.sendId}`,
        job.data.action.contactId,
        runId,
      ],
    );
    await jobEnds(job.id, "failed");
    await deadLetter(job.data, "failed");

    const t1 = new Date(t0.getTime() + HOUR);
    await tick(appPool, orgId, { now: t1 });
    const run = await getRun(runId);
    expect(run).toMatchObject({ status: "waiting", current_step: "c" });
    expect(run.state.callSendId).toBeUndefined();
    expect(new Date(run.wake_at).getTime()).toBe(t1.getTime() + HOUR);
    expect(await reviewTasks(runId)).toEqual([]);
  });
});

describe("a sequence the scheduler can't drive hands its lead to a person", () => {
  it("a step that doesn't exist ends the run with the reason and a review task on the lead, once", async () => {
    const { runId, contactId } = await leadInSequence({
      entry: "c",
      steps: {
        c: { kind: "call", agent: "closer", on: { completed: "ghost" } },
      },
    });
    await admin.query(
      `update workflow_runs set state = state || '{"lastDisposition":"completed"}' where id = $1`,
      [runId],
    );
    await tick(appPool, orgId, { now: new Date() });

    expect(await getRun(runId)).toMatchObject({
      status: "failed",
      last_error: "unknown step: ghost",
    });
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "Sequence stopped — it could not go on",
        reason: "unknown step: ghost",
      },
    ]);
  });

  it("a sequence whose definition is invalid ends the run with the reason and a review task on the lead", async () => {
    const { runId, contactId } = await leadInSequence({
      steps: { c: { kind: "call" } },
    });
    await tick(appPool, orgId, { now: new Date() });

    const run = await getRun(runId);
    expect(run.status).toBe("failed");
    expect(run.last_error).toContain("entry");
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "Sequence stopped — it could not go on",
        reason: run.last_error,
      },
    ]);
  });
});

describe("the pickup reads only the company's own call results", () => {
  it("another company's finished call under the same call id is never folded into this company's run", async () => {
    const { runId, contactId, t0, job } = await placedWithoutResult();
    await jobEnds(job.id, "failed");
    await deadLetter(job.data, "failed");
    const ref = (
      await admin.query(
        `select provider_ref from sends where workflow_run_id = $1`,
        [runId],
      )
    ).rows[0].provider_ref;
    // a call id is unique only within a company: another company files a finished call under the same id
    const other = (await companies.add("Never silent, the other company")).id;
    await admin.query(
      `insert into webhook_events (org_id, provider, event_type, dedupe_key, payload)
       values ($1, 'vapi', 'end-of-call-report', $2, $3::jsonb)`,
      [
        other,
        `vapi:${ref}-end`,
        JSON.stringify({
          message: {
            type: "end-of-call-report",
            call: { id: ref },
            endedReason: "customer-ended-call",
          },
        }),
      ],
    );
    await processVapiEvents(appPool, other);

    await tick(appPool, orgId, { now: new Date(t0.getTime() + HOUR) });
    expect(await getRun(runId)).toMatchObject({
      status: "failed",
      current_step: "c",
      last_error: "the call went out, but no result came within 60 minutes",
    });
    expect(await reviewTasks(runId)).toEqual([
      {
        contact_id: contactId,
        title: "This call went out, but no result came",
        reason: "no_result",
      },
    ]);
    const theirs = await admin.query(
      `select org_id, status, workflow_run_id from conversations where provider_ref = $1 order by org_id = $2`,
      [ref, orgId],
    );
    expect(theirs.rows).toEqual([
      { org_id: other, status: "completed", workflow_run_id: null },
      { org_id: orgId, status: "active", workflow_run_id: runId },
    ]);
  });
});
