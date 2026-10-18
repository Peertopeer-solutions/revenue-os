// A call or WhatsApp message is never sent twice through the worker's real job runner: startJobs (services/worker/
// src/jobs.ts) on real pg-boss and the real local database, in a pg-boss schema of this test's own
// (fixtures/test-job-schema.ts), with pretend providers at its ports and a database pool that can be made to fail its
// next connection (fixtures/flaky-pool.ts). A job that fails after the provider took its send is run again by pg-boss
// with its queue's own retry settings, and that run hands the lead to a person instead of sending again; the same job
// queued twice sends once.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LlmProvider } from "@revenue-os/harness";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { testCompanies } from "../../../tests/test-companies";
import { startJobs, stopJobs } from "../src/jobs";
import { flakyPool } from "./fixtures/flaky-pool";
import { testJobSchema } from "./fixtures/test-job-schema";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const companies = testCompanies(admin);
const db = flakyPool(DB_URL);
let jobs: Awaited<ReturnType<typeof testJobSchema>>;
let queue: PgBoss; // queues jobs into this test's schema, as the scheduler queues them into the worker's
let orgId = "";
let workflowId = "";

// The pretend providers: each records the number it was asked to reach, and takes the database away right after it
// took a send to a number in `tripOn`.
const placed: string[] = [];
const messaged: string[] = [];
const tripOn = new Set<string>();
const provider: LlmProvider = {
  complete: async () => ({ text: "Namaste.", usage: { in: 1, out: 1 } }),
};

const CALL_WF = {
  entry: "c",
  steps: {
    c: { kind: "call", agent: "closer", on: { completed: "end" } },
    end: { kind: "end" },
  },
};

beforeAll(async () => {
  orgId = (await companies.add("Send Once Org")).id;
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, 'closer', 1, 'active', 'm', 'You are a scheduler.', '{}')`,
    [orgId],
  );
  workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', $3::jsonb) returning id`,
      [orgId, `send-once-${randomUUID()}`, JSON.stringify(CALL_WF)],
    )
  ).rows[0].id;
  jobs = await testJobSchema(admin);
  await startJobs(jobs.settings, {
    pool: db.pool,
    voice: {
      place: async ({ to }) => {
        placed.push(to);
        if (tripOn.has(to)) db.trip();
        return { providerRef: `vapi-once-${randomUUID()}` };
      },
    },
    wa: {
      send: async ({ to }) => {
        messaged.push(to);
        if (tripOn.has(to)) db.trip();
        return { providerRef: `wamid.once-${randomUUID()}` };
      },
    },
    outcome: async () => "completed",
    provider,
  });
  queue = new PgBoss({
    connectionString: DB_URL,
    schema: jobs.settings.schema,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  await queue.start();
}, 60_000);

afterAll(async () => {
  await stopJobs();
  await queue.stop({ graceful: false });
  await jobs.drop();
  await companies.cleanup();
  await db.pool.end();
  await admin.end();
});

/** A lead with a number of their own, and a run of theirs waiting at `step`. */
async function leadWithRun(step: string) {
  const number = `+9197${String(Math.random()).slice(2, 10)}`;
  const contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [orgId],
    )
  ).rows[0].id;
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', $3, true)`,
    [orgId, contactId, number],
  );
  const runId = (
    await admin.query(
      `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state)
       values ($1, $2, $3, 'waiting', $4, $5::jsonb) returning id`,
      [orgId, workflowId, contactId, step, JSON.stringify({ contactId })],
    )
  ).rows[0].id;
  return { number, contactId, runId };
}

