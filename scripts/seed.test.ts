// After `db:seed <pack>`, dispositions / pipelines /
// guardrails / agent v1 / workflow v1 / field definitions / eval personas exist — idempotently.
import { afterAll, describe, expect, it } from "bun:test";
import pg from "pg";
import { ConversationIdSchema } from "../packages/shared/src/schemas";
import { testCompanies } from "../tests/test-companies";
import { type Pack, seed } from "./seed";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
// Every workspace this file makes, and only those (the shared test-company helper): other sessions
// share this database and use the dev login's seed-real-estate / seed-b2b-wholesale meanwhile, so
// the tests never seed or delete them.
const companies = testCompanies(admin);

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

/** Seeds `pack` into a fresh workspace of this file's own; `again` re-seeds that same workspace. */
async function workspace(pack: Pack) {
  const { slug } = await companies.add("Seed test");
  const again = () => seed(pack, slug);
  const { orgId } = await again();
  return { orgId, again };
}

async function counts(orgId: string) {
  const q = async (sql: string) =>
    Number((await admin.query(sql, [orgId])).rows[0].n);
  return {
    dispositions: await q(
      `select count(*)::int n from dispositions where org_id = $1`,
    ),
    pipelines: await q(
      `select count(*)::int n from pipelines where org_id = $1`,
    ),
    stages: await q(
      `select count(*)::int n from pipeline_stages where org_id = $1`,
    ),
    fields: await q(
      `select count(*)::int n from field_definitions where org_id = $1`,
    ),
    guardrails: await q(
      `select count(*)::int n from guardrail_policies where org_id = $1`,
    ),
    agents: await q(
      `select count(*)::int n from agents where org_id = $1 and version = 1`,
    ),
    workflows: await q(
      `select count(*)::int n from workflows where org_id = $1 and version = 1`,
    ),
    personas: await q(
      `select count(*)::int n from eval_scenarios where org_id = $1`,
    ),
  };
}

describe("seed packs (docs/db-design.md, vertical packs)", () => {
  it("real_estate pack populates the vertical template", async () => {
    const { orgId } = await workspace("real_estate");
    const c = await counts(orgId);
    expect(c.dispositions).toBe(7);
    expect(c.pipelines).toBe(1);
    expect(c.stages).toBe(6);
    expect(c.fields).toBe(5);
    expect(c.guardrails).toBe(4);
    expect(c.agents).toBe(1);
    expect(c.workflows).toBe(1);
    expect(c.personas).toBe(10);
  });

  it("b2b_wholesale pack populates the vertical template", async () => {
    const { orgId } = await workspace("b2b_wholesale");
    const c = await counts(orgId);
    expect(c.dispositions).toBe(7);
    expect(c.pipelines).toBe(1);
    expect(c.stages).toBe(6);
    expect(c.fields).toBe(4);
    expect(c.guardrails).toBe(4);
    expect(c.agents).toBe(1);
    expect(c.workflows).toBe(1);
    expect(c.personas).toBe(10);
  });

  it("re-seeding is idempotent (no duplicate template rows)", async () => {
    const { orgId, again } = await workspace("real_estate");
    const second = await again();
    expect(second.orgId).toBe(orgId);
    const c = await counts(orgId);
    expect(c.dispositions).toBe(7);
    expect(c.personas).toBe(10);
  });

  it("seeded agent v1 and workflow v1 are drafts (evals pass before a version goes live)", async () => {
    const { orgId } = await workspace("real_estate");
    const r = await admin.query(
      `select (select status from agents where org_id = $1 and version = 1) as agent,
			        (select status from workflows where org_id = $1 and version = 1) as workflow`,
      [orgId],
    );
    expect(r.rows[0].agent).toBe("draft");
    expect(r.rows[0].workflow).toBe("draft");
  });

  it("seeds into the workspace it is given, not the pack's own", async () => {
    const { orgId } = await workspace("b2b_wholesale");
    const { slug } = (
      await admin.query(`select slug from orgs where id = $1`, [orgId])
    ).rows[0];
    expect(slug).toStartWith("test-");
  });

  it("rejects unknown packs", async () => {
    expect(seed("not_a_pack" as never)).rejects.toThrow(/unknown pack/i);
  });
});

