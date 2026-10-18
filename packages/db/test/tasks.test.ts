// The one task writer (src/tasks.ts createTask), on the real local database as the product's login: a task is always
// for a lead of the same company, and it and its audit row are written together or not at all.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { Pool } from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { createPool, createTask, withOrg } from "../src";

const admin = new Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appService = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let orgA = "";
let orgB = "";
let leadA = "";
let leadB = "";

const lead = async (org: string) =>
  (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Lead') returning id`,
      [org],
    )
  ).rows[0].id as string;

const written = async (org: string) =>
  (
    await admin.query(
      `select (select count(*)::int from tasks where org_id = $1) tasks,
              (select count(*)::int from audit_log where org_id = $1 and action = 'task.create') audits`,
      [org],
    )
  ).rows[0];

beforeAll(async () => {
  orgA = (await companies.add("Tasks A")).id;
  orgB = (await companies.add("Tasks B")).id;
  leadA = await lead(orgA);
  leadB = await lead(orgB);
});

afterAll(async () => {
  await companies.cleanup();
  await appService.end();
  await admin.end();
});

const make = (contactId: string, actor = { type: "system" as const }) =>
  withOrg(appService, orgA, (tx) =>
    createTask(tx, orgA, {
      contactId,
      kind: "callback",
      title: "Call back",
      payload: { reason: "asked for a call" },
      actor,
    }),
  );

it("makes the task for the lead and its task.create audit row in one go", async () => {
  const id = await make(leadA);
  const rows = await admin.query(
    `select t.contact_id, t.kind, t.title, t.payload, a.actor_type, a.resource_type, a.after
       from tasks t join audit_log a on a.org_id = t.org_id and a.resource_id = t.id::text
      where t.org_id = $1 and t.id = $2`,
    [orgA, id],
  );
  expect(rows.rows).toEqual([
    {
      contact_id: leadA,
      kind: "callback",
      title: "Call back",
      payload: { reason: "asked for a call" },
      actor_type: "system",
      resource_type: "task",
      after: {
        kind: "callback",
        title: "Call back",
        contact_id: leadA,
        workflow_run_id: null,
        conversation_id: null,
      },
    },
  ]);
});

it("refuses a task without a lead, and writes nothing", async () => {
  const before = await written(orgA);
  await expect(make("")).rejects.toThrow("a task is always for a lead");
  expect(await written(orgA)).toEqual(before);
});

it("refuses a task for another company's lead, and writes nothing", async () => {
  const before = await written(orgA);
  await expect(make(leadB)).rejects.toMatchObject({ code: "23503" });
  expect(await written(orgA)).toEqual(before);
});

it("leaves no task when its audit row can't be written", async () => {
  const before = await written(orgA);
  await expect(make(leadA, { type: "robot" } as never)).rejects.toThrow();
  expect(await written(orgA)).toEqual(before);
});
