// The console's screens, read through the worker's API, show a company only its own rows even with the database's
// per-company rules out of the way: the API runs in a child process on the local postgres login, which those rules
// let through (fixtures/company-filter-api.ts), so only the company filter in each read keeps company B's rows from
// company A's member. screens-api.test.ts checks the same routes with the rules on.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { withOrg } from "@revenue-os/db";
import pg from "pg";
import { children } from "../../../tests/children";
import { within } from "../../../tests/deadline";
import { testCompanies } from "../../../tests/test-companies";
import { testUser } from "../../../tests/test-users";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const companies = testCompanies(admin);
const { bun } = children();

type Company = Awaited<ReturnType<typeof fill>>;
let A: Company;
let B: Company;
// Each path's answer from the API, by path.
const answers = new Map<string, { status: number; body: unknown }>();
const get = (path: string) => answers.get(path) ?? { status: 0, body: null };

/** A company with one new lead, a completed and a live conversation, a qualified and a booking outcome, an open task. */
async function fill(name: string) {
  const { id: org } = await companies.add(`Company filter API ${name}`);
  const one = async (sql: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(sql, values)).rows[0]?.id ?? "";
  const contact = await one(
    `insert into contacts (org_id, first_name, last_name) values ($1, $2, 'Rao') returning id`,
    [org, name],
  );
  const done = await one(
    `insert into conversations (org_id, contact_id, channel, direction, status, started_at, ended_at)
     values ($1, $2, 'voice', 'inbound', 'completed', now() - interval '1 hour', now()) returning id`,
    [org, contact],
  );
  const live = await one(
    `insert into conversations (org_id, contact_id, channel, direction, status, started_at)
     values ($1, $2, 'whatsapp', 'inbound', 'active', now()) returning id`,
    [org, contact],
  );
  await admin.query(
    `insert into messages (org_id, conversation_id, seq, role, content)
     values ($1, $2, 2, 'agent', $3), ($1, $2, 1, 'contact', 'hello')`,
    [org, live, `reply to ${name}`],
  );
  await admin.query(
    `insert into outcomes (org_id, contact_id, conversation_id, kind, source, occurred_at)
     values ($1, $2, $3, 'qualified', 'agent', now()), ($1, $2, $3, 'booking', 'agent', now())`,
    [org, contact, live],
  );
  const task = await one(
    `insert into tasks (org_id, contact_id, conversation_id, kind, status, priority, title)
     values ($1, $2, $3, 'approval', 'open', 1, 'Approve the visit') returning id`,
    [org, contact, live],
  );
  return { org, contact, done, live, task };
}

beforeAll(async () => {
  // Under four whole suites at once, starting a process and the app can take long (tests/deadline.ts).
  await within(
    170_000,
    "the companies and the API's child process",
    (async () => {
      A = await fill("A");
      B = await fill("B");
      // The test means something only if this login really skips the per-company rules.
      const seen = await withOrg(admin, A.org, (tx) =>
        tx.query("select count(*)::int as n from contacts where org_id = $1", [
          B.org,
        ]),
      );
      if (seen.rows[0]?.n !== 1)
        throw new Error(
          "the local postgres login no longer skips the per-company rules, so these tests would prove nothing",
        );
      const member = await testUser(admin, "company-filter-api");
      await admin.query(
        "insert into org_members (org_id, user_id) values ($1, $2)",
        [A.org, member.userId],
      );
      const paths = [
        ...["tasks", "contacts", "conversations", "metrics"].map(
          (screen) => `/orgs/${A.org}/${screen}`,
        ),
        `/orgs/${A.org}/conversations/${A.live}/messages`,
        `/orgs/${A.org}/conversations/${B.live}/messages`,
      ];
      const run = await bun(
        [
          join(import.meta.dir, "fixtures/company-filter-api.ts"),
          member.token,
          ...paths,
        ],
        join(import.meta.dir, "../../.."),
      );
      const line = run.out
        .split("\n")
        .find((l) => l.startsWith("RESULT "))
        ?.slice(7);
      if (run.code !== 0 || !line)
        throw new Error(
          `the API's child process failed (exit ${run.code}):\n${run.out.slice(-3000)}`,
        );
      for (const { path, ...answer } of JSON.parse(line) as Array<{
        path: string;
        status: number;
        body: unknown;
      }>)
        answers.set(path, answer);
    })(),
  );
}, 180_000);

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

describe("the console's screens through the API, with the per-company rules off", () => {
  it("GET /orgs/:orgId/tasks: only A's task", () => {
    const { status, body } = get(`/orgs/${A.org}/tasks`);
    expect(status).toBe(200);
    const { tasks } = body as { tasks: Array<{ id: string }> };
    expect(tasks.map((t) => t.id)).toEqual([A.task]);
  });

  it("GET /orgs/:orgId/contacts: only A's lead, linked to A's newest conversation", () => {
    const { status, body } = get(`/orgs/${A.org}/contacts`);
    expect(status).toBe(200);
    const { contacts } = body as {
      contacts: Array<{ id: string; latest_conversation_id: string | null }>;
    };
    expect(contacts.map((c) => [c.id, c.latest_conversation_id])).toEqual([
      [A.contact, A.live],
    ]);
  });

  it("GET /orgs/:orgId/conversations: only A's two, newest first, named after A's lead", () => {
    const { status, body } = get(`/orgs/${A.org}/conversations`);
    expect(status).toBe(200);
    const { conversations } = body as {
      conversations: Array<{ id: string; contact_name: string | null }>;
    };
    expect(conversations.map((c) => [c.id, c.contact_name])).toEqual([
      [A.live, "A Rao"],
      [A.done, "A Rao"],
    ]);
  });

  it("GET /orgs/:orgId/metrics: A's own six counts", () => {
    expect(get(`/orgs/${A.org}/metrics`)).toEqual({
      status: 200,
      body: {
        metrics: {
          new_leads: 1,
          conversations_started: 2,
          conversations_completed: 1,
          qualified: 1,
          bookings: 1,
          open_tasks: 1,
        },
      },
    });
  });

  it("GET …/conversations/:id/messages: A's transcript in order; B's conversation is not found for A", () => {
    const own = get(`/orgs/${A.org}/conversations/${A.live}/messages`);
    expect(own.status).toBe(200);
    const { messages } = own.body as {
      messages: Array<{ seq: number; role: string; content: string | null }>;
    };
    expect(messages.map((m) => [m.seq, m.role, m.content])).toEqual([
      [1, "contact", "hello"],
      [2, "agent", "reply to A"],
    ]);
    expect(get(`/orgs/${A.org}/conversations/${B.live}/messages`)).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });
});
