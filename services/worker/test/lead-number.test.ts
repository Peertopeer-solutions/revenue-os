// The one way the worker finds the number a lead is reached on (packages/db/src/lead-numbers.ts leadNumber), at the
// call and WhatsApp jobs' own entry points on the real local database: a lead with no number for the channel, or one
// deleted, is never called or messaged (the sender is never handed an empty address) and is handed to a person with
// the reason, and a lead with numbers is reached on their primary one.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import { ToolRegistry } from "@revenue-os/harness";
import pg, { type Pool } from "pg";
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

/** Runs the call job for the lead on `pool`: the numbers the sender was handed, into `to` (it stops the job once it
 * has one). */
async function dialled(
  l: { contactId: string; runId: string },
  pool: Pool = appPool,
  to: string[] = [],
): Promise<string[]> {
  await handlePlaceCall(
    {
      pool,
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

/** Runs the WhatsApp job for the lead on `pool`: the numbers the sender was handed, into `to`. */
async function messaged(
  l: { contactId: string; runId: string },
  pool: Pool = appPool,
  to: string[] = [],
): Promise<string[]> {
  await handleSendWa(
    {
      pool,
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

/** What a person is handed for the run: its saved reason and its review tasks (with the reason and template each
 * carries, and their audit rows). */
async function handedOver(runId: string) {
  const run = await admin.query(
    `select last_error from workflow_runs where org_id = $1 and id = $2`,
    [orgId, runId],
  );
  const tasks = await admin.query(
    `select t.kind, t.title, t.payload ->> 'reason' as why, t.payload ->> 'template' as template, a.action from tasks t
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
      why: "no_number",
      template: null,
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
      why: "no_whatsapp_number",
      template: "welcome",
      action: "task.create",
    },
  ]);
});

it("a call job delivered twice for a lead with no number hands the lead to a person once", async () => {
  const l = await lead([]);
  await dialled(l);
  await dialled(l);
  expect(await handedOver(l.runId)).toEqual(NOT_CALLED);
});

it("a WhatsApp job delivered twice for a lead with no WhatsApp number hands the lead to a person once", async () => {
  const l = await lead([["phone", "+919800000005", true]]);
  await messaged(l);
  await messaged(l);
  expect((await handedOver(l.runId)).tasks).toHaveLength(1);
});

it("a merged lead is never called, and is handed to a person with the reason", async () => {
  const kept = await lead([["phone", "+919800000006", true]]);
  const l = await lead([["phone", "+919800000007", true]]);
  await admin.query(
    `update contacts set merged_into_id = $3 where org_id = $1 and id = $2`,
    [orgId, l.contactId, kept.contactId],
  );
  expect(await dialled(l)).toEqual([]);
  expect(await handedOver(l.runId)).toEqual(NOT_CALLED);
});

// behaviour already on main: main's WhatsApp lookup took only WhatsApp numbers too; this pins that the one lookup does
it("a WhatsApp message goes to the lead's WhatsApp number, never their primary phone number", async () => {
  const l = await lead([
    ["phone", "+919800000008", true],
    ["whatsapp", "+919800000009", false],
  ]);
  expect(await messaged(l)).toEqual(["+919800000009"]);
});

it("a job naming another company's lead never reaches that lead's numbers, and leaves no task", async () => {
  const other = (await companies.add("Lead numbers, the other company")).id;
  const theirs = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Theirs') returning id`,
      [other],
    )
  ).rows[0].id as string;
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'phone', '+919800000010', true), ($1, $2, 'whatsapp', '+919800000011', false)`,
    [other, theirs],
  );
  const mine = await lead([]);
  const job = { contactId: theirs, runId: mine.runId };
  const refused = (e: { code?: string }) => [`refused ${e.code}`];
  expect(await dialled(job).catch(refused)).toEqual(["refused 23503"]);
  expect(await messaged(job).catch(refused)).toEqual(["refused 23503"]);
  expect((await handedOver(mine.runId)).tasks).toEqual([]);
});

/** The app's pool, except that the number lookup (any query naming contact_identities) fails as a lost database would. */
const lookupFails = {
  connect: async () => {
    const client = await appPool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return (text: unknown, ...rest: unknown[]) =>
            String(text).includes("contact_identities")
              ? Promise.reject(new Error("number lookup failed"))
              : (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
} as unknown as Pool;

// behaviour already on main: main's own lookups failed the job too; this pins that the one lookup's failure still does
it("a database error while finding the lead's number fails the job: nothing is sent, and no task or reason is saved", async () => {
  const l = await lead([
    ["phone", "+919800000012", true],
    ["whatsapp", "+919800000013", false],
  ]);
  const to: string[] = [];
  await expect(dialled(l, lookupFails, to)).rejects.toThrow(
    "number lookup failed",
  );
  await expect(messaged(l, lookupFails, to)).rejects.toThrow(
    "number lookup failed",
  );
  expect(to).toEqual([]);
  expect(await handedOver(l.runId)).toEqual({ reason: null, tasks: [] });
});
