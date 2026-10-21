// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step FIELD (data, not a
// thenable) in the workflow definition JSON — same suppression as scheduler.test.ts.
// A run poisoned in the APPLY phase reaches a TERMINAL state, not an endless retry. Real local
// database: needs Postgres (workflow_runs + tasks + FOR UPDATE SKIP LOCKED), so it runs with the
// local stack's settings (`bun run gate`, CI). No pg-boss here — the poison definition emits only
// INLINE actions, so nothing is enqueued. Setup mirrors scheduler.test.ts.
//
// THE FIXED DEFECT: the scheduler (src/scheduler.ts) once dead-lettered only runs whose definition
// failed to parse (processRun). An apply-phase failure (applyTransitions) rolled the whole
// transaction back (withOrg, packages/db/src/client.ts), tick logged "tick: run apply rolled back"
// and moved on, and the rollback left the run waiting with the same, still-due wake_at, so the
// next tick picked it again, every minute, forever, never visible to an operator as failed. It is
// reachable from a schema-VALID definition: interpret routes every tool but book_appointment to
// create_task, and tasks.kind/title are `not null` with a CHECK (006_harness.sql).
//
// FAULT INJECTION (why a trigger): action payloads are validated now, which closes the specific
//   `task:{}` trigger the audit used. The behaviour under test here is the SCHEDULER's handling of
//   ANY deterministic apply failure, so the fault is injected at the DB with a BEFORE INSERT
//   trigger that raises check_violation (23514 — the same SQLSTATE class the audit describes) for
//   one sentinel title, which only this suite's own workflows use, so it fires for nothing else.
//   It is installed once per database and never dropped: on the local stack, Supabase's supautils
//   extension (its drop_trigger_grants setting) makes every DROP TRIGGER by the postgres login take
//   the strongest lock on all of auth's tables, which deadlocked sign-ups in test runs going at the
//   same moment. Creating it takes no such lock, and runs starting together take turns on an
//   advisory lock, so only the first creates it.
//
// PINNED here:
//   1. a run whose apply phase throws deterministically reaches a TERMINAL state within a bounded
//      number of ticks — a status the scheduler's own selection (tick) can never pick up again —
//      and carries an operator-visible reason (last_error);
//   2. nothing partial commits along the way (the rolled-back inline write never lands);
//   3. the retry posture survives: a run that fails apply ONCE and then succeeds is NOT
//      dead-lettered — it advances normally (the scheduler's database-error policy:
//      a DB error rolls back and the run is retried; only a POISON run may terminate);
//   4. cross-tenant denial: ticking org A never dead-letters (or otherwise touches) org B's run.
//
// NOT PINNED (deliberately): the terminal status STRING ('failed' vs another terminal value), the
//   attempt ceiling N (anything ≤ MAX_TICKS below), whether the fix uses a counter, a backoff, or
//   wake_at arithmetic, where the counter is stored, and the last_error wording. Ticks advance the
//   injected clock by an hour each so a backoff-then-terminate fix is not failed on timing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { tick } from "../src/scheduler";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});
const appPool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
  max: 4,
});

/** The statuses the scheduler's selection query can pick up (tick in src/scheduler.ts). */
const SCHEDULABLE = ["pending", "waiting"];
/** The ceiling: a poisoned run must be terminal by here. The real N is the worker's call. */
const MAX_TICKS = 12;
/** Only tasks with this title prefix trip the injected fault. */
const POISON_TITLE = "POISON-t58 apply always fails";
/** The injected fault's trigger and function: one per database, shared by every run of this suite. */
const FAULT = "test_fault_poison_task";

const companies = testCompanies(admin);
let orgId = "";
let orgB = "";
let contactId = "";
let contactB = "";
let wfSeq = 0;

async function seedWorkflow(def: unknown, org = orgId): Promise<string> {
  wfSeq += 1;
  const r = await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [org, `poison-wf-${Date.now()}-${wfSeq}`, JSON.stringify(def)],
  );
  return r.rows[0].id;
}

