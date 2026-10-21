// A lead is enrolled with a role or in a sequence, never both (migration 026). The one enrolment function, startRun,
// refuses a lead whose role assignment has not ended; the assignment's one writer, setAssignment, refuses a lead with an
// open run; and the console's route (PUT /orgs/:orgId/contacts/:contactId/assignment) says which role works a lead, for
// an operator or admin only. Each locks the lead first, so an enrolment and an assignment at the same moment never both
// pass. On the real local database as app_service, the worker's own login, and through the real routes.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool, setAssignment, withOrg } from "@revenue-os/db";
import pg from "pg";
import { putLive } from "../../../tests/live-version";
import { testCompanies } from "../../../tests/test-companies";
import { type TestUser, testUser } from "../../../tests/test-users";
import app from "../src/index";
import { LeadHasRoleError, startRun } from "../src/runs";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
const DEFINITION = { entry: "end", steps: { end: { kind: "end" } } };

let owner: TestUser;
let operator: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let org = "";
let other = "";
let sequenceId = "";

function api(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
  );
}

async function createOrg(user: TestUser, label: string): Promise<string> {
  const { id } = await companies.add(label, async (name, slug) => {
    const res = await api("/orgs", user.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug, vertical: "generic" }),
    });
    return ((await res.json()) as { id: string }).id;
  });
  return id;
}

async function invite(userId: string, role: string) {
  const res = await api(`/orgs/${org}/members`, owner.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status}`);
}

async function lead(company = org): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, 'Farah') returning id`,
    [company],
  );
  return r.rows[0]?.id ?? "";
}

const assign = (
  contactId: string,
  status: "active" | "paused" | "with_person" | "ended",
) =>
  withOrg(appPool, org, (tx) =>
    setAssignment(tx, org, contactId, {
      roleKey: "sales",
      status,
      why: "test",
      actor: { type: "system" },
    }),
  );
const enrol = (contactId: string) =>
  startRun(appPool, org, { workflowId: sequenceId, contactId });
const runs = async (contactId: string) =>
  (
    await admin.query(
      `select id from workflow_runs where org_id = $1 and contact_id = $2`,
      [org, contactId],
    )
  ).rowCount;

const put = (
  contactId: string,
  token: string | null,
  body: unknown,
  company = org,
) =>
  api(`/orgs/${company}/contacts/${contactId}/assignment`, token, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  owner = await testUser(admin, "role-or-seq-owner", { operator: true });
  stranger = await testUser(admin, "role-or-seq-stranger", { operator: true });
  operator = await testUser(admin, "role-or-seq-operator");
  viewer = await testUser(admin, "role-or-seq-viewer");
  org = await createOrg(owner, "Role or sequence");
  other = await createOrg(stranger, "Role or sequence, elsewhere");
  await invite(operator.userId, "operator");
  await invite(viewer.userId, "viewer");
  await putLive(admin, org, { key: "sales" });
  sequenceId = (
    await admin.query<{ id: string }>(
      `insert into workflows (org_id, key, version, status, definition) values ($1, 'seq', 1, 'active', $2::jsonb) returning id`,
      [org, JSON.stringify(DEFINITION)],
    )
  ).rows[0]?.id as string;
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

describe("startRun: a lead a role works is never enrolled in a sequence too", () => {
  it("refuses a lead whose role assignment is active, paused or with a person, naming the role, and writes no run", async () => {
    for (const status of ["active", "paused", "with_person"] as const) {
      const id = await lead();
      await assign(id, status);
      const tried = enrol(id);
      await expect(tried).rejects.toBeInstanceOf(LeadHasRoleError);
      await expect(tried).rejects.toMatchObject({ roleKey: "sales", status });
      expect(await runs(id)).toBe(0);
    }
  });

  it("enrols the lead once the role's assignment has ended", async () => {
    const id = await lead();
    await assign(id, "active");
    await assign(id, "ended");
    expect(await enrol(id)).toBeString();
    expect(await runs(id)).toBe(1);
  });

  it("never lets an enrolment and an assignment made at the same moment both pass", async () => {
    for (let i = 0; i < 8; i++) {
      const id = await lead();
      const [run, role] = await Promise.allSettled([
        enrol(id),
        assign(id, "active"),
      ]);
      const enrolled = run.status === "fulfilled";
      const assigned = role.status === "fulfilled" && role.value.ok;
      expect(enrolled !== assigned).toBe(true); // exactly one
      if (!enrolled)
        expect(run.status === "rejected" && run.reason).toBeInstanceOf(
          LeadHasRoleError,
        );
      if (!assigned)
        expect(role.status === "fulfilled" && role.value).toMatchObject({
          refused: "in_sequence",
        });
    }
  });
});

describe("PUT /orgs/:orgId/contacts/:contactId/assignment", () => {
  it("lets an operator say which role works a lead and why, and an admin change it", async () => {
    const id = await lead();
    const res = await put(id, operator.token, {
      roleKey: "sales",
      status: "active",
      why: "new enquiry",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      assignment: expect.objectContaining({
        roleKey: "sales",
        status: "active",
        why: "new enquiry",
      }),
    });
    const changed = await put(id, owner.token, {
      roleKey: "sales",
      status: "with_person",
      why: "a person took it",
    });
    expect(changed.status).toBe(200);
    const row = await admin.query(
      `select status, why from agent_assignments where org_id = $1 and contact_id = $2`,
      [org, id],
    );
    expect(row.rows).toEqual([
      { status: "with_person", why: "a person took it" },
    ]);
  });

  it("refuses a lead in a sequence (409, naming its run) unless the assignment ends", async () => {
    const id = await lead();
    const runId = await enrol(id);
    const res = await put(id, operator.token, {
      roleKey: "sales",
      status: "active",
      why: "x",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "lead_in_sequence",
      run_id: runId,
    });
    expect(
      (
        await put(id, operator.token, {
          roleKey: "sales",
          status: "ended",
          why: "closing it",
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a role the company has no version of (422), and a body it can't read (400)", async () => {
    const id = await lead();
    expect(
      (
        await put(id, operator.token, {
          roleKey: "closer",
          status: "active",
          why: "x",
        })
      ).status,
    ).toBe(422);
    for (const bad of [
      null,
      {},
      { roleKey: "sales", status: "live", why: "x" },
      { roleKey: "sales", status: "active", why: "  " },
      { roleKey: "sales", status: "active", why: "x".repeat(501) },
      { roleKey: "", status: "active", why: "x" },
      { roleKey: "sales", status: "active", why: "x", extra: true },
    ])
      expect((await put(id, operator.token, bad)).status).toBe(400);
    expect(
      (
        await admin.query(
          `select 1 from agent_assignments where contact_id = $1`,
          [id],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("refuses a viewer, another company's admin and no sign-in, and finds no lead of another company", async () => {
    const id = await lead();
    const body = { roleKey: "sales", status: "active", why: "x" };
    expect((await put(id, viewer.token, body)).status).toBe(403);
    expect((await put(id, stranger.token, body)).status).toBe(403);
    expect((await put(id, null, body)).status).toBe(401);
    const theirs = await lead(other);
    expect((await put(theirs, operator.token, body)).status).toBe(404);
    expect((await put(randomUUID(), operator.token, body)).status).toBe(404);
    expect(
      (
        await admin.query(
          `select 1 from agent_assignments where contact_id = any($1::uuid[])`,
          [[id, theirs]],
        )
      ).rowCount,
    ).toBe(0);
  });
});
