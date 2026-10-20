// A lead can be in the same sequence only once at a time: enrolment (startRun) refuses a second open run for the same
// lead and sequence with AlreadyInSequenceError, and the database's key workflow_runs_one_open_per_sequence
// (migration 025) refuses one written any other way. Once the run has ended, the lead may be enrolled again. Runs
// against the real local database as app_service, the worker's own login.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { withOrg } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { AlreadyInSequenceError, startRun } from "../src/runs";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = new pg.Pool({ connectionString: DB_URL, max: 4 });
const companies = testCompanies(admin);

const DEFINITION = { entry: "end", steps: { end: { kind: "end" } } };
let orgA = "";
let orgB = "";
let seq = 0;

async function sequence(org: string): Promise<string> {
  seq += 1;
  const r = await admin.query<{ id: string }>(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [org, `once-${Date.now()}-${seq}`, JSON.stringify(DEFINITION)],
  );
  return r.rows[0]?.id ?? "";
}

async function lead(org: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, 'Meera') returning id`,
    [org],
  );
  return r.rows[0]?.id ?? "";
}

async function runsOf(workflowId: string, contactId: string) {
  const r = await admin.query<{ id: string; status: string }>(
    `select id, status from workflow_runs where workflow_id = $1 and contact_id = $2 order by created_at`,
    [workflowId, contactId],
  );
  return r.rows;
}

beforeAll(async () => {
  orgA = (await companies.add("Once A")).id;
  orgB = (await companies.add("Once B")).id;
});

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

describe("a lead in the same sequence only once at a time", () => {
  it("refuses a second enrolment while the first run is open, naming that run", async () => {
    const wf = await sequence(orgA);
    const meera = await lead(orgA);
    const first = await startRun(appPool, orgA, {
      workflowId: wf,
      contactId: meera,
    });

    const second = startRun(appPool, orgA, {
      workflowId: wf,
      contactId: meera,
    });
    await expect(second).rejects.toBeInstanceOf(AlreadyInSequenceError);
    await expect(second).rejects.toMatchObject({
      runId: first,
      contactId: meera,
      workflowId: wf,
    });
    expect(await runsOf(wf, meera)).toEqual([{ id: first, status: "pending" }]);
  });

  it("lets one of two enrolments at the same moment through and refuses the other", async () => {
    const wf = await sequence(orgA);
    const meera = await lead(orgA);
    const results = await Promise.allSettled([
      startRun(appPool, orgA, { workflowId: wf, contactId: meera }),
      startRun(appPool, orgA, { workflowId: wf, contactId: meera }),
    ]);
    const started = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AlreadyInSequenceError,
    );
    expect(await runsOf(wf, meera)).toHaveLength(1);
  });

  // behaviour already on main: main's enrolment inserts every run; this checks the change still lets an ended run's lead back in
  it("enrols the lead again once their run has ended, and in another sequence at any time", async () => {
    const wf = await sequence(orgA);
    const other = await sequence(orgA);
    const meera = await lead(orgA);
    const first = await startRun(appPool, orgA, {
      workflowId: wf,
      contactId: meera,
    });
    await startRun(appPool, orgA, { workflowId: other, contactId: meera });
    for (const ended of ["completed", "failed", "canceled"]) {
      await admin.query(`update workflow_runs set status = $2 where id = $1`, [
        (await runsOf(wf, meera)).at(-1)?.id,
        ended,
      ]);
      await startRun(appPool, orgA, { workflowId: wf, contactId: meera });
    }
    const runs = await runsOf(wf, meera);
    expect(runs.map((r) => r.status)).toEqual([
      "completed",
      "failed",
      "canceled",
      "pending",
    ]);
    expect(runs[0]?.id).toBe(first);
  });

  // behaviour already on main: the link from a run to its lead pairs company with company (migration 019); this checks a refusal never touches the other company's run
  it("never enrols another company's lead, and leaves that company's open run alone", async () => {
    const wfA = await sequence(orgA);
    const wfB = await sequence(orgB);
    const leadB = await lead(orgB);
    const theirs = await startRun(appPool, orgB, {
      workflowId: wfB,
      contactId: leadB,
    });

    await expect(
      startRun(appPool, orgA, { workflowId: wfA, contactId: leadB }),
    ).rejects.toThrow();
    await expect(
      startRun(appPool, orgA, { workflowId: wfB, contactId: leadB }),
    ).rejects.toThrow(/workflow not found/);
    expect(await runsOf(wfA, leadB)).toEqual([]);
    expect(await runsOf(wfB, leadB)).toEqual([
      { id: theirs, status: "pending" },
    ]);
  });

  // behaviour already on main: migration 025 is applied to the one local database both copies of the code run against; it is the database's own refusal that this checks
  it("is refused by the database too, for a run written without startRun", async () => {
    const wf = await sequence(orgA);
    const meera = await lead(orgA);
    await startRun(appPool, orgA, { workflowId: wf, contactId: meera });
    await expect(
      withOrg(appPool, orgA, (tx) =>
        tx.query(
          `insert into workflow_runs (org_id, workflow_id, contact_id, status) values ($1, $2, $3, 'waiting')`,
          [orgA, wf, meera],
        ),
      ),
    ).rejects.toThrow(/workflow_runs_one_open_per_sequence/);
    expect(await runsOf(wf, meera)).toHaveLength(1);
  });
});
