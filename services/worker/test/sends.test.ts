// The send record's hand-over (services/worker/src/sends.ts handOver), against the real local database: it hands a
// lead to a person only for a send still waiting for its provider's answer, so a run that sees 'sending' just as
// another run saves the answer, or hands it over, never turns a known send into an unknown one or opens a second task.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool, withOrg } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handOver, type Send } from "../src/sends";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let [orgId, workflowId] = ["", ""];

beforeAll(async () => {
  orgId = (await companies.add("Sends Org")).id;
  workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', '{"entry":"c","steps":{"c":{"kind":"call","agent":"closer","on":{}}}}'::jsonb)
       returning id`,
      [orgId, `sends-${randomUUID()}`],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

/** A call saved as `status` on a run of its own waiting on the call, for a lead of its own (a lead can be in the
 *  same sequence only once at a time, migration 025). */
async function savedCall(status: string): Promise<Send> {
  const contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [orgId],
    )
  ).rows[0].id;
  const runId = (
    await admin.query(
      `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step)
       values ($1, $2, $3, 'waiting', 'c') returning id`,
      [orgId, workflowId, contactId],
    )
  ).rows[0].id;
  const send: Send = {
    key: `place_call:${runId}:${randomUUID()}`,
    channel: "voice",
    contactId,
    runId,
    payload: {},
  };
  await admin.query(
    `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, status)
     values ($1, $2, 'voice', $3, $4, $5)`,
    [orgId, send.key, contactId, runId, status],
  );
  return send;
}

const after = async (send: Send) => ({
  status: (
    await admin.query(`select status from sends where send_key = $1`, [
      send.key,
    ])
  ).rows[0]?.status,
  tasks: (
    await admin.query(
      `select count(*)::int n from tasks where workflow_run_id = $1`,
      [send.runId],
    )
  ).rows[0]?.n,
  run: (
    await admin.query(`select status from workflow_runs where id = $1`, [
      send.runId,
    ])
  ).rows[0]?.status,
});

it("hands over a send still waiting for its answer: unknown, one task, a call's run parked", async () => {
  const send = await savedCall("sending");

  const handed = await withOrg(appPool, orgId, (tx) =>
    handOver(tx, orgId, send, new Error("dialer timed out")),
  );

  expect(handed).toBe(true);
  expect(await after(send)).toEqual({
    status: "unknown",
    tasks: 1,
    run: "failed",
  });
});

it("leaves a send that is sent, blocked or handed over already as it is: no task, the run untouched", async () => {
  for (const status of ["sent", "blocked", "unknown"]) {
    const send = await savedCall(status);

    const handed = await withOrg(appPool, orgId, (tx) =>
      handOver(tx, orgId, send, new Error("late")),
    );

    expect(handed).toBe(false);
    expect(await after(send)).toEqual({ status, tasks: 0, run: "waiting" });
  }
});

it("says why in words a person reads: an error's message, anything else thrown as it is, cut to 500 characters", async () => {
  const unsure = "could not tell whether the provider took it: "; // 45 characters
  const cases: [unknown, string][] = [
    [new Error("dialer timed out"), `${unsure}dialer timed out`],
    ["socket closed", `${unsure}socket closed`],
    [new Error("x".repeat(600)), `${unsure}${"x".repeat(455)}`],
  ];
  for (const [why, reason] of cases) {
    const send = await savedCall("sending");

    await withOrg(appPool, orgId, (tx) => handOver(tx, orgId, send, why));

    const saved = await admin.query(
      `select s.reason, t.payload->>'reason' as task, r.last_error
         from sends s join tasks t on t.workflow_run_id = s.workflow_run_id
         join workflow_runs r on r.id = s.workflow_run_id
        where s.send_key = $1`,
      [send.key],
    );
    expect(saved.rows).toEqual([{ reason, task: reason, last_error: reason }]);
  }
});
