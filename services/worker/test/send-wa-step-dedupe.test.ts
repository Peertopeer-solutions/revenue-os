// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step FIELD (data, not a
// thenable) in the workflow definition JSON — same suppression as scheduler.test.ts.
// send_wa's exactly-once key identifies THIS SEND, not this template. Real local database:
// needs Postgres + pg-boss's installed schema (the scheduler enqueues the jobs this suite then
// hands to the handler, so the JOB PAYLOAD under test is the real one the scheduler produced —
// never a hand-written one), so it runs with the local stack's settings (`bun run gate`, CI).
// Setup mirrors scheduler.test.ts + send-wa.test.ts.
//
// THE FIXED DEFECT: handleSendWa (src/handlers/send-wa.ts) once keyed its idempotency on run id +
// template only, while the scheduler's identity for the same send is step-scoped (singleton_key
// `${runId}:${step}:${idx}`, enqueueJob in src/scheduler.ts). Two whatsapp steps of one run that
// share a template (the ordinary reminder cadence: `steps` is a keyed record with no uniqueness
// rule on `template`) then sent once: the second handler run found the first send's usage row and
// returned silently. Exactly-once had become at-most-once-per-(run, template).
//
// PINNED here:
//   1. two DIFFERENT whatsapp steps of one run that share a template BOTH send (the reminder
//      cadence), and both are metered;
//   2. an exact re-delivery of ONE of those jobs still sends nothing extra (exactly-once against
//      a pg-boss re-delivery survives the fix);
//   3. cross-tenant denial: the same job payload re-scoped to org B sends nothing — RLS hides
//      org A's run, and the handler no-ops before guard and before the send.
//
// NOT PINNED (deliberately): HOW the send is identified — this suite never writes a job payload,
//   it reads back what scheduler.enqueueJob wrote into pgboss.job and hands that verbatim to the
//   handler, so carrying step/idx (or any other per-send identity) in the payload is the worker's
//   call. The dedupe key format, the usage meta shape and the message content are not pinned.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { testCompanies } from "../../../tests/test-companies";
import {
  handleSendWa,
  type SendWaDeps,
  type SendWaJob,
} from "../src/handlers/send-wa";
import { tick } from "../src/scheduler";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = createPool(DB_URL); // also owns pg-boss's tables: clears this file's jobs
const companies = testCompanies(admin, appPool);
// pg-boss installs pgboss.* at start(); the send_wa queue must exist before the scheduler queues into
// it (enqueueJob copies the job's settings from the queue's row and refuses a missing queue), policy
// 'short' for the singleton_key dedupe.
const boss = new PgBoss({
  connectionString: DB_URL,
  schema: "pgboss",
  createSchema: false,
});

const TEMPLATE = "followup_1"; // ONE template, reused by two steps — the reminder cadence
const HOUR = 3_600_000;

let orgId = "";
let orgB = "";
let contactId = "";
let wfSeq = 0;

async function seedWorkflow(def: unknown, org = orgId): Promise<string> {
  wfSeq += 1;
  const r = await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [org, `wa-dedupe-wf-${Date.now()}-${wfSeq}`, JSON.stringify(def)],
  );
  return r.rows[0].id;
}

async function seedRun(
  workflowId: string,
  currentStep: string,
): Promise<string> {
  // wake_at is seeded an hour in the PAST: the run must be due against the injected host clock
  // even if the database clock runs slightly ahead of it (dueness is `wake_at <= ctx.now`).
  const r = await admin.query(
    `insert into workflow_runs
       (org_id, workflow_id, contact_id, status, current_step, state, wake_at, attempts)
     values ($1, $2, $3, 'waiting', $4, $5::jsonb, now() - interval '1 hour', '{}'::jsonb)
     returning id`,
    [
      orgId,
      workflowId,
      contactId,
      currentStep,
      JSON.stringify({ contactId, vars: { name: "Asha" } }),
    ],
  );
  return r.rows[0].id as string;
}

/** The REAL job the scheduler enqueued for `<runId>:<step>:0` — payload verbatim, never authored. */
async function enqueuedJob(runId: string, step: string): Promise<SendWaJob> {
  const r = await appPool.query<{ name: string; data: SendWaJob }>(
    `select name, data from pgboss.job where singleton_key = $1`,
    [`${runId}:${step}:0`],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`no job enqueued for ${runId}:${step}:0`);
  if (row.name !== "send_wa") throw new Error(`job for ${step} is ${row.name}`);
  return row.data;
}

