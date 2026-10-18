// The one way the worker finds the number a lead is reached on (packages/db/src/lead-numbers.ts leadNumber), at the
// call and WhatsApp jobs' own entry points on the real local database: a lead with no number for the channel, or one
// deleted, is never called or messaged (the sender is never handed an empty address) and is handed to a person with
// the reason, and a lead with numbers is reached on their primary one.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import { ToolRegistry } from "@revenue-os/harness";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handlePlaceCall } from "../src/handlers/place-call";
import { handleSendWa } from "../src/handlers/send-wa";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let orgId = "";
let workflowId = "";

beforeAll(async () => {
  orgId = (await companies.add("Lead numbers")).id;
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, 'closer', 1, 'active', 'claude-sonnet-4-6', 'test', '{}')`,
    [orgId],
  );
  workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', '{"entry":"c","steps":{"c":{"kind":"call","agent":"closer","on":{}}}}'::jsonb)
       returning id`,
      [orgId, `numbers-${crypto.randomUUID()}`],
    )
  ).rows[0].id;
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

/** A lead with these numbers (kind, value, primary) and a run waiting on a call step: the lead's and the run's ids. */
async function lead(
  numbers: Array<[string, string, boolean]>,
  deleted = false,
) {
  const contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name, deleted_at) values ($1, 'Lead', $2) returning id`,
      [orgId, deleted ? new Date() : null],
    )
  ).rows[0].id;
  for (const [kind, value, primary] of numbers)
    await admin.query(
      `insert into contact_identities (org_id, contact_id, kind, value, is_primary) values ($1, $2, $3, $4, $5)`,
      [orgId, contactId, kind, value, primary],
    );
  const runId = (
    await admin.query(
      `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state)
       values ($1, $2, $3, 'waiting', 'c', $4::jsonb) returning id`,
      [orgId, workflowId, contactId, JSON.stringify({ contactId })],
    )
  ).rows[0].id;
  return { contactId, runId };
}

/** Runs the call job for the lead: the numbers the sender was handed (it stops the job once it has one). */
async function dialled(l: {
  contactId: string;
  runId: string;
}): Promise<string[]> {
  const to: string[] = [];
  await handlePlaceCall(
    {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async (p: { to?: string }) => {
          to.push(String(p.to));
          throw new Error("dialled");
        },
      },
      provider: {
        complete: async () => ({ text: "", usage: { in: 0, out: 0 } }),
      },
      registry: new ToolRegistry(),
      outcome: async () => "no_answer",
    } as never,
    {
      orgId,
      runId: l.runId,
      action: {
        kind: "place_call",
        contactId: l.contactId,
        agentKey: "closer",
      },
    },
  ).catch((e: Error) => {
    if (e.message !== "dialled") throw e;
  });
  return to;
}

/** Runs the WhatsApp job for the lead: the numbers the sender was handed. */
async function messaged(l: {
  contactId: string;
  runId: string;
}): Promise<string[]> {
  const to: string[] = [];
  await handleSendWa(
    {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        send: async (p) => {
          to.push(p.to);
          return { providerRef: `wamid-${crypto.randomUUID()}` };
        },
      },
    },
    {
      orgId,
      runId: l.runId,
      action: {
        kind: "send_wa",
        contactId: l.contactId,
        template: "welcome",
        vars: {},
      },
    },
  );
  return to;
}

/** What a person is handed for the run: its saved reason and its review tasks (with their audit rows). */
async function handedOver(runId: string) {
  const run = await admin.query(
    `select last_error from workflow_runs where org_id = $1 and id = $2`,
    [orgId, runId],
  );
  const tasks = await admin.query(
    `select t.kind, t.title, a.action from tasks t
       left join audit_log a on a.org_id = t.org_id and a.resource_id = t.id::text
      where t.org_id = $1 and t.workflow_run_id = $2`,
    [orgId, runId],
  );
  return { reason: run.rows[0]?.last_error, tasks: tasks.rows };
}

const NOT_CALLED = {
  reason: "no number to call",
  tasks: [
    {
      kind: "review",
      title: "Call not placed — no number to call",
      action: "task.create",
    },
  ],
};

it("a lead with no number is never called, and is handed to a person with the reason", async () => {
  const l = await lead([]);
  expect(await dialled(l)).toEqual([]);
  expect(await handedOver(l.runId)).toEqual(NOT_CALLED);
});

it("a deleted lead is never called, and is handed to a person with the reason", async () => {
  const l = await lead([["phone", "+919800000001", true]], true);
  expect(await dialled(l)).toEqual([]);
  expect(await handedOver(l.runId)).toEqual(NOT_CALLED);
});

// behaviour already on main: main dials the primary number too; this pins that the one lookup still finds and orders them
it("a lead is called on their primary number, over an older one", async () => {
  const l = await lead([
    ["phone", "+919800000002", false],
    ["phone", "+919800000003", true],
  ]);
  expect(await dialled(l)).toEqual(["+919800000003"]);
});

it("a lead with no WhatsApp number is never messaged, even with a phone number, and is handed to a person", async () => {
  const l = await lead([["phone", "+919800000004", true]]);
  expect(await messaged(l)).toEqual([]);
  expect((await handedOver(l.runId)).tasks).toEqual([
    {
      kind: "review",
      title: "WhatsApp message not sent — no WhatsApp number",
      action: "task.create",
    },
  ]);
});
