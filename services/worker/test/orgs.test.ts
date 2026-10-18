// Two tenants stay isolated (the cross-tenant denial test AGENTS.md requires) — exercised at the
// API surface: real local sign-in users, jose-verified JWTs, app_service DB path underneath. Only our operator
// list may create a company (supabase/migrations/018_platform_operators.sql): user A is on it, user B is not.
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { type TestUser, testUser } from "../../../tests/test-users";
import { pool } from "../src/db";
import app from "../src/index";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 1,
});
const companies = testCompanies(admin);

function api(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
  );
}

let userA: TestUser;
let userB: TestUser;
let orgA = "";
let orgAName = "";
let orgASlug = "";

/** User A makes a company through POST /orgs, the route under test: its id and name, and the reply. */
async function createAsA(label: string) {
  await users();
  let made = { name: "", slug: "", status: 0, role: "" };
  const { id } = await companies.add(label, async (name, slug) => {
    const res = await api("/orgs", userA.token, {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    const body = (await res.json()) as { id: string; role: string };
    made = { name, slug, status: res.status, role: body.role };
    return body.id;
  });
  return { id, ...made };
}

/**
 * User A (an operator) or user B (not one) tries to make a company with `body`, or with no body when it gives
 * undefined: the reply, and whether no company was made.
 */
async function tries(
  who: "A" | "B",
  body: (name: string, slug: string) => string | undefined,
) {
  await users();
  let reply = { status: 0, body: {} as unknown };
  const made = companies.add(`${who}'s company`, async (name, slug) => {
    const res = await api("/orgs", (who === "A" ? userA : userB).token, {
      method: "POST",
      body: body(name, slug),
    });
    reply = { status: res.status, body: await res.json() };
    return (reply.body as { id?: string }).id ?? "";
  });
  const refused = await made.then(
    () => false,
    (err: Error) => /not made/.test(err.message),
  );
  return { ...reply, refused };
}

let made: Promise<void> | undefined;
/**
 * Makes user A, on our operator list, and user B, not on it, once, inside the first test that needs them: where
 * logins can't be made yet (main's code, before invite-only), that test fails, rather than the file's set-up.
 */
const users = () =>
  (made ??= (async () => {
    userA = await testUser(admin, "tenant-a", { operator: true });
    userB = await testUser(admin, "tenant-b");
  })());

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

describe("auth gate — JWT verification (docs/security.md S1.5)", () => {
  it("rejects requests with no token", async () => {
    const res = await api("/orgs", null);
    expect(res.status).toBe(401);
  });

  it("rejects a garbage token", async () => {
    const res = await api("/orgs", "not.a.jwt");
    expect(res.status).toBe(401);
  });
});

describe("org bootstrap + tenant isolation", () => {
  it("user A creates an org and becomes its admin", async () => {
    const made = await createAsA("Tenant A");
    expect(made.status).toBe(201);
    expect(made.role).toBe("admin");
    ({ id: orgA, name: orgAName, slug: orgASlug } = made);
  });

  it("a signed-in person not on our operator list cannot create a company", async () => {
    const tried = await tries("B", (name, slug) =>
      JSON.stringify({ name, slug }),
    );
    expect(tried).toEqual({
      status: 403,
      body: { error: "not_an_operator" },
      refused: true,
    });
  });

  // Asked before the body is read, so a stranger can't learn which slugs are taken (409) or probe the body's shape.
  it("refuses a stranger before reading the body: a taken slug and a body that isn't JSON get the same 403", async () => {
    const taken = await tries("B", (name) =>
      JSON.stringify({ name, slug: orgASlug }),
    );
    const garbled = await tries("B", () => "{not json");
    for (const tried of [taken, garbled])
      expect(tried).toEqual({
        status: 403,
        body: { error: "not_an_operator" },
        refused: true,
      });
  });

  it("answers an operator's missing, garbled, empty or nameless body with 400, and makes no company", async () => {
    const bodies = [
      () => undefined,
      () => "{not json",
      () => "{}",
      (_: string, slug: string) => JSON.stringify({ name: "", slug }),
    ];
    for (const body of bodies)
      expect(await tries("A", body)).toEqual({
        status: 400,
        body: { error: "invalid_request" },
        refused: true,
      });
  });

  // behaviour already on main: orgs.slug is unique and the error handler answers that with 409
  it("answers an operator who creates a company under a taken slug with 409, and keeps one company under it", async () => {
    const again = await tries("A", (name) =>
      JSON.stringify({ name, slug: orgASlug }),
    );
    expect(again).toEqual({
      status: 409,
      body: { error: "conflict" },
      refused: true,
    });
    const under = await admin.query(`select id from orgs where slug = $1`, [
      orgASlug,
    ]);
    expect(under.rows).toEqual([{ id: orgA }]);
  });

  it("answers 500, and makes no company, when the operator list can't be asked", async () => {
    const lookup = spyOn(pool, "query").mockImplementationOnce((() =>
      Promise.reject(new Error("database went away"))) as never);
    try {
      expect(
        await tries("A", (name, slug) => JSON.stringify({ name, slug })),
      ).toEqual({ status: 500, body: { error: "internal" }, refused: true });
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });

  // The other door to the companies table: the database's own data interface, with the stranger's sign-in token.
  // behaviour already on main: the orgs insert policy (002_rls.sql) lets in only a company the worker's transaction names
  it("refuses a stranger who inserts a company through the database's data interface", async () => {
    await users();
    let status = 0;
    const made = companies.add("Data interface company", async (name, slug) => {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orgs`, {
        method: "POST",
        headers: {
          apikey: ANON_KEY,
          authorization: `Bearer ${userB.token}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        body: JSON.stringify({ name, slug }),
      });
      status = res.status;
      return res.ok
        ? (((await res.json()) as Array<{ id: string }>)[0]?.id ?? "")
        : "";
    });
    await expect(made).rejects.toThrow(/not made/);
    expect([401, 403]).toContain(status);
  });

  it("GET /orgs shows each user only their own orgs", async () => {
    const resA = await api("/orgs", userA.token);
    expect(resA.status).toBe(200);
    const orgsA = (await resA.json()) as Array<{ id: string }>;
    expect(orgsA.some((o) => o.id === orgA)).toBe(true);

    const resB = await api("/orgs", userB.token);
    const orgsB = (await resB.json()) as Array<{ id: string }>;
    expect(orgsB.some((o) => o.id === orgA)).toBe(false);
  });

  // The console's / landing opens the FIRST workspace, so GET /orgs must have a defined order: by name.
  it("GET /orgs lists a user's workspaces by name", async () => {
    const zulu = await createAsA("Zulu Org");
    const alpha = await createAsA("Alpha Org");
    expect([zulu.status, alpha.status]).toEqual([201, 201]);
    const orgs = (await (await api("/orgs", userA.token)).json()) as Array<{
      name: string;
    }>;
    expect(orgs.map((o) => o.name)).toEqual([alpha.name, orgAName, zulu.name]);
  });

  it("a non-member cannot add themselves to another tenant's org", async () => {
    const res = await api(`/orgs/${orgA}/members`, userB.token, {
      method: "POST",
      body: JSON.stringify({ userId: userB.userId, role: "admin" }),
    });
    expect(res.status).toBe(403);
  });

  it("admin invites a member; the member appears with the granted role", async () => {
    const res = await api(`/orgs/${orgA}/members`, userA.token, {
      method: "POST",
      body: JSON.stringify({ userId: userB.userId, role: "viewer" }),
    });
    expect(res.status).toBe(201);

    const resB = await api("/orgs", userB.token);
    const orgsB = (await resB.json()) as Array<{ id: string; role: string }>;
    const membership = orgsB.find((o) => o.id === orgA);
    expect(membership?.role).toBe("viewer");
  });

  it("giving someone access is audited: the admin's member.add row names the member and role, and the membership who granted it", async () => {
    const audits = await admin.query(
      `select actor_type, actor_id, resource_type, after from audit_log
        where org_id = $1 and action = 'member.add' and resource_id = $2`,
      [orgA, userB.userId],
    );
    expect(audits.rows).toEqual([
      {
        actor_type: "user",
        actor_id: userA.userId,
        resource_type: "member",
        after: { user_id: userB.userId, role: "viewer" },
      },
    ]);
    const grant = await admin.query(
      `select granted_by from org_members where org_id = $1 and user_id = $2`,
      [orgA, userB.userId],
    );
    expect(grant.rows).toEqual([{ granted_by: userA.userId }]);
    // A second add of the same person is refused (409) and writes no second row.
    await api(`/orgs/${orgA}/members`, userA.token, {
      method: "POST",
      body: JSON.stringify({ userId: userB.userId, role: "admin" }),
    });
    const again = await admin.query(
      `select count(*)::int n from audit_log where org_id = $1 and action = 'member.add' and resource_id = $2`,
      [orgA, userB.userId],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it("a new company's creator becomes its admin through an audited grant too", async () => {
    const audits = await admin.query(
      `select actor_type, actor_id, resource_type, after from audit_log
        where org_id = $1 and action = 'member.add' and resource_id = $2`,
      [orgA, userA.userId],
    );
    expect(audits.rows).toEqual([
      {
        actor_type: "user",
        actor_id: userA.userId,
        resource_type: "member",
        after: { user_id: userA.userId, role: "admin" },
      },
    ]);
  });

  it("answers an admin who adds a user id that names no one with 404 user_not_found, and writes no row", async () => {
    const nobody = crypto.randomUUID();
    const res = await api(`/orgs/${orgA}/members`, userA.token, {
      method: "POST",
      body: JSON.stringify({ userId: nobody, role: "viewer" }),
    });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 404,
      body: { error: "user_not_found" },
    });
    const rows = await admin.query(
      `select 1 from org_members where user_id = $1`,
      [nobody],
    );
    expect(rows.rowCount).toBe(0);
  });

  // behaviour already on main: a second membership breaks org_members' primary key, and the error handler answers 409
  it("answers an admin who adds someone already a member with 409, and keeps their role", async () => {
    const res = await api(`/orgs/${orgA}/members`, userA.token, {
      method: "POST",
      body: JSON.stringify({ userId: userB.userId, role: "admin" }),
    });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 409,
      body: { error: "conflict" },
    });
    const rows = await admin.query(
      `select role from org_members where org_id = $1 and user_id = $2`,
      [orgA, userB.userId],
    );
    expect(rows.rows).toEqual([{ role: "viewer" }]);
  });

  // behaviour already on main: the error handler answers every foreign-key failure with 500; this keeps the unknown-user catch from widening
  it("answers 500, not 404, and adds no one, when adding a member breaks any other foreign key", async () => {
    // A trigger, installed once and never dropped (as in scheduler-apply-poison.test.ts: dropping one on the local
    // stack locks auth's tables), breaks org_members_org_id_fkey for one fixed user id, before the user is checked.
    const faulted = "0000f417-0000-4000-8000-000000000000";
    await admin.query(`
      do $$ begin
        perform pg_advisory_xact_lock(hashtext('test_fault_member_fk'));
        create or replace function public.test_fault_member_fk() returns trigger language plpgsql as $f$
        begin
          if new.user_id = '${faulted}' then
            raise exception 'members fault injection' using errcode = '23503',
              constraint = 'org_members_org_id_fkey';
          end if;
          return new;
        end $f$;
        if not exists (select 1 from pg_trigger
                        where tgrelid = 'public.org_members'::regclass and tgname = 'test_fault_member_fk') then
          create trigger test_fault_member_fk before insert on public.org_members
            for each row execute function public.test_fault_member_fk();
        end if;
      end $$`);
    const res = await api(`/orgs/${orgA}/members`, userA.token, {
      method: "POST",
      body: JSON.stringify({ userId: faulted, role: "viewer" }),
    });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 500,
      body: { error: "internal" },
    });
    const rows = await admin.query(
      `select 1 from org_members where user_id = $1`,
      [faulted],
    );
    expect(rows.rowCount).toBe(0);
  });

  // behaviour already on main: AddMemberSchema refuses each of these bodies before the route reaches the database
  it("answers an admin's blank, malformed or missing user id, or missing role, with 400, and adds no one", async () => {
    const members = async () =>
      (
        await admin.query(
          `select user_id, role from org_members where org_id = $1 order by user_id`,
          [orgA],
        )
      ).rows;
    const before = await members();
    for (const body of [
      { userId: "", role: "viewer" },
      { userId: "not-a-uuid", role: "viewer" },
      {},
      { userId: crypto.randomUUID() },
    ]) {
      const res = await api(`/orgs/${orgA}/members`, userA.token, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 400,
        body: { error: "invalid_request" },
      });
    }
    expect(await members()).toEqual(before);
  });

  it("a viewer cannot invite members (role gate, docs/security.md S1.7)", async () => {
    const other = await testUser(admin, "outsider");
    const res = await api(`/orgs/${orgA}/members`, userB.token, {
      method: "POST",
      body: JSON.stringify({ userId: other.userId, role: "viewer" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown-shape body before any logic (docs/security.md S5.1)", async () => {
    // Through the helper, so a regression that accepts the body still has its company cleaned up.
    let status = 0;
    const made = companies.add("Sneaky", async (name, slug) => {
      const res = await api("/orgs", userA.token, {
        method: "POST",
        body: JSON.stringify({ name, slug, sneaky: true }),
      });
      status = res.status;
      return res.ok ? ((await res.json()) as { id: string }).id : "";
    });
    await expect(made).rejects.toThrow(/not made/);
    expect(status).toBe(400);
  });
});
