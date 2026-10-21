// Which role works a lead (agent_assignments, migration 026): one row per lead, written only by setAssignment, which
// refuses a lead the company doesn't have, a role it can't use and a lead in a sequence, and audits every change.
// Another company can neither see nor write a company's assignments. Written on the product's own login (app_service,
// through withOrg), as production does.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { putLive } from "../../../tests/live-version";
import { testCompanies } from "../../../tests/test-companies";
import { createPool, openAssignment, setAssignment, withOrg } from "../src";

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
const userId = randomUUID();
const actor = { type: "user" as const, id: userId };
let orgA = "";
let orgB = "";

async function lead(org: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, 'Meera') returning id`,
    [org],
  );
  return r.rows[0]?.id ?? "";
}

/** An open run of a sequence of the company's own for the lead; its id. */
async function inSequence(org: string, contactId: string): Promise<string> {
  const wf = await admin.query<{ id: string }>(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', '{"entry":"end","steps":{"end":{"kind":"end"}}}') returning id`,
    [org, `seq-${randomUUID().slice(0, 8)}`],
  );
  const run = await admin.query<{ id: string }>(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status) values ($1, $2, $3, 'waiting') returning id`,
    [org, wf.rows[0]?.id, contactId],
  );
  return run.rows[0]?.id ?? "";
}

const set = (
  org: string,
  contactId: string,
  roleKey: string,
  status: "active" | "paused" | "with_person" | "ended",
  why = "test",
) =>
  withOrg(app, org, (tx) =>
    setAssignment(tx, org, contactId, { roleKey, status, why, actor }),
  );

beforeAll(async () => {
  orgA = (await companies.add("Assignments A")).id;
  orgB = (await companies.add("Assignments B")).id;
  await putLive(admin, orgA, { key: "sales" });
  await putLive(admin, orgA, { key: "support" });
  await putLive(admin, orgB, { key: "sales" });
});
afterAll(async () => {
  await companies.cleanup();
  await app.end();
  await admin.end();
});

describe("setAssignment: one row per lead, its one writer", () => {
  it("puts a role on a lead, changes it, and audits each change with what it was before", async () => {
    const id = await lead(orgA);
    const first = await set(orgA, id, "sales", "active", "new enquiry");
    expect(first).toEqual({
      ok: true,
      assignment: expect.objectContaining({
        roleKey: "sales",
        status: "active",
        why: "new enquiry",
      }),
    });
    const second = await set(orgA, id, "support", "paused", "booked a unit");
    expect(second.ok && second.assignment.roleKey).toBe("support");
    const rows = await admin.query(
      `select role_key, status, why from agent_assignments where org_id = $1 and contact_id = $2`,
      [orgA, id],
    );
    expect(rows.rows).toEqual([
      { role_key: "support", status: "paused", why: "booked a unit" },
    ]);
    const audited = await admin.query(
      `select actor_type, actor_id, before, after from audit_log
        where org_id = $1 and action = 'assignment.set' and resource_id = $2 order by created_at, id`,
      [orgA, id],
    );
    expect(audited.rows).toHaveLength(2);
    expect(audited.rows[0]).toMatchObject({
      actor_type: "user",
      actor_id: userId,
      before: null,
    });
    expect(audited.rows[1]?.before).toMatchObject({
      roleKey: "sales",
      status: "active",
    });
    expect(audited.rows[1]?.after).toMatchObject({
      roleKey: "support",
      status: "paused",
    });
  });

  it("keeps when a status began while it holds, and starts it again when it changes", async () => {
    const id = await lead(orgA);
    const a = await set(orgA, id, "sales", "active", "one");
    const b = await set(orgA, id, "sales", "active", "two");
    const c = await set(orgA, id, "sales", "with_person", "a person took it");
    if (!a.ok || !b.ok || !c.ok) throw new Error("each change was refused");
    expect(b.assignment.since).toBe(a.assignment.since);
    expect(c.assignment.since).not.toBe(a.assignment.since);
  });

  it("refuses a lead in a sequence unless the assignment ends, and a lead with one is open to openAssignment", async () => {
    const id = await lead(orgA);
    const runId = await inSequence(orgA, id);
    for (const status of ["active", "paused", "with_person"] as const)
      expect(await set(orgA, id, "sales", status)).toEqual({
        ok: false,
        refused: "in_sequence",
        runId,
      });
    expect((await set(orgA, id, "sales", "ended", "closed")).ok).toBe(true);
    expect(
      await withOrg(app, orgA, (tx) => openAssignment(tx, orgA, id)),
    ).toBeUndefined();
    const other = await lead(orgA);
    await set(orgA, other, "sales", "with_person");
    expect(
      await withOrg(app, orgA, (tx) => openAssignment(tx, orgA, other)),
    ).toMatchObject({ roleKey: "sales", status: "with_person" });
  });

  it("refuses a role the company has no version of, and a lead it doesn't have", async () => {
    const id = await lead(orgA);
    expect(await set(orgA, id, "closer", "active")).toEqual({
      ok: false,
      refused: "unknown_role",
    });
    expect(await set(orgA, randomUUID(), "sales", "active")).toEqual({
      ok: false,
      refused: "not_found",
    });
    const theirs = await lead(orgB);
    expect(await set(orgA, theirs, "sales", "active")).toEqual({
      ok: false,
      refused: "not_found",
    });
    expect(
      (
        await admin.query(
          `select 1 from agent_assignments where contact_id = $1`,
          [theirs],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("refuses a reason that is empty or too long, and a status it doesn't know", async () => {
    const id = await lead(orgA);
    await expect(set(orgA, id, "sales", "active", "  ")).rejects.toThrow(
      "check constraint",
    );
    await expect(
      set(orgA, id, "sales", "active", "x".repeat(501)),
    ).rejects.toThrow("check constraint");
    await expect(
      set(orgA, id, "sales", "gone" as "ended"),
    ).rejects.toThrow("check constraint");
  });
});

describe("agent_assignments between companies", () => {
  it("shows another company none of a company's assignments and lets it change none", async () => {
    const id = await lead(orgA);
    await set(orgA, id, "sales", "active");
    const seen = await withOrg(app, orgB, (tx) =>
      tx.query(
        `select contact_id from agent_assignments where org_id = $1 and contact_id = $2`,
        [orgA, id],
      ),
    );
    expect(seen.rows).toEqual([]);
    const changed = await withOrg(app, orgB, (tx) =>
      tx.query(
        `update agent_assignments set status = 'ended' where org_id = $1 and contact_id = $2`,
        [orgA, id],
      ),
    );
    expect(changed.rowCount).toBe(0);
    await expect(
      withOrg(app, orgB, (tx) =>
        tx.query(
          `insert into agent_assignments (org_id, contact_id, role_key, why) values ($1, $2, 'sales', 'x')`,
          [orgA, id],
        ),
      ),
    ).rejects.toThrow("row-level security");
    // a company's own row can't name another company's lead
    await expect(
      admin.query(
        `insert into agent_assignments (org_id, contact_id, role_key, why) values ($1, $2, 'sales', 'x')`,
        [orgB, id],
      ),
    ).rejects.toThrow("agent_assignments_contact_id_fkey");
  });
});
