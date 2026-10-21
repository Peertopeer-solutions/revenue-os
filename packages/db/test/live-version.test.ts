// liveVersion (packages/db/src/agents.ts): the engine's one read of a role, the version live for the company now,
// whole and checked, so a turn takes every part of its role from the row (migration 026). The company's own version
// comes before a shared template's, a version not live is never read, and a live row the version schema refuses throws
// rather than running half a role. Read on the product's own login (app_service, through withOrg).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { putLive } from "../../../tests/live-version";
import { testCompanies } from "../../../tests/test-companies";
import { createPool, liveVersion, withOrg } from "../src";

const admin = new pg.Pool({
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
const templates: string[] = [];
let org = "";

const read = (key: string, company = org) =>
  withOrg(app, company, (tx) => liveVersion(tx, company, key));
const role = () => `role_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  org = (await companies.add("Live version")).id;
});
afterAll(async () => {
  await companies.cleanup(); // the template versions' runs belong to the test company, so they go first
  await admin.query(
    `delete from agents where org_id is null and id = any($1::uuid[])`,
    [templates],
  );
  await app.end();
  await admin.end();
});

describe("liveVersion: the version a turn runs on", () => {
  it("reads every part of the live version: model, prompt, goal, rules, tools, facts sections and test set", async () => {
    const key = role();
    const id = await putLive(admin, org, {
      key,
      model: "anthropic:claude-haiku-5-5",
      systemPrompt: "You answer buyers.",
      goal: "Every buyer gets an answer within minutes.",
      toolsAllowed: ["book_appointment"],
      rules: {
        outcomes: ["meeting_booked"],
        booking: { kind: "meeting", outcome: "meeting_booked" },
      },
    });
    expect(await read(key)).toEqual({
      id,
      orgId: org,
      key,
      version: 1,
      status: "active",
      engine: "v1",
      model: "anthropic:claude-haiku-5-5",
      prompt: "You answer buyers.",
      goal: "Every buyer gets an answer within minutes.",
      rules: {
        actions: [],
        limits: [],
        askAPerson: [],
        handOver: [],
        approval: {},
        outcomes: ["meeting_booked"],
        booking: { kind: "meeting", outcome: "meeting_booked" },
      },
      tools: ["book_appointment"],
      factsSections: [],
      testSet: [`${key}-v1-check`],
    });
  });

  it("reads the newest live version, never a draft, a tested or an archived one, and none when none is live", async () => {
    const key = role();
    expect(await read(key)).toBeNull();
    const v1 = await putLive(admin, org, { key, version: 1 });
    const v2 = await putLive(admin, org, { key, version: 2 });
    await admin.query(
      `insert into agents (org_id, key, version, status, model, system_prompt) values ($1, $2, 3, 'draft', 'x', 'x')`,
      [org, key],
    );
    expect((await read(key))?.id).toBe(v2);
    await admin.query(`update agents set status = 'archived' where id = $1`, [
      v2,
    ]);
    expect((await read(key))?.id).toBe(v1);
    await admin.query(`update agents set status = 'archived' where id = $1`, [
      v1,
    ]);
    expect(await read(key)).toBeNull();
  });

  it("reads the company's own live version before a shared template's, and the template when it has none", async () => {
    const key = role();
    // a shared template, version 5, put live through a run the test company's own scenario holds
    const template = (
      await admin.query<{ id: string }>(
        `insert into agents (org_id, key, version, status, model, system_prompt, test_set)
         values (null, $1, 5, 'draft', 'anthropic:claude-sonnet-5-5', 'Template.', '{template_check}') returning id`,
        [key],
      )
    ).rows[0]?.id as string;
    templates.push(template);
    const scenario = (
      await admin.query<{ id: string }>(
        `insert into eval_scenarios (org_id, key, persona, script, assertions)
         values ($1, 'template_check', '{}', '{}', '{}') returning id`,
        [org],
      )
    ).rows[0]?.id;
    await admin.query(
      `insert into eval_runs (org_id, scenario_id, agent_id, passed, set_run) values ($1, $2, $3, true, gen_random_uuid())`,
      [org, scenario, template],
    );
    for (const status of ["tested", "active"])
      await admin.query(`update agents set status = $2 where id = $1`, [
        template,
        status,
      ]);
    expect((await read(key))?.id).toBe(template);
    const own = await putLive(admin, org, { key, version: 1 });
    expect((await read(key))?.id).toBe(own);
  });

  it("refuses a live version whose model is off the platform's list or whose rules don't parse, naming it", async () => {
    const key = role();
    await putLive(admin, org, { key, model: "realtime-tier" });
    await expect(read(key)).rejects.toThrow(
      `live version 1 of role ${key} can't be used: model`,
    );
    const other = role();
    await putLive(admin, org, {
      key: other,
      rules: { booking: { kind: "meeting", outcome: "meeting_booked" } },
    });
    await expect(read(other)).rejects.toThrow(
      "rules.booking.outcome the outcome a booking records is one of the role's outcome names",
    );
  });

  it("reads none of another company's versions", async () => {
    const key = role();
    await putLive(admin, org, { key });
    const elsewhere = (await companies.add("Live version, elsewhere")).id;
    expect(await read(key, elsewhere)).toBeNull();
  });
});
