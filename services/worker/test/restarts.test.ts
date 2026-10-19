// Restarts lose no work. Real worker processes (fixtures/worker-process.ts: the worker's real job runner with pretend
// providers) on real pg-boss and the real local database, in a pg-boss schema of this test's own
// (fixtures/test-job-schema.ts). A worker sent SIGTERM, as a restart or deploy sends it, takes no new job and lets
// its running call finish before it exits; the next worker takes the job it left. A worker killed mid-send leaves its
// jobs running in pg-boss with no one alive behind them: the next worker picks them up again, and neither the call
// nor the WhatsApp message is sent twice; each lead goes to a person, since nobody knows whether the send went out.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { testCompanies } from "../../../tests/test-companies";
import {
  jobQueueReachable,
  startJobs,
  stopJobs,
  stopOnSignal,
} from "../src/jobs";
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
let jobs: Awaited<ReturnType<typeof testJobSchema>>;
let queue: PgBoss; // queues jobs into this test's schema, as the scheduler queues them into the worker's
let orgId = "";
let workflowId = "";

const CALL_WF = {
  entry: "c",
  steps: {
    c: { kind: "call", agent: "closer", on: { completed: "end" } },
    end: { kind: "end" },
  },
};

/** A worker process, and every line it has written to stdout so far. */
type Worker = {
  proc: ReturnType<typeof Bun.spawn>;
  lines: Record<string, unknown>[];
};
const workers: Worker[] = [];

/** Starts a worker process whose pretend providers hold each send for `holdMs`, and waits until it takes jobs. */
async function startWorker(holdMs: number): Promise<Worker> {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/worker-process.ts")],
    {
      env: {
        ...process.env,
        JOB_SCHEMA: jobs.settings.schema,
        HOLD_MS: String(holdMs),
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const w: Worker = { proc, lines: [] };
  workers.push(w);
  (async () => {
    let rest = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      rest += new TextDecoder().decode(chunk);
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) {
        try {
          w.lines.push(JSON.parse(p));
        } catch {} // the worker's own log lines
      }
    }
  })();
  await until(() => w.lines.some((l) => l.ready), "the worker never started");
  return w;
}

async function until(
  ok: () => boolean | Promise<boolean>,
  what: string,
  ms = 30_000,
) {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((res) => setTimeout(res, 100));
  }
}

const said = (w: Worker, key: string, to: string) =>
  w.lines.filter((l) => l[key] === to).length;

beforeAll(async () => {
  orgId = (await companies.add("Restarts Org")).id;
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, 'closer', 1, 'active', 'm', 'You are a scheduler.', '{}')`,
    [orgId],
  );
  workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', $3::jsonb) returning id`,
      [orgId, `restarts-${randomUUID()}`, JSON.stringify(CALL_WF)],
    )
  ).rows[0].id;
  jobs = await testJobSchema(admin);
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
  for (const w of workers) w.proc.kill("SIGKILL");
  await Promise.all(workers.map((w) => w.proc.exited));
  await queue.stop({ graceful: false });
  await jobs.drop();
  await companies.cleanup();
  await admin.end();
});

/** A lead with a number of their own, and a run of theirs waiting at `step`: on the call step, parked for the call
 *  job whose send id it holds. Returns that lead's call or WhatsApp job, ready to queue. */
async function lead(kind: "place_call" | "send_wa") {
  const number = `+9197${String(Math.random()).slice(2, 10)}`;
  const sendId = randomUUID();
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
  const step = kind === "place_call" ? "c" : "end";
  const runId = (
    await admin.query(
      `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state)
       values ($1, $2, $3, 'waiting', $4, $5::jsonb) returning id`,
      [
        orgId,
        workflowId,
        contactId,
        step,
        JSON.stringify({ contactId, callSendId: sendId }),
      ],
    )
  ).rows[0].id;
  const action =
    kind === "place_call"
      ? { kind, contactId, agentKey: "closer" }
      : { kind, contactId, template: "welcome", vars: {} };
  return {
    number,
    contactId,
    runId,
    data: { orgId, runId, sendId, step, idx: 0, action },
  };
}

