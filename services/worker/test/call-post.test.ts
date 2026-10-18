// The call.post dead-letter handler against the real local database (workflow_runs, tasks and row-level security
// through withOrg), so it runs with the local stack's settings (`bun run gate`, CI). The handler is invoked DIRECTLY
// with a job payload (no pg-boss here): it records a failed call for a person and never throws.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handleCallPost } from "../src/handlers/call-post";
import { flakyPool } from "./fixtures/flaky-pool";

// admin = superuser (BYPASSRLS): seeds + assertions. appPool = app_service (RLS-bound): the
// role the handlers connect as through withOrg — exactly what production runs.
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
let orgId = "";
let contactId = "";
let wfSeq = 0;

async function seedWorkflow(def: unknown, org = orgId): Promise<string> {
  wfSeq += 1;
  const r = await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [org, `wf-${Date.now()}-${wfSeq}`, JSON.stringify(def)],
  );
  return r.rows[0].id;
}

type RunOpts = {
  currentStep: string;
  state?: Record<string, unknown>;
  status?: string;
  wakeAt?: Date | null;
  attempts?: Record<string, unknown>;
  org?: string;
  contact?: string;
};

async function seedRun(workflowId: string, opts: RunOpts): Promise<string> {
  const r = await admin.query(
    `insert into workflow_runs
       (org_id, workflow_id, contact_id, status, current_step, state, wake_at, attempts)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb) returning id`,
    [
      opts.org ?? orgId,
      workflowId,
      opts.contact ?? contactId,
      opts.status ?? "waiting",
      opts.currentStep,
      JSON.stringify(opts.state ?? { contactId }),
      opts.wakeAt === undefined ? new Date() : opts.wakeAt,
      JSON.stringify(opts.attempts ?? {}),
    ],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  orgId = (await companies.add("Handlers Org")).id;
  const c = await admin.query(
    `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
    [orgId],
  );
  contactId = c.rows[0].id;
  // phone identity (E.164) so the send handlers can resolve `to`
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', '+919876500000', true)`,
    [orgId, contactId],
  );
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

const CALL_WF = {
  entry: "c",
  steps: {
    c: {
      kind: "call",
      agent: "closer",
      on: { completed: "end", no_answer: "end" },
    },
    end: { kind: "end" },
  },
};

describe("call.post dead-letter handler", () => {
  it("records a failed/exhausted call for human review and NEVER crashes the queue", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, { currentStep: "c", state: { contactId } });

    await handleCallPost(
      { pool: appPool },
      {
        orgId,
        runId,
        action: { kind: "place_call" },
        error: "vapi 500 exhausted",
      },
    );

    const tasks = await admin.query(
      `select kind from tasks where workflow_run_id = $1 and kind = 'review'`,
      [runId],
    );
    expect(tasks.rows.length).toBe(1); // a review task landed in the HITL queue

    // a malformed payload (no runId) must resolve WITHOUT throwing — the sink cannot crash
    await expect(
      handleCallPost({ pool: appPool }, { orgId }),
    ).resolves.toBeUndefined();
  });
});

