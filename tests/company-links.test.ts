// Every link between company records stays inside one company (ROADMAP.md, Slice 1): two companies each get one
// record in every company table, and each of company A's records is pointed at company B's, one link at a time,
// through every link the database lists. The database must refuse each, while still taking company A's own record
// and, where a link may point at one, a shared template (agents, workflows and eval scenarios with no company). The
// links are read from the database itself, so a new one is tried too, and a link the trigger guards is tried again
// as the worker's own login (app_service, through withOrg), which may not call that trigger's function itself.
// Then the check every PR runs
// (tests/rls_coverage.sql, `bun run rls:check`) is run on scratch tables, inside a transaction it rolls back, and
// must fail a link that could cross companies, a duplicate key without the company and a company that may be empty.
// Slice 1's proof runs the first test by name (scripts/proof/slice-1-links.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool, withOrg } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "./test-companies";

// The local superuser: row-level security doesn't apply to it, so what refuses a link here is the database's own
// constraints, which bind every role alike.
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const companies = testCompanies(admin);
const RULES = readFileSync(join(import.meta.dir, "rls_coverage.sql"), "utf8");
const ZEROES = `[${Array(1536).fill(0).join(",")}]`;

type Rows = Record<string, string>;

async function add(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const r = await admin.query<{ id: string }>(
    `insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return String(r.rows[0]?.id);
}

/** One record in every company table that links to another, each linked to the company's own records. */
async function oneOfEach(org_id: string): Promise<Rows> {
  const r: Rows = {};
  const on = (row: Record<string, unknown>) => ({ org_id, ...row });
  r.companies = await add("companies", on({ name: "Acme" }));
  r.contacts = await add("contacts", on({ company_id: r.companies }));
  r.contact_identities = await add(
    "contact_identities",
    on({ contact_id: r.contacts, kind: "phone", value: "+919000000001" }),
  );
  r.pipelines = await add("pipelines", on({ key: "sales", name: "Sales" }));
  r.pipeline_stages = await add(
    "pipeline_stages",
    on({ pipeline_id: r.pipelines, key: "new", name: "New", position: 1 }),
  );
  r.deals = await add(
    "deals",
    on({
      contact_id: r.contacts,
      company_id: r.companies,
      pipeline_id: r.pipelines,
      stage_id: r.pipeline_stages,
      title: "2BHK",
    }),
  );
  r.dispositions = await add(
    "dispositions",
    on({ key: "other", label: "Other", category: "other" }),
  );
  r.agents = await add(
    "agents",
    on({ key: "qualifier", model: "m", system_prompt: "p" }),
  );
  r.workflows = await add("workflows", on({ key: "wf", definition: {} }));
  r.campaigns = await add(
    "campaigns",
    on({
      name: "Diwali",
      kind: "outbound_list",
      workflow_id: r.workflows,
      agent_id: r.agents,
    }),
  );
  r.workflow_runs = await add(
    "workflow_runs",
    on({
      workflow_id: r.workflows,
      campaign_id: r.campaigns,
      contact_id: r.contacts,
    }),
  );
  r.conversations = await add(
    "conversations",
    on({
      contact_id: r.contacts,
      campaign_id: r.campaigns,
      workflow_run_id: r.workflow_runs,
      agent_id: r.agents,
      disposition_id: r.dispositions,
      channel: "voice",
      direction: "outbound",
    }),
  );
  r.messages = await add(
    "messages",
    on({ conversation_id: r.conversations, seq: 1, role: "agent" }),
  );
  r.appointments = await add(
    "appointments",
    on({
      contact_id: r.contacts,
      deal_id: r.deals,
      kind: "site_visit",
      starts_at: "2026-11-15T12:00:00Z",
      ends_at: "2026-11-15T13:00:00Z",
      timezone: "Asia/Kolkata",
    }),
  );
  r.outcomes = await add(
    "outcomes",
    on({
      contact_id: r.contacts,
      deal_id: r.deals,
      campaign_id: r.campaigns,
      workflow_run_id: r.workflow_runs,
      conversation_id: r.conversations,
      appointment_id: r.appointments,
      kind: "site_visit_booked",
      source: "system",
    }),
  );
  r.tasks = await add(
    "tasks",
    on({
      contact_id: r.contacts,
      deal_id: r.deals,
      workflow_run_id: r.workflow_runs,
      conversation_id: r.conversations,
      kind: "manual",
      title: "Call back",
    }),
  );
  r.contact_memories = await add(
    "contact_memories",
    on({
      contact_id: r.contacts,
      kind: "fact",
      content: "Family decides on Sunday",
      source_conversation_id: r.conversations,
    }),
  );
  r.knowledge_documents = await add(
    "knowledge_documents",
    on({ title: "Price sheet", source_type: "text" }),
  );
  r.knowledge_chunks = await add(
    "knowledge_chunks",
    on({
      document_id: r.knowledge_documents,
      chunk_index: 0,
      content: "2BHK from 90L",
      embedding: ZEROES,
    }),
  );
  r.contact_scores = await add(
    "contact_scores",
    on({ contact_id: r.contacts, model_version: "v1", score: 1 }),
  );
  r.usage_events = await add(
    "usage_events",
    on({
      conversation_id: r.conversations,
      kind: "llm",
      provider: "fake",
      quantity: 1,
      unit: "tokens",
      cost_usd: 0,
    }),
  );
  r.eval_scenarios = await add(
    "eval_scenarios",
    on({ key: "eager", persona: {}, script: {}, assertions: {} }),
  );
  r.eval_runs = await add(
    "eval_runs",
    on({
      scenario_id: r.eval_scenarios,
      agent_id: r.agents,
      workflow_id: r.workflows,
      passed: true,
      transcript_ref: r.conversations,
    }),
  );
  r.prospect_candidates = await add(
    "prospect_candidates",
    on({
      source: "manual",
      duplicate_of_contact: r.contacts,
      promoted_contact_id: r.contacts,
    }),
  );
  return r;
}

// A shared template of each table that may hold them, as a migration would add one: no company.
const TEMPLATES: Record<string, Record<string, unknown>> = {
  agents: { key: "shared", model: "m", system_prompt: "p" },
  workflows: { key: "shared", definition: {} },
  eval_scenarios: { key: "shared", persona: {}, script: {}, assertions: {} },
};

type Link = { child: string; col: string; parent: string; shared: boolean };

/**
 * Every link between two company tables (tables with an org_id), one per linking column; `shared`: the parent may
 * hold shared templates, rows with no company.
 */
async function links(): Promise<Link[]> {
  const r = await admin.query<Link>(
    `select distinct c.conrelid::regclass::text as child, a.attname as col, c.confrelid::regclass::text as parent,
            not po.attnotnull as shared
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       join pg_attribute co on co.attrelid = c.conrelid and co.attname = 'org_id'
       join pg_attribute po on po.attrelid = c.confrelid and po.attname = 'org_id'
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace and a.attname <> 'org_id'
      order by 1, 2`,
  );
  return r.rows;
}

/** Points company A's `link.child` record at `target`: "taken", or the code the database refused it with. */
async function point(link: Link, record: string, target: string) {
  return admin
    .query(`update "${link.child}" set "${link.col}" = $1 where id = $2`, [
      target,
      record,
    ])
    .then(
      (r) => (r.rowCount === 1 ? "taken" : `${r.rowCount} rows`),
      (err: { code?: string }) => `refused ${err.code}`,
    );
}

/** A shared template row of `table`, taken by `link` inside a transaction rolled back, so it never stays. */
async function takesTemplate(link: Link, record: string) {
  const c = await admin.connect();
  try {
    await c.query("begin");
    const row = TEMPLATES[link.parent] ?? {};
    const cols = Object.keys(row);
    const t = await c.query<{ id: string }>(
      `insert into ${link.parent} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row),
    );
    const r = await c.query(
      `update "${link.child}" set "${link.col}" = $1 where id = $2`,
      [t.rows[0]?.id, record],
    );
    return r.rowCount === 1 ? "taken" : `${r.rowCount} rows`;
  } catch (err) {
    return `refused ${(err as { code?: string }).code}`;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

let orgA = "";
let a: Rows = {};
let b: Rows = {};

beforeAll(async () => {
  orgA = (await companies.add("Links A")).id;
  a = await oneOfEach(orgA);
  b = await oneOfEach((await companies.add("Links B")).id);
});

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

describe("links between company records", () => {
  // behaviour already on main: migration 019 is applied to the one local database both copies of the code run against; before it, all 43 links took another company's record
  it("each refuses another company's record, and still takes the company's own and, where it may, a shared template", async () => {
    const all = await links();
    expect(all.length).toBeGreaterThanOrEqual(43);
    const seen: string[] = [];
    for (const link of all) {
      const record = a[link.child];
      const own = a[link.parent];
      const theirs = b[link.parent];
      if (!record || !own || !theirs) {
        seen.push(`${link.child}.${link.col}: no test record`);
        continue;
      }
      const name = `${link.child}.${link.col} → ${link.parent}`;
      seen.push(`${name}: own ${await point(link, record, own)}`);
      seen.push(
        `${name}: other company's ${await point(link, record, theirs)}`,
      );
      if (link.shared)
        seen.push(`${name}: template ${await takesTemplate(link, record)}`);
    }
    const expected = all.flatMap((l) => {
      const name = `${l.child}.${l.col} → ${l.parent}`;
      return [
        `${name}: own taken`,
        `${name}: other company's refused 23503`,
        ...(l.shared ? [`${name}: template taken`] : []),
      ];
    });
    expect(seen).toEqual(expected);
  });

  // behaviour already on main: migration 019 is applied to the one local database both copies of the code run against; before it, the worker's login took another company's workflow
  it("refuses another company's record to the worker's own login too, where a trigger guards the link", async () => {
    const worker = createPool(
      process.env.DATABASE_URL ||
        "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
    );
    const run = (workflow = "") =>
      withOrg(worker, orgA, (tx) =>
        tx.query(
          `insert into workflow_runs (org_id, workflow_id, contact_id) values ($1, $2, $3)`,
          [orgA, workflow, a.contacts],
        ),
      ).then(
        () => "taken",
        (err: { code?: string }) => `refused ${err.code}`,
      );
    try {
      expect([await run(b.workflows), await run(a.workflows)]).toEqual([
        "refused 23503",
        "taken",
      ]);
    } finally {
      await worker.end();
    }
  });
});

/** Runs the check every PR runs after `setup`, in a transaction rolled back: "passed", or the error it raised. */
async function checkAfter(setup: string): Promise<string> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query(setup);
    await c.query(RULES);
    return "passed";
  } catch (err) {
    return (err as Error).message;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

describe("the database check every PR runs (tests/rls_coverage.sql)", () => {
  const t = `links_check_${randomUUID().slice(0, 8)}`;
  const parent = `create table ${t}_p (id uuid primary key, org_id uuid not null, unique (org_id, id));
    alter table ${t}_p enable row level security;`;
  const child = (cols: string) =>
    `create table ${t}_c (id uuid primary key, org_id uuid not null, ${cols});
     alter table ${t}_c enable row level security;`;

  // behaviour already on main: tests/rls_coverage.sql sits in tests/, so main's copy of the code runs this change's check too; main's check passed every one of these
  it("fails a link that could cross companies, a duplicate key without the company, a key two shared templates may share and a company that may be empty", async () => {
    const crossing = await checkAfter(
      parent + child(`p_id uuid references ${t}_p (id)`),
    );
    const globalKey = await checkAfter(child("ref text unique"));
    const emptyCompany = await checkAfter(
      `create table ${t}_n (id uuid primary key, org_id uuid);
       alter table ${t}_n enable row level security;`,
    );
    const unguardedTemplate = await checkAfter(
      child("agent_id uuid references agents (id)"),
    );
    // The agents key as it was before migration 019: two shared templates, both with no company, could share it.
    const templatesShareKey = await checkAfter(
      `alter table agents drop constraint agents_org_id_key_version_key,
         add constraint agents_org_id_key_version_key unique (org_id, key, version);`,
    );
    expect(templatesShareKey).toContain("agents (org_id, key, version)");
    expect(crossing).toContain(`${t}_c.p_id → ${t}_p`);
    expect(globalKey).toContain(`${t}_c (ref)`);
    expect(emptyCompany).toContain(`${t}_n.org_id`);
    expect(unguardedTemplate).toContain(`${t}_c.agent_id → agents`);
  });

  // behaviour already on main: the check (tests/rls_coverage.sql) comes along to main's copy, and migration 019's trigger function is on the one local database; on a database without it, this failed
  it("passes a link that keeps both records in one company, and a link to a shared template its trigger guards", async () => {
    expect(
      await checkAfter(
        parent +
          child(
            `p_id uuid, foreign key (org_id, p_id) references ${t}_p (org_id, id)`,
          ),
      ),
    ).toBe("passed");
    expect(
      await checkAfter(
        `${child("agent_id uuid references agents (id)")}
         create trigger ${t}_agent after insert or update on ${t}_c
           for each row execute function app.same_company_or_template('agent_id', 'agents');`,
      ),
    ).toBe("passed");
  });
});
