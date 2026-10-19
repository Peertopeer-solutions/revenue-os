// Every task for a person the worker makes goes through the one task writer (packages/db/src/tasks.ts createTask):
// always for the run's lead, with its audit row in the same transaction. Here at the worker's own entry points on the
// real local database and pg-boss: the dead-letter sink of a failed call (handleCallPost) and a sequence's task step
// (the scheduler's tick).
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { testCompanies } from "../../../tests/test-companies";
import { handleCallPost } from "../src/handlers/call-post";
import { tick } from "../src/scheduler";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appPool = createPool(DB_URL);
const boss = new PgBoss({
  connectionString: DB_URL,
  schema: "pgboss",
  createSchema: false,
});
const companies = testCompanies(admin, appPool);
let orgId = "";
let contactId = "";

async function run(definition: unknown, step: string): Promise<string> {
  const wf = await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [orgId, `tasks-wf-${crypto.randomUUID()}`, JSON.stringify(definition)],
  );
  const r = await admin.query(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state, wake_at)
     values ($1, $2, $3, 'waiting', $4, $5::jsonb, now()) returning id`,
    [orgId, wf.rows[0].id, contactId, step, JSON.stringify({ contactId })],
  );
  return r.rows[0].id;
}

const taskOf = async (runId: string) =>
  (
    await admin.query(
      `select t.kind, t.contact_id, t.workflow_run_id, a.actor_type, a.action
         from tasks t left join audit_log a on a.org_id = t.org_id and a.resource_id = t.id::text
        where t.org_id = $1 and t.workflow_run_id = $2`,
      [orgId, runId],
    )
  ).rows;

beforeAll(async () => {
  await boss.start();
  orgId = (await companies.add("Hand-over tasks")).id;
  contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [orgId],
    )
  ).rows[0].id;
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await boss.stop({ graceful: false });
  await appPool.end();
  await admin.end();
});

it("a failed call's review task is for the run's lead, with its audit row", async () => {
  const runId = await run(
    { entry: "c", steps: { c: { kind: "call", agent: "closer", on: {} } } },
    "c",
  );
  await handleCallPost(
    { pool: appPool },
    { orgId, runId, action: { kind: "place_call" } },
  );
  expect(await taskOf(runId)).toEqual([
    {
      kind: "review",
      contact_id: contactId,
      workflow_run_id: runId,
      actor_type: "system",
      action: "task.create",
    },
  ]);
});

// behaviour already on main: main's insert names a run that isn't there and the link refuses it; now no run means no task is tried
it("a failed call for a run the company doesn't have makes no task", async () => {
  const runId = crypto.randomUUID();
  await handleCallPost(
    { pool: appPool },
    { orgId, runId, action: { kind: "place_call" } },
  );
  expect(await taskOf(runId)).toEqual([]);
});

// behaviour already on main: the tick now runs a minute after the run is due, so a database clock ahead of this machine's can't leave it not yet due
it("a sequence's hand-over step makes a task for the run's lead, with its audit row", async () => {
  // The definition as the database holds it (its steps' `then` is a field, written here as JSON text).
  const runId = await run(
    JSON.parse(
      '{"entry":"h","steps":{"h":{"kind":"tool","tool":"create_task","args":{"kind":"handoff","title":"Hand to a closer"},"then":"end"},"end":{"kind":"end"}}}',
    ),
    "h",
  );
  // A minute on: the run is due at the database's now(), which keeps microseconds and on this Mac runs a little
  // ahead of its clock, so `new Date()` taken just after was before it about one time in five, and nothing was due.
  await tick(appPool, orgId, { now: new Date(Date.now() + 60_000) });
  expect(await taskOf(runId)).toEqual([
    {
      kind: "handoff",
      contact_id: contactId,
      workflow_run_id: runId,
      actor_type: "system",
      action: "task.create",
    },
  ]);
});

it("the same failed call delivered twice makes one review task; another failed call of the run makes its own", async () => {
  const runId = await run(
    { entry: "c", steps: { c: { kind: "call", agent: "closer", on: {} } } },
    "c",
  );
  const failed = (idx: number) =>
    handleCallPost(
      { pool: appPool },
      { orgId, runId, step: "c", idx, action: { kind: "place_call" } },
    );
  await failed(0);
  await failed(0);
  expect(await taskOf(runId)).toHaveLength(1);
  await failed(1);
  expect(await taskOf(runId)).toHaveLength(2);
});