describe("call.post hands over a send whose job failed every try before saving the provider's answer", () => {
  /** A send saved as `status` for a job of `kind` on `runId`, as the job handlers save it (src/sends.ts). */
  async function savedSend(
    kind: "place_call" | "send_wa",
    runId: string,
    status: string,
  ) {
    const sendId = randomUUID();
    await admin.query(
      `insert into sends (org_id, send_key, channel, contact_id, workflow_run_id, status)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        orgId,
        `${kind}:${runId}:${sendId}`,
        kind === "send_wa" ? "whatsapp" : "voice",
        contactId,
        runId,
        status,
      ],
    );
    return {
      orgId,
      runId,
      sendId,
      step: "s",
      idx: 0,
      action: { kind, contactId },
      error: "failed every try",
    };
  }
  const tasksOf = async (runId: string) =>
    (
      await admin.query(
        `select contact_id, title from tasks where workflow_run_id = $1 and kind = 'review' order by created_at`,
        [runId],
      )
    ).rows;
  const statusOf = async (runId: string) =>
    (
      await admin.query(`select status from sends where workflow_run_id = $1`, [
        runId,
      ])
    ).rows[0]?.status;

  it("a WhatsApp job left 'sending' is handed to a person as unknown: one task to check, never sent again", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "end",
    });

    await handleCallPost(
      { pool: appPool },
      await savedSend("send_wa", runId, "sending"),
    );

    expect(await statusOf(runId)).toBe("unknown");
    expect(await tasksOf(runId)).toEqual([
      {
        contact_id: contactId,
        title:
          "Check whether this WhatsApp message went out before sending again",
      },
    ]);
  });

  it("a call job left 'sending' is handed to a person and its run parked as failed", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });

    await handleCallPost(
      { pool: appPool },
      await savedSend("place_call", runId, "sending"),
    );

    expect(await statusOf(runId)).toBe("unknown");
    expect(await tasksOf(runId)).toEqual([
      {
        contact_id: contactId,
        title: "Check whether this call went out before calling again",
      },
    ]);
    const run = await admin.query(
      `select status, last_error from workflow_runs where id = $1`,
      [runId],
    );
    expect(run.rows[0].status).toBe("failed");
    expect(run.rows[0].last_error).toContain("failed every try");
  });

  it("a send saved as sent, whose job then failed every try, gets a task saying it went out, on its lead; a call's run is parked", async () => {
    const message = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "end",
    });
    const call = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });

    await handleCallPost(
      { pool: appPool },
      await savedSend("send_wa", message, "sent"),
    );
    await handleCallPost(
      { pool: appPool },
      await savedSend("place_call", call, "sent"),
    );

    expect(await statusOf(message)).toBe("sent"); // the provider took it: never sent again, never marked otherwise
    expect(await tasksOf(message)).toEqual([
      {
        contact_id: contactId,
        title: "This WhatsApp message went out, but it was never recorded",
      },
    ]);
    expect(await tasksOf(call)).toEqual([
      {
        contact_id: contactId,
        title: "This call went out, but its result was never recorded",
      },
    ]);
    const runs = await admin.query(
      `select id, status from workflow_runs where id = any($1::uuid[])`,
      [[message, call]],
    );
    const status = new Map(runs.rows.map((r) => [r.id, r.status]));
    expect(status.get(call)).toBe("failed"); // it can't route without the call's result
    expect(status.get(message)).toBe("waiting"); // a message's sequence doesn't wait on it
  });

  it("a job that never saved its send gets the failure review on its run's lead, named for its channel; a blocked or handed-over send gets nothing more", async () => {
    const never = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "end",
    });
    const blocked = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    const handedOver = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });

    await handleCallPost(
      { pool: appPool },
      {
        orgId,
        runId: never,
        sendId: randomUUID(),
        action: { kind: "send_wa", contactId },
      },
    );
    await handleCallPost(
      { pool: appPool },
      await savedSend("place_call", blocked, "blocked"),
    );
    await handleCallPost(
      { pool: appPool },
      await savedSend("place_call", handedOver, "unknown"),
    );

    expect(await tasksOf(never)).toEqual([
      {
        contact_id: contactId,
        title: "WhatsApp message failed — needs review",
      },
    ]);
    expect(await tasksOf(blocked)).toEqual([]);
    expect(await tasksOf(handedOver)).toEqual([]);
  });

  it("a database failure makes the sink throw, so its own queue runs it again; a malformed payload still resolves", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    const db = flakyPool();
    try {
      db.trip();
      await expect(
        handleCallPost(
          { pool: db.pool },
          await savedSend("place_call", runId, "sending"),
        ),
      ).rejects.toThrow("the database went away");
      await expect(
        handleCallPost({ pool: db.pool }, { orgId: "not-a-company", runId }),
      ).resolves.toBeUndefined();
    } finally {
      await db.pool.end();
    }
    expect(await statusOf(runId)).toBe("sending"); // untouched, for the retry to hand over
  });
});
