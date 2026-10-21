// GET /orgs/:orgId/agents (the console's Agents page on real data) returns the org's agents +
// workflows lists. A tenancy-critical org-scoped read endpoint: 401 without a token, 403 for a
// non-member, and org B's rows NEVER leak into org A's response. It also pins the lean wire shape
// (docs/security.md S5.8: no system_prompt / voice_config / language_config on agents; no
// definition on workflows) and the deterministic order (key asc, then version desc).
//
// Real local stack (supabase + real pg): accounts are invite-only, so each person is made locally
// and signed in through the local sign-in server (tests/test-users.ts); it runs with the local
// stack's settings (`bun run gate`, CI). Mirrors services/worker/test/screens-api.test.ts
// (test users, POST /orgs through the shared test-company helper, admin pool seeds rows).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { type TestUser, testUser } from "../../../tests/test-users";
import app from "../src/index";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

function api(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
  );
}

const companies = testCompanies(admin);

/** A company made through the product's own POST /orgs, which makes `token`'s user its admin. */
async function makeOrg(token: string): Promise<string> {
  const { id } = await companies.add("Agents Org", async (name, slug) => {
    const res = await api("/orgs", token, {
      method: "POST",
      body: JSON.stringify({ name, slug, vertical: "real_estate" }),
    });
    const body = (await res.json()) as { id?: string };
    if (res.status !== 201 || !body.id)
      throw new Error(`org bootstrap failed: ${res.status}`);
    return body.id;
  });
  return id;
}

let userA: TestUser;
let userB: TestUser;
let orgA = "";
let orgB = "";
// Distinctive key prefix isolates these fixtures from any global-template rows (org_id IS NULL,
// readable by every member per migration 006) so the count/order asserts stay deterministic.
const PREFIX = `agents-api-${Date.now()}-`;

beforeAll(async () => {
  userA = await testUser(admin, "agents-a", { operator: true });
  userB = await testUser(admin, "agents-b", { operator: true });
  orgA = await makeOrg(userA.token);
  orgB = await makeOrg(userB.token);

  // orgA — two keys, one carrying two versions, to pin (key asc, version desc); drafts, as every new version starts. Distinctive
  // system_prompt / definition values so the lean-shape asserts prove internals are never shipped.
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt)
     values ($1, $2, 1, 'draft',  'model-alpha-v1', 'SECRET-PROMPT-ALPHA-1'),
            ($1, $2, 2, 'draft',  'model-alpha-v2', 'SECRET-PROMPT-ALPHA-2'),
            ($1, $3, 1, 'draft',  'model-beta-v1',  'SECRET-PROMPT-BETA-1')`,
    [orgA, `${PREFIX}alpha`, `${PREFIX}beta`],
  );
  await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', '{"secret":"WF-DEF-SECRET"}'::jsonb),
            ($1, $2, 2, 'draft',  '{"steps":[]}'::jsonb)`,
    [orgA, `${PREFIX}flow`],
  );

  // orgB — rows that must NEVER appear in orgA's response (the load-bearing cross-tenant assert).
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt)
     values ($1, $2, 1, 'draft', 'ORGB-MODEL-SECRET', 'ORGB-PROMPT-SECRET')`,
    [orgB, `${PREFIX}orgb`],
  );
  await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', '{"secret":"ORGB-WF-SECRET"}'::jsonb)`,
    [orgB, `${PREFIX}orgb-flow`],
  );
});

type Row = Record<string, unknown>;

async function readAgents(): Promise<{ agents: Row[]; workflows: Row[] }> {
  const res = await api(`/orgs/${orgA}/agents`, userA.token);
  expect(res.status).toBe(200);
  return (await res.json()) as { agents: Row[]; workflows: Row[] };
}

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

describe("auth gate (docs/security.md S1.5)", () => {
  it("GET /orgs/:orgId/agents without a token → 401", async () => {
    const res = await api(`/orgs/${orgA}/agents`, null);
    expect(res.status).toBe(401);
  });
});

describe("cross-org denial — the load-bearing tenancy asserts", () => {
  it("non-member GET → 403, and no orgA row text leaks", async () => {
    const res = await api(`/orgs/${orgA}/agents`, userB.token);
    expect(res.status).toBe(403);
    const txt = await res.text();
    expect(txt).not.toContain(`${PREFIX}alpha`);
    expect(txt).not.toContain("SECRET-PROMPT-ALPHA");
  });

  it("member GET never returns another org's rows (RLS org-scoping)", async () => {
    const res = await api(`/orgs/${orgA}/agents`, userA.token);
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).not.toContain(`${PREFIX}orgb`);
    expect(txt).not.toContain("ORGB-MODEL-SECRET");
    expect(txt).not.toContain("ORGB-PROMPT-SECRET");
    expect(txt).not.toContain("ORGB-WF-SECRET");
  });
});

describe("member reads the org's agents + workflows", () => {
  it("responds with { agents, workflows } arrays", async () => {
    const body = await readAgents();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.workflows)).toBe(true);
  });

  it("agents carry the lean list fields and NOTHING internal (docs/security.md S5.8)", async () => {
    const mine = (await readAgents()).agents.filter((a) =>
      String(a.key).startsWith(PREFIX),
    );
    expect(mine.length).toBe(3);
    for (const a of mine) {
      for (const k of ["id", "key", "version", "status", "model", "created_at"])
        expect(a).toHaveProperty(k);
      expect(a).not.toHaveProperty("system_prompt");
      expect(a).not.toHaveProperty("voice_config");
      expect(a).not.toHaveProperty("language_config");
      expect(a).not.toHaveProperty("tools_allowed");
      expect(typeof a.version).toBe("number");
    }
  });

  it("workflows carry the lean list fields and NO definition (docs/security.md S5.8)", async () => {
    const mine = (await readAgents()).workflows.filter((w) =>
      String(w.key).startsWith(PREFIX),
    );
    expect(mine.length).toBe(2);
    for (const w of mine) {
      for (const k of ["id", "key", "version", "status", "created_at"])
        expect(w).toHaveProperty(k);
      expect(w).not.toHaveProperty("definition");
      expect(typeof w.version).toBe("number");
    }
  });

  it("deterministic order: key asc, then version desc (agents)", async () => {
    const seq = (await readAgents()).agents
      .filter((a) => String(a.key).startsWith(PREFIX))
      .map((a) => `${a.key}#${a.version}`);
    expect(seq).toEqual([
      `${PREFIX}alpha#2`,
      `${PREFIX}alpha#1`,
      `${PREFIX}beta#1`,
    ]);
  });

  it("deterministic order: key asc, then version desc (workflows)", async () => {
    const seq = (await readAgents()).workflows
      .filter((w) => String(w.key).startsWith(PREFIX))
      .map((w) => `${w.key}#${w.version}`);
    expect(seq).toEqual([`${PREFIX}flow#2`, `${PREFIX}flow#1`]);
  });

  it("never ships the seeded prompt / definition text on the wire (docs/security.md S5.8)", async () => {
    const txt = await (await api(`/orgs/${orgA}/agents`, userA.token)).text();
    expect(txt).not.toContain("SECRET-PROMPT-ALPHA");
    expect(txt).not.toContain("SECRET-PROMPT-BETA");
    expect(txt).not.toContain("WF-DEF-SECRET");
  });
});