async function seedRun(
  workflowId: string,
  opts: { currentStep: string; org?: string; contact?: string },
): Promise<string> {
  const contact = opts.contact ?? contactId;
  // wake_at an hour in the PAST: the run must be due against the injected host clock even if the
  // database clock runs slightly ahead of it (dueness is `wake_at <= ctx.now`).
  const r = await admin.query(
    `insert into workflow_runs
       (org_id, workflow_id, contact_id, status, current_step, state, wake_at, attempts)
     values ($1, $2, $3, 'waiting', $4, $5::jsonb, now() - interval '1 hour', '{}'::jsonb)
     returning id`,
    [
      opts.org ?? orgId,
      workflowId,
      contact,
      opts.currentStep,
      JSON.stringify({ contactId: contact }),
    ],
  );
  return r.rows[0].id;
}

async function getRun(id: string) {
  const r = await admin.query(
    `select status, current_step, wake_at, last_error, completed_at
       from workflow_runs where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function countTasks(runId: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int n from tasks where workflow_run_id = $1`,
    [runId],
  );
  return r.rows[0].n;
}

/** A one-step flow whose create_task insert is guaranteed to fail (see FAULT INJECTION above). */
function poisonDef(title = POISON_TITLE) {
  return {
    entry: "t",
    steps: {
      t: {
        kind: "tool",
        tool: "notify_owner",
        args: { kind: "callback", title },
        then: "end",
      },
      end: { kind: "end" },
    },
  };
}

/** Tick `count` times, one simulated hour apart, and report the run's status after each. */
async function tickUntilTerminal(
  runId: string,
  org: string,
  count = MAX_TICKS,
): Promise<string[]> {
  const base = Date.now();
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await tick(appPool, org, { now: new Date(base + i * 3_600_000) });
    const run = await getRun(runId);
    seen.push(run.status);
    if (!SCHEDULABLE.includes(run.status)) break;
  }
  return seen;
}

/** Installs the fault (see FAULT INJECTION above): a task insert with the sentinel title fails with a check
 *  violation. The function is rewritten each time, under the lock, so a changed body reaches every database. */
const installFault = () =>
  admin.query(`
    do $$ begin
      perform pg_advisory_xact_lock(hashtext('${FAULT}'));
      create or replace function public.${FAULT}() returns trigger language plpgsql as $f$
      begin
        if new.title like 'POISON-t58%' then
          raise exception 'poisoned task insert (apply-poison fault injection)'
            using errcode = '23514';
        end if;
        return new;
      end $f$;
      if not exists (select 1 from pg_trigger
                      where tgrelid = 'public.tasks'::regclass and tgname = '${FAULT}') then
        create trigger ${FAULT} before insert on public.tasks
          for each row execute function public.${FAULT}();
      end if;
    end $$`);

beforeAll(async () => {
  // Fault injection: a deterministic, constraint-class apply failure that no definition-level
  // validation can prevent. Left installed; matches only this suite's sentinel title.
  await installFault();

  orgId = (await companies.add("Apply Poison Org")).id;
  orgB = (await companies.add("Apply Poison Org B")).id;
  contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Poison A') returning id`,
      [orgId],
    )
  ).rows[0].id;
  contactB = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Poison B') returning id`,
      [orgB],
    )
  ).rows[0].id;
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

