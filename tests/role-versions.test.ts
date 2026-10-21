// A role version's lifecycle, as the database holds it (migration 026): a version starts as a draft, only a draft
// changes, and it is tested and then put live only with a passing stored run of its whole test set, run against
// exactly its content. Fixtures are written as `postgres` (row-level security lets it through); the product's own
// login, app_service through withOrg, is held to the same rules.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool, withOrg } from "@revenue-os/db";
import { Pool } from "pg";
import { putLive } from "./live-version";
import { testCompanies } from "./test-companies";

const admin = new Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const app = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let org = "";
let n = 0;

beforeAll(async () => {
  org = (await companies.add("Role versions")).id;
});
afterAll(async () => {
  await companies.cleanup();
  await app.end();
  await admin.end();
});

/** A draft of a role of its own, naming `testSet`. */
async function draft(testSet: string[], status = "draft"): Promise<string> {
  n += 1;
  return (
    await admin.query<{ id: string }>(
      `insert into agents (org_id, key, version, status, model, system_prompt, goal, rules, facts_sections, test_set)
       values ($1, $2, 1, $3, 'anthropic:claude-sonnet-5-5', 'You help.', 'Book a meeting.',
               '{"outcomes":["meeting_booked"]}', '{projects,calendar}', $4) returning id`,
      [org, `role-${n}`, status, testSet],
    )
  ).rows[0]?.id as string;
}

/** One run of a test set: each [scenario key, passed] is a row of the same run, against the version as it is now. */
async function run(agentId: string, rows: [string, boolean][]): Promise<void> {
  const setRun = crypto.randomUUID();
  for (const [key, passed] of rows) {
    const scenario = (
      await admin.query<{ id: string }>(
        `insert into eval_scenarios (org_id, key, persona, script, assertions) values ($1, $2, '{}', '{}', '{}')
         on conflict (org_id, key) do update set key = excluded.key returning id`,
        [org, key],
      )
    ).rows[0]?.id;
    await admin.query(
      `insert into eval_runs (org_id, scenario_id, agent_id, passed, set_run) values ($1, $2, $3, $4, $5)`,
      [org, scenario, agentId, passed, setRun],
    );
  }
}

const statusOf = async (id: string) =>
  (await admin.query(`select status from agents where id = $1`, [id])).rows[0]
    ?.status;
const setStatus = (id: string, status: string) =>
  admin.query(`update agents set status = $2 where id = $1`, [id, status]);

