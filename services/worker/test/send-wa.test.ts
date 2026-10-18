// The send_wa job handler against the real local database (workflow_runs, usage_events and row-level security
// through withOrg), so it runs with the local stack's settings (`bun run gate`, CI). The handler is invoked DIRECTLY
// with a job payload (no pg-boss here). Correctness-critical and idempotency-critical: guard-BEFORE-send (guardrails
// run before every send), the run/contact vars merge and duplicate deliveries asserting a single send.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handleSendWa, type SendWaDeps } from "../src/handlers/send-wa";

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
// Provider refs are unique across every company (conversations' provider and provider_ref): each one this run's
// own, so two test runs started at once never share one.
const REF = randomUUID();
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

describe("send_wa handler", () => {
  it("guards BEFORE the send and MERGES run/contact vars into the template vars (never goes out empty)", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {
      currentStep: "end",
      state: { contactId, vars: { name: "Asha", city: "Pune" } },
    });
    const log: string[] = [];
    let captured: {
      to: string;
      template: string;
      vars: Record<string, string>;
    } | null = null;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => {
        log.push("guard");
        return { ok: true };
      },
      sender: {
        send: async (p) => {
          log.push("send");
          captured = p;
          return { providerRef: `wamid.1-${REF}` };
        },
      },
    };

    await handleSendWa(deps, {
      orgId,
      runId,
      action: {
        kind: "send_wa",
        contactId,
        template: "welcome",
        vars: { promo: "DIWALI" },
      },
    });

    expect(log).toEqual(["guard", "send"]); // guard before send
    const cap = captured;
    if (cap === null) throw new Error("sender.send was never called");
    // the scheduler-to-handler contract: run/contact vars MERGED with the step's template vars, non-empty
    expect(cap.vars).toMatchObject({
      name: "Asha",
      city: "Pune",
      promo: "DIWALI",
    });
    expect(Object.keys(cap.vars).length).toBeGreaterThan(0);
  });

  it("a DUPLICATE delivery sends the WhatsApp message exactly once (exactly-once)", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {
      currentStep: "end",
      state: { contactId, vars: { name: "Asha" } },
    });
    let waCount = 0;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        send: async () => {
          waCount += 1;
          return { providerRef: `wamid.${waCount}-${REF}` };
        },
      },
    };
    const job = {
      orgId,
      runId,
      action: {
        kind: "send_wa" as const,
        contactId,
        template: "welcome",
        vars: {},
      },
    };

    await handleSendWa(deps, job);
    await handleSendWa(deps, job); // re-delivery of the same job

    expect(waCount).toBe(1); // sent exactly once
  });

  it("a blocking guard verdict prevents the WhatsApp send", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {
      currentStep: "end",
      state: { contactId, vars: { name: "Asha" } },
    });
    const log: string[] = [];
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => {
        log.push("guard");
        return { ok: false, reason: "quiet_hours" } as const;
      },
      sender: {
        send: async () => {
          log.push("send");
          return { providerRef: `should-not-happen-${REF}` };
        },
      },
    };

    await handleSendWa(deps, {
      orgId,
      runId,
      action: { kind: "send_wa", contactId, template: "welcome", vars: {} },
    });

    expect(log).toContain("guard");
    expect(log).not.toContain("send"); // no send on a blocking verdict
  });
});