describe("apply-phase poison runs terminate", () => {
  it("a run whose APPLY phase throws every tick reaches a TERMINAL state, not an endless retry", async () => {
    const wf = await seedWorkflow(poisonDef());
    const runId = await seedRun(wf, { currentStep: "t" });

    const statuses = await tickUntilTerminal(runId, orgId);

    const run = await getRun(runId);
    // THE ASSERTION: the run is in a status the scheduler's selection can never pick up again.
    expect({
      terminal: !SCHEDULABLE.includes(run.status),
      status: run.status,
      ticks: statuses.length,
    }).toMatchObject({ terminal: true });
    // …with a reason a human can see in the console (the dead-letter contract, src/scheduler.ts's header).
    expect(run.last_error).not.toBeNull();
    // …and nothing partial ever committed: every poisoned apply rolled its whole tx back; the one task is the
    // review that hands the lead to a person, with the reason.
    const tasks = await admin.query(
      `select kind, title, payload ->> 'reason' as reason from tasks where workflow_run_id = $1`,
      [runId],
    );
    expect(tasks.rows).toEqual([
      {
        kind: "review",
        title: "Sequence stopped — it could not go on",
        reason: run.last_error,
      },
    ]);
  }, 30_000);

  it("the tick keeps going and never throws while a poisoned run is burning down", async () => {
    // one bad run may not abort the tick.
    const wf = await seedWorkflow(poisonDef());
    await seedRun(wf, { currentStep: "t" });
    await expect(
      tick(appPool, orgId, { now: new Date() }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("retry posture preserved: ONE apply failure is retried, not dead-lettered", async () => {
    // The scheduler's database-error policy: a failed inline write rolls back and the
    // run is RETRIED. A transient DB error must not become a terminal run on its first occurrence.
    const wf = await seedWorkflow(poisonDef());
    const runId = await seedRun(wf, { currentStep: "t" });
    const base = Date.now();

    await tick(appPool, orgId, { now: new Date(base) }); // apply fails once
    const afterFailure = await getRun(runId);
    expect({
      stillSchedulable: SCHEDULABLE.includes(afterFailure.status),
      status: afterFailure.status,
    }).toMatchObject({ stillSchedulable: true });

    // the failure clears (stands in for a transient DB error resolving) — same run, same step
    await admin.query(
      `update workflows set definition = $2::jsonb where id = $1`,
      [wf, JSON.stringify(poisonDef("Ring Asha back"))],
    );
    await admin.query(
      `update workflow_runs set wake_at = $2 where id = $1 and status in ('pending','waiting')`,
      [runId, new Date(base + 3_600_000)],
    );

    await tick(appPool, orgId, { now: new Date(base + 7_200_000) });

    const run = await getRun(runId);
    expect(run.status).toBe("completed"); // the run advanced — it was never dead-lettered
    expect(await countTasks(runId)).toBe(1); // and the inline write landed exactly once
  }, 30_000);

  it("cross-tenant denial: ticking org A never terminates (or touches) org B's poisoned run", async () => {
    const wfB = await seedWorkflow(poisonDef(), orgB);
    const runB = await seedRun(wfB, {
      currentStep: "t",
      org: orgB,
      contact: contactB,
    });
    const wfA = await seedWorkflow(poisonDef());
    const runA = await seedRun(wfA, { currentStep: "t" });

    await tickUntilTerminal(runA, orgId); // ticks scoped to org A only

    const b = await getRun(runB);
    expect(b.status).toBe("waiting"); // untouched by another tenant's tick
    expect(b.last_error).toBeNull();
    expect(b.completed_at).toBeNull();
    expect(await countTasks(runB)).toBe(0);
  }, 30_000);
});

describe("the injected fault", () => {
  it("is installed once per database, and four runs installing it at the same moment all succeed", async () => {
    // Without the advisory lock, rewriting one function from four connections at once fails with
    // "tuple concurrently updated", so runs starting together would kill each other.
    const installs = await Promise.allSettled(
      [1, 2, 3, 4].map(() => installFault()),
    );
    const installed = await admin.query(
      `select count(*)::int n from pg_trigger where tgrelid = 'tasks'::regclass and tgname = $1`,
      [FAULT],
    );
    expect({
      failed: installs.flatMap((r) =>
        r.status === "rejected" ? [String(r.reason)] : [],
      ),
      installed: installed.rows[0].n,
    }).toEqual({ failed: [], installed: 1 });
  });
});
