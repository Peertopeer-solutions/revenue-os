// The console's reads filter by company in their own SQL, the second fence on top of the database's per-company
// rules. They run here on the local postgres login, which those rules let through, so a read that leaves the
// company out hands company A company B's rows. services/worker/test/company-filter-api.test.ts checks the same
// through the API.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import {
  conversationMessages,
  funnelMetrics,
  listContacts,
  listConversations,
  listTasks,
  withOrg,
} from "../src";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const companies = testCompanies(admin);

type Company = Awaited<ReturnType<typeof fill>>;
let A: Company;
let B: Company;

/** A company with one new lead, a completed and a live conversation, a qualified and a booking outcome, an open task. */
async function fill(name: string) {
  const { id: org } = await companies.add(`Company filter ${name}`);
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
  // Out of order on purpose: the transcript is read in seq order.
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
  return { org, name, contact, done, live, task };
}

beforeAll(async () => {
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
});

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

describe("the console's reads return only the company's own rows, with the per-company rules off", () => {
  it("listTasks: only A's task", async () => {
    const tasks = await listTasks(admin, A.org);
    expect(tasks.map((t) => t.id)).toEqual([A.task]);
  });

  it("listContacts: only A's lead, linked to A's newest conversation", async () => {
    const contacts = await listContacts(admin, A.org);
    expect(contacts.map((c) => [c.id, c.latest_conversation_id])).toEqual([
      [A.contact, A.live],
    ]);
  });

  it("listConversations: only A's two, newest first, named after A's lead", async () => {
    const conversations = await listConversations(admin, A.org);
    expect(conversations.map((c) => [c.id, c.contact_name])).toEqual([
      [A.live, "A Rao"],
      [A.done, "A Rao"],
    ]);
  });

  it("funnelMetrics: A's own counts", async () => {
    expect(await funnelMetrics(admin, A.org)).toEqual({
      new_leads: 1,
      conversations_started: 2,
      conversations_completed: 1,
      qualified: 1,
      bookings: 1,
      open_tasks: 1,
    });
  });

  it("conversationMessages: B's conversation is not found for A; A's transcript comes in order", async () => {
    expect(await conversationMessages(admin, A.org, B.live)).toBeNull();
    const transcript = await conversationMessages(admin, A.org, A.live);
    expect(transcript?.map((m) => [m.seq, m.role, m.content])).toEqual([
      [1, "contact", "hello"],
      [2, "agent", "reply to A"],
    ]);
  });
});