// Every row of a workspace in the tables the demo cleanup could reach, directly or by cascade.
const TABLES = [
  "contacts",
  "conversations",
  "messages",
  "tasks",
  "outcomes",
  "appointments",
  "contact_identities",
  "contact_memories",
  "contact_scores",
];
const rowIds = async (orgId: string) =>
  (
    await admin.query(
      `${TABLES.map((t) => `select '${t}:' || id from ${t} where org_id = $1`).join(" union all ")} order by 1`,
      [orgId],
    )
  ).rows;
const newOrg = async () =>
  (await companies.add("Seed test — other workspace")).id;

// The console demo rows (contacts and their conversations, messages, tasks, outcomes). Before
// this was fixed every run inserted another full copy, so the dev login saw each person twice.
describe.each([
  "real_estate",
  "b2b_wholesale",
] as const)("re-seeding %s keeps one copy of the demo rows", (pack) => {
  const demo = async (orgId: string) =>
    (
      await admin.query(
        `select (select count(*)::int from contacts where org_id = $1) contacts,
                  (select count(*)::int from conversations where org_id = $1) conversations,
                  (select count(*)::int from messages where org_id = $1) messages,
                  (select count(*)::int from tasks where org_id = $1) tasks,
                  (select count(*)::int from outcomes where org_id = $1) outcomes,
                  (select max(n)::int from (select count(*) n from contacts where org_id = $1
                     group by first_name, last_name) p) max_copies`,
        [orgId],
      )
    ).rows[0];
  // The first demo person of a seeded workspace (the fixed-id row).
  const person = async (orgId: string) =>
    (
      await admin.query(
        `select id, first_name, last_name, source from contacts where org_id = $1 order by first_name limit 1`,
        [orgId],
      )
    ).rows[0];

  // A copy of a seeded person the old, non-idempotent seed left behind in `seedOrg`: same name and
  // source, another id, with the conversation, message, task and outcome that run made for it.
  const addCopy = async (seedOrg: string, into = seedOrg) => {
    const p = await person(seedOrg);
    const contact = (
      await admin.query(
        `insert into contacts (org_id, first_name, last_name, source) values ($1, $2, $3, $4) returning id`,
        [into, p.first_name, p.last_name, p.source],
      )
    ).rows[0].id as string;
    const conversation = await addHistory(into, contact);
    return { contact, conversation, seeded: p.id as string };
  };
  // A conversation (with one message), a task and an outcome that `org` owns for `contact`.
  const addHistory = async (org: string, contact: string) => {
    const v = await admin.query(
      `insert into conversations (org_id, contact_id, channel, direction, status)
         values ($1, $2, 'voice', 'inbound', 'completed') returning id`,
      [org, contact],
    );
    const conversation = v.rows[0].id as string;
    await admin.query(
      `insert into messages (org_id, conversation_id, seq, role, content) values ($1, $2, 1, 'agent', 'hi')`,
      [org, conversation],
    );
    await admin.query(
      `insert into tasks (org_id, contact_id, conversation_id, kind, title) values ($1, $2, $3, 'callback', 'call back')`,
      [org, contact, conversation],
    );
    await admin.query(
      `insert into outcomes (org_id, contact_id, conversation_id, kind, source) values ($1, $2, $3, 'qualified', 'agent')`,
      [org, contact, conversation],
    );
    return conversation;
  };

  it("seeding twice, plus a copy an older run left, ends with one row per seeded record — other workspaces untouched", async () => {
    const { orgId, again } = await workspace(pack);
    const once = await demo(orgId);
    expect(once).toEqual({
      contacts: 6,
      conversations: 4,
      messages: 13,
      tasks: 3,
      outcomes: 3,
      max_copies: 1,
    });
    const seededRows = await rowIds(orgId);
    await addCopy(orgId);

    // Another workspace holding the very same person: the seed must never touch it.
    const other = await newOrg();
    await addCopy(orgId, other);
    const otherBefore = await rowIds(other);

    await again();
    const last = await again();
    expect(last.orgId).toBe(orgId);
    expect(await demo(orgId)).toEqual(once);
    expect(await rowIds(orgId)).toEqual(seededRows); // same rows, same ids: links stay valid
    expect(await rowIds(other)).toEqual(otherBefore);
    expect(otherBefore).toHaveLength(5);
  });

  // The console's screens count the last 30 days (Analytics' tiles and trends, the browser check that opens every
  // screen), so a local database seeded weeks ago showed no demo activity. Re-running the pack, as the browser checks
  // do, moves every demo time it sets back to the run's own time, outcomes and messages with their conversations.
  it("re-seeding moves the demo rows' times to now, so the 30-day screens show them again", async () => {
    const { orgId, again } = await workspace(pack);
    const age = (sql: string) => admin.query(sql, [orgId]);
    await age(
      `update conversations set started_at = started_at - interval '60 days', ended_at = ended_at - interval '60 days' where org_id = $1`,
    );
    await age(
      `update messages set ts = ts - interval '60 days' where org_id = $1`,
    );
    await age(
      `update contacts set last_interaction_at = last_interaction_at - interval '60 days' where org_id = $1`,
    );
    await age(
      `update tasks set due_at = due_at - interval '60 days', completed_at = completed_at - interval '60 days' where org_id = $1`,
    );
    await age(
      `update outcomes set occurred_at = occurred_at - interval '60 days' where org_id = $1`,
    );
    const seen = async () =>
      (
        await admin.query(
          `select (select count(*)::int from conversations where org_id = $1
                     and started_at::date between current_date - 29 and current_date) conversations,
                  (select count(*)::int from messages where org_id = $1 and ts > now() - interval '30 days') messages,
                  (select count(*)::int from contacts where org_id = $1
                     and last_interaction_at > now() - interval '30 days') contacts,
                  (select count(*)::int from tasks where org_id = $1 and status = 'open' and due_at > now()) open_due,
                  (select count(*)::int from outcomes where org_id = $1 and occurred_at > now() - interval '30 days') outcomes,
                  -- every time the pack sets, older than the 30-day window
                  (select count(*)::int from conversations where org_id = $1
                     and (started_at < now() - interval '30 days' or ended_at < now() - interval '30 days'))
                  + (select count(*)::int from tasks where org_id = $1
                     and (due_at < now() - interval '30 days' or completed_at < now() - interval '30 days')) stale,
                  -- a message or an outcome dated before the conversation it belongs to
                  (select count(*)::int from messages m join conversations c on c.org_id = m.org_id and c.id = m.conversation_id
                     where m.org_id = $1 and m.ts < c.started_at)
                  + (select count(*)::int from outcomes o join conversations c on c.org_id = o.org_id and c.id = o.conversation_id
                     where o.org_id = $1 and o.occurred_at < c.started_at)
                  + (select count(*)::int from conversations where org_id = $1 and ended_at < started_at) out_of_order`,
          [orgId],
        )
      ).rows[0];
    expect(await seen()).toMatchObject({
      conversations: 0,
      messages: 0,
      contacts: 0,
      open_due: 0,
      outcomes: 0,
      out_of_order: 0,
    });
    const ids = await rowIds(orgId);

    await again();
    expect(await seen()).toEqual({
      conversations: 4,
      messages: 13,
      contacts: 5,
      open_due: 2,
      outcomes: 3,
      stale: 0,
      out_of_order: 0,
    });
    expect(await rowIds(orgId)).toEqual(ids); // the same rows, moved in time
  });

  // The console and the worker parse ids with the shared uuid schema, and one bad id fails a whole
  // list: an id that is 32 hex digits but not an RFC 9562 UUID broke every demo screen.
  it("gives every demo row an id the console and the worker accept", async () => {
    const { orgId } = await workspace(pack);
    const { rows } = await admin.query(
      ["contacts", "conversations", "tasks", "outcomes"] // messages have numeric ids
        .map((t) => `select '${t}' t, id::text from ${t} where org_id = $1`)
        .join(" union all "),
      [orgId],
    );
    expect(rows).toHaveLength(16);
    expect(
      rows.filter((r) => !ConversationIdSchema.safeParse(r.id).success),
    ).toEqual([]);
  });

  // An existing local database can hold an old copy that later work picked up (a booked
  // appointment here). The seed used to stop on it with a foreign-key error.
  it("an old copy that other rows depend on is kept, and the seed still runs", async () => {
    const { orgId, again } = await workspace(pack);
    const copy = await addCopy(orgId);
    await admin.query(
      `insert into appointments (org_id, contact_id, kind, starts_at, ends_at, timezone)
         values ($1, $2, 'site_visit', now(), now() + interval '1 hour', 'Asia/Kolkata')`,
      [orgId, copy.contact],
    );
    const before = await rowIds(orgId);

    await again();
    expect(await rowIds(orgId)).toEqual(before);
  });
});