async function countWaUsage(runId: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int n from usage_events
      where kind = 'wa_message'
        and meta ->> 'sendKey' like 'send_wa:' || $1 || ':%'`,
    [runId], // the run's own sends, by key: its lead's thread follows the newest run
  );
  return r.rows[0].n;
}

/** A reminder cadence: whatsapp(followup_1) -> wait 48h -> whatsapp(followup_1) -> end. */
const CADENCE_WF = {
  entry: "wa_1",
  steps: {
    wa_1: { kind: "whatsapp", template: TEMPLATE, then: "pause" },
    pause: { kind: "wait", for: "PT48H", then: "wa_2" },
    wa_2: { kind: "whatsapp", template: TEMPLATE, then: "end" },
    end: { kind: "end" },
  },
};

/** Counting sender + guard spy; the call log proves guard ran BEFORE each send (guardrails before every send). */
function spyDeps(): { deps: SendWaDeps; log: string[]; templates: string[] } {
  const log: string[] = [];
  const templates: string[] = [];
  const deps: SendWaDeps = {
    pool: appPool,
    guard: async () => {
      log.push("guard");
      return { ok: true };
    },
    sender: {
      send: async (p) => {
        log.push("send");
        templates.push(p.template);
        return { providerRef: `wamid.${templates.length}` };
      },
    },
  };
  return { deps, log, templates };
}

beforeAll(async () => {
  await boss.start();
  try {
    await boss.createQueue("send_wa", { policy: "short" });
  } catch {
    // idempotent across reruns: the queue partition already exists
  }
  orgId = (await companies.add("WA Dedupe Org")).id;
  orgB = (await companies.add("WA Dedupe Org B")).id;
  contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [orgId],
    )
  ).rows[0].id;
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', '+919876500001', true)`,
    [orgId, contactId],
  );
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await boss.stop({ graceful: true, timeout: 5_000 });
  await appPool.end();
  await admin.end();
});

describe("send_wa dedupe is per-send, not per-template", () => {
  it("two different steps sharing ONE template both send — the reminder cadence is delivered twice", async () => {
    const wf = await seedWorkflow(CADENCE_WF);
    const runId = await seedRun(wf, "wa_1");
    const base = Date.now();

    // tick 1 drives wa_1 (send + arm the 48h wait); tick 2, 49h later, drives wa_2.
    await tick(appPool, orgId, { now: new Date(base) });
    await tick(appPool, orgId, { now: new Date(base + 49 * HOUR) });

    const job1 = await enqueuedJob(runId, "wa_1");
    const job2 = await enqueuedJob(runId, "wa_2");
    expect(job1.action.template).toBe(TEMPLATE);
    expect(job2.action.template).toBe(TEMPLATE); // same template, different step — the trap

    const { deps, log, templates } = spyDeps();
    await handleSendWa(deps, job1);
    await handleSendWa(deps, job2);

    // THE ASSERTION: two distinct sends, not one. (Today the second is silently swallowed.)
    expect(templates).toEqual([TEMPLATE, TEMPLATE]);
    expect(log).toEqual(["guard", "send", "guard", "send"]); // guard before send held on BOTH sends
    expect(await countWaUsage(runId)).toBe(2); // both metered — two durable exactly-once markers
  }, 30_000);

  it("an exact RE-DELIVERY of one of those jobs still sends nothing extra (exactly-once)", async () => {
    const wf = await seedWorkflow(CADENCE_WF);
    const runId = await seedRun(wf, "wa_1");
    const base = Date.now();
    await tick(appPool, orgId, { now: new Date(base) });
    await tick(appPool, orgId, { now: new Date(base + 49 * HOUR) });

    const job1 = await enqueuedJob(runId, "wa_1");
    const job2 = await enqueuedJob(runId, "wa_2");
    const { deps, templates } = spyDeps();

    await handleSendWa(deps, job1);
    await handleSendWa(deps, job1); // pg-boss re-delivery of the SAME job
    await handleSendWa(deps, job2);
    await handleSendWa(deps, job2); // …and of the second

    expect(templates.length).toBe(2); // one send per STEP, re-deliveries no-op
    expect(await countWaUsage(runId)).toBe(2);
  }, 30_000);

  it("cross-tenant denial: the same job re-scoped to org B sends nothing (RLS hides A's run)", async () => {
    const wf = await seedWorkflow(CADENCE_WF);
    const runId = await seedRun(wf, "wa_1");
    await tick(appPool, orgId, { now: new Date() });
    const job1 = await enqueuedJob(runId, "wa_1");

    const { deps, log, templates } = spyDeps();
    await handleSendWa(deps, { ...job1, orgId: orgB });

    expect(templates).toEqual([]); // no send for another tenant's run
    expect(log).not.toContain("guard"); // …and the no-op happens on RELOAD, before the guard
    expect(await countWaUsage(runId)).toBe(0);
  }, 30_000);
});