const jobState = async (id: string | null) =>
  (
    await admin.query<{ state: string; retry_count: number }>(
      `select state, retry_count from ${jobs.settings.schema}.job where id = $1`,
      [id],
    )
  ).rows[0];
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

describe("a worker stopped for a restart or deploy loses no work", () => {
  it("SIGTERM stops the worker's job runner (it no longer answers ready), and then the worker exits", async () => {
    await startJobs(jobs.settings);
    expect(await jobQueueReachable()).toBe(true);
    let exits = 0;
    stopOnSignal(() => exits++);

    process.emit("SIGTERM");
    await until(() => exits === 1, "the worker never exited");

    expect(await jobQueueReachable()).toBe(false);
    process.emit("SIGINT"); // Ctrl-C stops it the same way
    await until(() => exits === 2, "the worker never exited on SIGINT");
    await stopJobs();
  }, 30_000);

  it("on SIGTERM the worker takes no new job and lets its running call finish, then exits; the next worker takes the job it left", async () => {
    const worker = await startWorker(3_000);
    const first = await lead("place_call");
    const firstId = await queue.send("place_call", first.data);
    await until(
      () => said(worker, "placed", first.number) === 1,
      "the call was never placed",
    );

    worker.proc.kill("SIGTERM");
    const second = await lead("place_call");
    const secondId = await queue.send("place_call", second.data);

    expect(await worker.proc.exited).toBe(0);
    expect(said(worker, "answered", first.number)).toBe(1); // the dialer's answer came before the worker exited
    expect(await jobState(firstId)).toEqual({
      state: "completed",
      retry_count: 0,
    });
    expect(await sendsOf(first.runId)).toEqual(["sent"]);
    expect(said(worker, "placed", second.number)).toBe(0);
    expect((await jobState(secondId))?.state).toBe("created"); // left in the queue, untouched

    const next = await startWorker(0);
    await until(
      async () => (await jobState(secondId))?.state === "completed",
      "the next worker never took the job",
    );
    expect(said(next, "placed", second.number)).toBe(1);
    expect(await sendsOf(second.runId)).toEqual(["sent"]);
    next.proc.kill("SIGTERM");
    expect(await next.proc.exited).toBe(0);
  }, 60_000);
});

describe("a worker killed mid-send loses no work and sends nothing twice", () => {
  it("the call and the WhatsApp message it was sending are picked up by the next worker, which hands each lead to a person instead of sending again", async () => {
    const worker = await startWorker(600_000); // the dialer and WhatsApp take each send and hold it
    // Jobs whose worker went quiet are failed after 10 seconds here (pg-boss's least), not the worker's 30
    // (queue-settings.test.ts checks those): the jobs below take this setting when they are queued.
    for (const q of ["place_call", "send_wa"])
      await queue.updateQueue(q, {
        heartbeatSeconds: 10,
        retryDelay: 0,
        retryBackoff: false,
      });
    const call = await lead("place_call");
    const message = await lead("send_wa");
    const callId = await queue.send("place_call", call.data);
    const messageId = await queue.send("send_wa", message.data);
    await until(
      () =>
        said(worker, "placed", call.number) === 1 &&
        said(worker, "messaged", message.number) === 1,
      "the sends never started",
    );

    worker.proc.kill("SIGKILL");
    await worker.proc.exited;
    expect((await jobState(callId))?.state).toBe("active"); // nobody alive is working it
    expect(await sendsOf(call.runId)).toEqual(["sending"]);

    const next = await startWorker(0);
    await until(
      async () =>
        (await jobState(callId))?.state === "completed" &&
        (await jobState(messageId))?.state === "completed",
      "the next worker never picked the jobs up",
      45_000,
    );

    for (const [id, { runId, contactId }] of [
      [callId, call],
      [messageId, message],
    ] as const) {
      expect(await jobState(id)).toEqual({
        state: "completed",
        retry_count: 1,
      });
      expect(await sendsOf(runId)).toEqual(["unknown"]);
      expect(await reviewTasks(runId)).toEqual([{ contact_id: contactId }]);
    }
    expect(said(next, "placed", call.number)).toBe(0);
    expect(said(next, "messaged", message.number)).toBe(0);
  }, 90_000);
});