describe("app.agent_version_lifecycle: a new version starts as a draft", () => {
  it("refuses a version written tested or live, and takes a draft naming every part of its role", async () => {
    await expect(draft(["a"], "active")).rejects.toThrow("starts as a draft");
    await expect(draft(["a"], "tested")).rejects.toThrow("starts as a draft");
    const id = await draft(["a", "b"]);
    const row = (
      await admin.query(
        `select status, engine, goal, rules, facts_sections, test_set from agents where id = $1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      status: "draft",
      engine: "v1",
      goal: "Book a meeting.",
      rules: { outcomes: ["meeting_booked"] },
      facts_sections: ["projects", "calendar"],
      test_set: ["a", "b"],
    });
  });

  it("refuses rules that are not an object and an engine it doesn't know", async () => {
    const id = await draft(["a"]);
    await expect(
      admin.query(`update agents set rules = '[]' where id = $1`, [id]),
    ).rejects.toThrow("check constraint");
    await expect(
      admin.query(`update agents set engine = 'v2' where id = $1`, [id]),
    ).rejects.toThrow("check constraint");
  });
});

describe("app.version_passed: tested, then live, only with a passing stored run of the whole test set", () => {
  it("refuses tested with no run, a run that misses a scenario of the set, or one with a failed row", async () => {
    const id = await draft(["greets", "books"]);
    await expect(setStatus(id, "tested")).rejects.toThrow(
      "no passing stored run of its whole test set (greets, books)",
    );
    await run(id, [["greets", true]]);
    await expect(setStatus(id, "tested")).rejects.toThrow("no passing");
    await run(id, [
      ["greets", true],
      ["books", false],
    ]);
    await expect(setStatus(id, "tested")).rejects.toThrow("no passing");
    // rows of two different runs never add up to one run of the whole set
    await run(id, [["books", true]]);
    expect(
      (
        await admin.query(
          `select app.version_passed(a) as passed from agents a where id = $1`,
          [id],
        )
      ).rows[0]?.passed,
    ).toBe(false);
    expect(await statusOf(id)).toBe("draft");
  });

  it("takes a version tested and then live once one run passes every scenario of its set", async () => {
    const id = await draft(["greets", "books"]);
    await run(id, [
      ["greets", true],
      ["books", true],
    ]);
    await setStatus(id, "tested");
    await setStatus(id, "active");
    expect(await statusOf(id)).toBe("active");
  });

  it("never passes a version whose test set is empty", async () => {
    const id = await draft([]);
    await run(id, [["anything", true]]);
    await expect(setStatus(id, "tested")).rejects.toThrow(
      "(it names none), so it can't be tested",
    );
  });

  it("doesn't count a run of the draft's earlier content", async () => {
    const id = await draft(["greets"]);
    await run(id, [["greets", true]]);
    await admin.query(
      `update agents set system_prompt = 'You help, briefly.' where id = $1`,
      [id],
    );
    await expect(setStatus(id, "tested")).rejects.toThrow("no passing");
    // nor a change made in the same statement that tests it
    await run(id, [["greets", true]]);
    await expect(
      admin.query(
        `update agents set status = 'tested', goal = 'Something else.' where id = $1`,
        [id],
      ),
    ).rejects.toThrow("no passing");
    await setStatus(id, "tested");
    expect(await statusOf(id)).toBe("tested");
  });
});

describe("app.agent_version_lifecycle: a version that is not a draft never changes, and nothing goes back", () => {
  it("refuses any change but its status once tested or live, and lets it be archived", async () => {
    const id = await draft(["greets"]);
    await run(id, [["greets", true]]);
    await setStatus(id, "tested");
    for (const change of [
      "system_prompt = 'Other words.'",
      "model = 'anthropic:claude-opus-5-5'",
      "tools_allowed = '{send_confirmation}'",
    ])
      await expect(
        admin.query(`update agents set ${change} where id = $1`, [id]),
      ).rejects.toThrow("version 1 of role-");
    await setStatus(id, "active");
    await expect(
      admin.query(`update agents set rules = '{"outcomes":[]}' where id = $1`, [
        id,
      ]),
    ).rejects.toThrow("is active: only its status may change");
    await setStatus(id, "archived");
    expect(await statusOf(id)).toBe("archived");
  });

  it("refuses skipping tested, going back, and leaving archived", async () => {
    const skip = await draft(["greets"]);
    await run(skip, [["greets", true]]);
    await expect(setStatus(skip, "active")).rejects.toThrow(
      "can't go from draft to active",
    );
    const live = await putLive(admin, org, { key: `live-${++n}` });
    for (const back of ["draft", "tested"])
      await expect(setStatus(live, back)).rejects.toThrow(
        `can't go from active to ${back}`,
      );
    await setStatus(live, "archived");
    await expect(setStatus(live, "active")).rejects.toThrow(
      "can't go from archived to active",
    );
  });

  it("holds the product's own login to the same rules", async () => {
    const id = await draft(["greets"]);
    const tested = (sql: string) =>
      withOrg(app, org, (tx) =>
        tx.query(`${sql} where id = $1 and org_id = $2`, [id, org]),
      );
    await expect(tested("update agents set status = 'tested'")).rejects.toThrow(
      "no passing",
    );
    // a run the product writes is stamped by the database, whatever stamp the writer gives
    const scenario = (
      await admin.query<{ id: string }>(
        `insert into eval_scenarios (org_id, key, persona, script, assertions) values ($1, 'greets', '{}', '{}', '{}')
         on conflict (org_id, key) do update set key = excluded.key returning id`,
        [org],
      )
    ).rows[0]?.id;
    await withOrg(app, org, (tx) =>
      tx.query(
        `insert into eval_runs (org_id, scenario_id, agent_id, passed, set_run, agent_digest)
         values ($1, $2, $3, true, gen_random_uuid(), 'forged')`,
        [org, scenario, id],
      ),
    );
    await tested("update agents set status = 'tested'");
    expect(await statusOf(id)).toBe("tested");
    await expect(tested("update agents set goal = 'More.'")).rejects.toThrow(
      "only its status may change",
    );
  });
});

describe("app.stamp_eval_run and app.agent_digest: a run is tied to the content it ran against", () => {
  it("stamps the version's fingerprint when the run is written and keeps it on any later update", async () => {
    const id = await draft(["greets"]);
    await run(id, [["greets", true]]);
    const digestNow = async () =>
      (
        await admin.query(
          `select app.agent_digest(a) as d from agents a where id = $1`,
          [id],
        )
      ).rows[0]?.d;
    const stamped = async () =>
      (
        await admin.query(
          `select agent_digest from eval_runs where agent_id = $1`,
          [id],
        )
      ).rows[0]?.agent_digest;
    const first = await digestNow();
    expect(await stamped()).toBe(first);
    await admin.query(
      `update eval_runs set agent_digest = 'moved' where agent_id = $1`,
      [id],
    );
    expect(await stamped()).toBe(first);
    // the fingerprint follows the content, never the status
    await setStatus(id, "tested");
    expect(await digestNow()).toBe(first);
    const other = await draft(["greets"]);
    await admin.query(`update agents set goal = 'Other.' where id = $1`, [
      other,
    ]);
    const before = (
      await admin.query(
        `select app.agent_digest(a) as d from agents a where id = $1`,
        [other],
      )
    ).rows[0]?.d;
    await admin.query(`update agents set goal = 'Again.' where id = $1`, [
      other,
    ]);
    expect(
      (
        await admin.query(
          `select app.agent_digest(a) as d from agents a where id = $1`,
          [other],
        )
      ).rows[0]?.d,
    ).not.toBe(before);
  });
});
