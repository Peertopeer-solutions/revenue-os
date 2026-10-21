// A slow or stuck AI model, dialer or WhatsApp service can't freeze the worker: the worker's real job runner (startJobs
// in services/worker/src/jobs.ts, real pg-boss, the real local database, a pg-boss schema of this test's own) is given
// services that never answer, and short time limits in place of the worker's own (src/time-limits.ts). While each
// service hangs, the row its job works on can be locked by anyone else at once (NOWAIT): no transaction holds it across
// the call. Then the job gives up in time: a turn's job fails and pg-boss runs it again, and a call or message whose
// answer never came is handed to a person and never sent again.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { LlmProvider } from "@revenue-os/harness";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { putLive } from "../../../tests/live-version";
import { OPTED_IN } from "../../../tests/opted-in";
import { testCompanies } from "../../../tests/test-companies";
import { startJobs, stopJobs } from "../src/jobs";
import { testJobSchema } from "./fixtures/test-job-schema";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 3,
});
const companies = testCompanies(admin);
let jobs: Awaited<ReturnType<typeof testJobSchema>>;
let queue: PgBoss;
let orgId = "";
let workflowId = "";
let agentId = "";

const LIMIT_MS = 500;
const never = () => new Promise<never>(() => {});

// The services: each records who it was asked about, then never answers. The dialer answers numbers in `dials`.
const modelAsked: AbortSignal[] = [];
const dialled: string[] = [];
const messaged: string[] = [];
const dials = new Set<string>();
const provider: LlmProvider = {
  complete: (req) => {
    if (req.signal) modelAsked.push(req.signal);
    return never();
  },
};

const CALL_WF = {
  entry: "c",
  steps: {
    c: { kind: "call", agent: "closer", on: { completed: "end" } },
    end: { kind: "end" },
  },
};

beforeAll(async () => {
  orgId = (await companies.add("No Freeze Org")).id;
  agentId = await putLive(admin, orgId, {
    key: "closer",
    systemPrompt: "You are a scheduler.",
  });
  workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', $3::jsonb) returning id`,
      [orgId, `no-freeze-${randomUUID()}`, JSON.stringify(CALL_WF)],
    )
  ).rows[0].id;
  jobs = await testJobSchema(admin);
  await startJobs(jobs.settings, {
    voice: {
      place: async ({ to }) => {
        dialled.push(to);
        return dials.has(to)
          ? { providerRef: `vapi-nf-${randomUUID()}` }
          : never();
      },
    },
    wa: {
      send: ({ to }) => {
        messaged.push(to);
        return never();
      },
    },
    outcome: async () => "completed",
    provider,
    limits: {
      model: LIMIT_MS,
      dialer: LIMIT_MS,
      whatsapp: LIMIT_MS,
      outcome: LIMIT_MS,
    },
  });
  queue = new PgBoss({
    connectionString: DB_URL,
    schema: jobs.settings.schema,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  await queue.start();
  // One retry, at once: the worker's own retry settings are checked in queue-settings.test.ts.
  for (const q of ["place_call", "send_wa", "run_agent_turn"])
    await queue.updateQueue(q, {
      retryLimit: 1,
      retryDelay: 0,
      retryBackoff: false,
    });
}, 60_000);

afterAll(async () => {
  await stopJobs();
  await queue.stop({ graceful: false });
  await jobs.drop();
  await companies.cleanup();
  await admin.end();
});

/** A lead with a number who agreed to WhatsApp messages, and a run of theirs waiting at `step`, parked for the call job whose send id `sendId` is. */
async function leadWithRun(step: string, sendId = randomUUID()) {
  const number = `+9198${String(Math.random()).slice(2, 10)}`;
  const contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name, consent) values ($1, 'Asha', $2) returning id`,
      [orgId, OPTED_IN],
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
      [
        orgId,
        workflowId,
        contactId,
        step,
        JSON.stringify({ contactId, callSendId: sendId }),
      ],
    )
  ).rows[0].id;
  return { number, contactId, runId, sendId };
}

/** Waits until `asked` says the service was asked. */
async function until(asked: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!asked()) {
    if (Date.now() > deadline) throw new Error("the service was never asked");
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** Whether another transaction can lock `table`'s row `id` at once, while the job waits on its service. */
async function lockable(table: "conversations" | "workflow_runs", id: string) {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query(`select 1 from ${table} where id = $1 for update nowait`, [
      id,
    ]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "55P03") return false; // lock_not_available
    throw err;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

/** Waits until the job has ended, and says how it ended and how often pg-boss retried it. */
async function ended(id: string | null, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await admin.query<{ state: string; retry_count: number }>(
      `select state, retry_count from ${jobs.settings.schema}.job where id = $1`,
      [id],
    );
    const job = r.rows[0];
    if (job && ["completed", "failed"].includes(job.state)) return job;
    if (Date.now() > deadline)
      throw new Error(`the job never gave up: ${JSON.stringify(job)}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

const sendOf = async (key: string) =>
  (
    await admin.query(
      `select status, reason from sends where org_id = $1 and send_key = $2`,
      [orgId, key],
    )
  ).rows[0];
const reviewTasks = async (runId: string) =>
  (
    await admin.query(
      `select contact_id from tasks where org_id = $1 and workflow_run_id = $2 and kind = 'review'`,
      [orgId, runId],
    )
  ).rows;