/** Waits until each job has ended, and says how it ended and how often pg-boss retried it. */
async function ended(ids: (string | null)[]) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const r = await admin.query<{ state: string; retry_count: number }>(
      `select state, retry_count from ${jobs.settings.schema}.job where id = any($1::uuid[]) order by created_on`,
      [ids],
    );
    if (
      r.rows.length === ids.length &&
      r.rows.every((j) => ["completed", "failed"].includes(j.state))
    )
      return r.rows;
    if (Date.now() > deadline)
      throw new Error(`jobs never ended: ${JSON.stringify(r.rows)}`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

const sendsOf = async (runId: string) =>
  (
    await admin.query(
      `select status from sends where org_id = $1 and workflow_run_id = $2`,
      [orgId, runId],
    )
  ).rows.map((r) => r.status);
const reviewTasks = async (runId: string) =>
  (
    await admin.query(
      `select contact_id from tasks where org_id = $1 and workflow_run_id = $2 and kind = 'review'`,
      [orgId, runId],
    )
  ).rows;
const conversations = async (runId: string) =>
  (
    await admin.query<{ n: number }>(
      `select count(*)::int n from conversations where org_id = $1 and workflow_run_id = $2`,
      [orgId, runId],
    )
  ).rows[0]?.n;

describe("the worker's job runner never sends the same call or message twice", () => {
  it("a call job whose dialer took the call and whose save then failed is retried by pg-boss, and dials once: the lead goes to a person", async () => {
    const { number, contactId, runId } = await leadWithRun("c");
    tripOn.add(number);
    const id = await queue.send("place_call", {
      orgId,
      runId,
      sendId: randomUUID(),
      step: "c",
      idx: 0,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    const [job] = await ended([id]);

    expect(job).toEqual({ state: "completed", retry_count: 1 }); // failed once, then pg-boss ran it again
    expect(placed.filter((n) => n === number)).toHaveLength(1);
    expect(await sendsOf(runId)).toEqual(["unknown"]);
    expect(await reviewTasks(runId)).toEqual([{ contact_id: contactId }]);
    expect(await conversations(runId)).toBe(0);
  }, 40_000);

  it("a call job queued twice dials once, and its outcome is folded once", async () => {
    const { number, contactId, runId } = await leadWithRun("c");
    const data = {
      orgId,
      runId,
      sendId: randomUUID(),
      step: "c",
      idx: 0,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    };
    const first = await queue.send("place_call", data, {
      singletonKey: `${runId}:a`,
    });
    const second = await queue.send("place_call", data, {
      singletonKey: `${runId}:b`,
    });

    expect((await ended([first, second])).map((j) => j.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(placed.filter((n) => n === number)).toHaveLength(1);
    expect(await sendsOf(runId)).toEqual(["sent"]);
    expect(await conversations(runId)).toBe(1);
    const run = await admin.query(
      `select status, state from workflow_runs where id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "waiting",
      state: { lastDisposition: "completed" },
    });
  }, 40_000);

  it("a WhatsApp job whose provider took the message and whose save then failed is retried by pg-boss, and sends once: the lead goes to a person", async () => {
    const { number, contactId, runId } = await leadWithRun("end");
    tripOn.add(number);
    const id = await queue.send("send_wa", {
      orgId,
      runId,
      sendId: randomUUID(),
      step: "w",
      idx: 0,
      action: { kind: "send_wa", contactId, template: "welcome", vars: {} },
    });

    const [job] = await ended([id]);

    expect(job).toEqual({ state: "completed", retry_count: 1 });
    expect(messaged.filter((n) => n === number)).toHaveLength(1);
    expect(await sendsOf(runId)).toEqual(["unknown"]);
    expect(await reviewTasks(runId)).toEqual([{ contact_id: contactId }]);
    expect(await conversations(runId)).toBe(0);
  }, 40_000);

  it("a WhatsApp job queued twice sends one message", async () => {
    const { number, contactId, runId } = await leadWithRun("end");
    const data = {
      orgId,
      runId,
      sendId: randomUUID(),
      step: "w",
      idx: 0,
      action: { kind: "send_wa", contactId, template: "welcome", vars: {} },
    };
    const ids = [
      await queue.send("send_wa", data, { singletonKey: `${runId}:a` }),
      await queue.send("send_wa", data, { singletonKey: `${runId}:b` }),
    ];

    expect((await ended(ids)).map((j) => j.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(messaged.filter((n) => n === number)).toHaveLength(1);
    expect(await sendsOf(runId)).toEqual(["sent"]);
    expect(await conversations(runId)).toBe(1);
  }, 40_000);
});