describe("a service that never answers can't freeze the worker", () => {
  it("an AI model that never answers: the conversation stays free while it hangs, and the turn's job gives up in time", async () => {
    const contactId = (
      await admin.query(
        `insert into contacts (org_id, first_name) values ($1, 'Ravi') returning id`,
        [orgId],
      )
    ).rows[0].id;
    const conversationId = (
      await admin.query(
        `insert into conversations (org_id, contact_id, agent_id, channel, direction, status)
         values ($1, $2, $3, 'whatsapp', 'inbound', 'active') returning id`,
        [orgId, contactId, agentId],
      )
    ).rows[0].id;
    await admin.query(
      `insert into messages (org_id, conversation_id, seq, role, content) values ($1, $2, 1, 'contact', 'Is the flat free?')`,
      [orgId, conversationId],
    );
    const asked = modelAsked.length;
    const started = Date.now();
    const id = await queue.send("run_agent_turn", {
      orgId,
      runId: randomUUID(),
      action: { kind: "run_agent_turn", conversationId },
    });

    await until(() => modelAsked.length > asked);
    expect(await lockable("conversations", conversationId)).toBe(true);
    const job = await ended(id);

    expect(job).toEqual({ state: "failed", retry_count: 1 }); // gave up, ran again, gave up again
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(modelAsked.slice(asked).every((s) => s.aborted)).toBe(true); // the model's request was cut off too
    const answers = await admin.query(
      `select 1 from messages where conversation_id = $1 and role <> 'contact'`,
      [conversationId],
    );
    expect(answers.rowCount).toBe(0);
    expect(await lockable("conversations", conversationId)).toBe(true);
  }, 30_000);

  it("a WhatsApp service that never answers: the run stays free while it hangs, and the job gives up in time, handing the lead to a person", async () => {
    const { number, contactId, runId } = await leadWithRun("end");
    const sendId = randomUUID();
    const id = await queue.send("send_wa", {
      orgId,
      runId,
      sendId,
      step: "w",
      idx: 0,
      action: { kind: "send_wa", contactId, template: "welcome", vars: {} },
    });

    await until(() => messaged.includes(number));
    expect(await lockable("workflow_runs", runId)).toBe(true);
    const job = await ended(id);

    expect(job).toEqual({ state: "completed", retry_count: 0 });
    expect(messaged.filter((n) => n === number)).toHaveLength(1); // never sent again
    expect(await sendOf(`send_wa:${runId}:${sendId}`)).toEqual({
      status: "unknown",
      reason: `could not tell whether the provider took it: the WhatsApp service did not answer within ${LIMIT_MS} ms`,
    });
    expect(await reviewTasks(runId)).toEqual([{ contact_id: contactId }]);
  }, 30_000);

  it("a dialer that never answers: the run stays free while it hangs, and the job gives up in time, handing the lead to a person", async () => {
    const { number, contactId, runId, sendId } = await leadWithRun("c");
    const id = await queue.send("place_call", {
      orgId,
      runId,
      sendId,
      step: "c",
      idx: 0,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    await until(() => dialled.includes(number));
    expect(await lockable("workflow_runs", runId)).toBe(true);
    const job = await ended(id);

    expect(job).toEqual({ state: "completed", retry_count: 0 });
    expect(dialled.filter((n) => n === number)).toHaveLength(1);
    expect(await sendOf(`place_call:${runId}:${sendId}`)).toEqual({
      status: "unknown",
      reason: `could not tell whether the provider took it: the dialer did not answer within ${LIMIT_MS} ms`,
    });
    expect(await reviewTasks(runId)).toEqual([{ contact_id: contactId }]);
    const run = await admin.query(
      `select status from workflow_runs where id = $1`,
      [runId],
    );
    expect(run.rows[0]?.status).toBe("failed");
  }, 30_000);

  it("a call placed, then an AI model that never answers on it: the run stays free while it hangs, and the job gives up in time without dialling again", async () => {
    const { number, runId, sendId } = await leadWithRun("c");
    dials.add(number);
    const asked = modelAsked.length;
    const started = Date.now();
    const id = await queue.send("place_call", {
      orgId,
      runId,
      sendId,
      step: "c",
      idx: 0,
      action: {
        kind: "place_call",
        contactId: (
          await admin.query(
            `select contact_id from workflow_runs where id = $1`,
            [runId],
          )
        ).rows[0].contact_id,
        agentKey: "closer",
      },
    });

    await until(() => modelAsked.length > asked);
    expect(await lockable("workflow_runs", runId)).toBe(true);
    const job = await ended(id);

    expect(job).toEqual({ state: "failed", retry_count: 1 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(dialled.filter((n) => n === number)).toHaveLength(1); // the retry went on from the saved call
    expect(await sendOf(`place_call:${runId}:${sendId}`)).toMatchObject({
      status: "sent",
    });
    const run = await admin.query(
      `select status, state from workflow_runs where id = $1`,
      [runId],
    );
    expect(run.rows[0]?.state.lastDisposition).toBeUndefined(); // no outcome folded from a turn that never ended
    expect(await lockable("workflow_runs", runId)).toBe(true);
  }, 30_000);
});
