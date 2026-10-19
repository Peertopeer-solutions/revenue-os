// The send_wa job handler against the real local database (workflow_runs, usage_events and row-level security
// through withOrg), so it runs with the local stack's settings (`bun run gate`, CI). The handler is invoked DIRECTLY
// with a job payload (no pg-boss here). Correctness-critical and idempotency-critical: guard-BEFORE-send (guardrails
// run before every send), the run/contact vars merge and duplicate deliveries asserting a single send.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import pg, { type Pool } from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handleSendWa, type SendWaDeps } from "../src/handlers/send-wa";
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

/** The message a run's job saved before sending (services/worker/src/sends.ts), as the database holds it. */
async function sendOf(runId: string) {
  const r = await admin.query(
    `select status, provider_ref, reason, payload from sends where workflow_run_id = $1`,
    [runId],
  );
  return r.rows;
}

/** What a run's sends left behind: its review tasks, its WhatsApp conversations and the run's own status. */
async function leftBehind(runId: string) {
  const tasks = await admin.query(
    `select contact_id, title, payload from tasks where workflow_run_id = $1 and kind = 'review'`,
    [runId],
  );
  const convos = await admin.query(
    `select count(*)::int n from conversations where workflow_run_id = $1 and channel = 'whatsapp'`,
    [runId],
  );
  const run = await admin.query(
    `select status from workflow_runs where id = $1`,
    [runId],
  );
  return {
    tasks: tasks.rows,
    conversations: convos.rows[0].n,
    status: run.rows[0].status,
  };
}

/** The app's pool, with `hook` run before each query a handler sends through it, given the query's text. */
const hooked = (hook: (text: string) => Promise<void> | void) =>
  ({
    connect: async () => {
      const client = await appPool.connect();
      return new Proxy(client, {
        get(target, key) {
          if (key === "query")
            return async (text: unknown, ...rest: unknown[]) => {
              await hook(String(text));
              return (target.query as (...a: unknown[]) => unknown).call(
                target,
                text,
                ...rest,
              );
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  }) as unknown as Pool;

describe("send_wa never sends the same message twice", () => {
  const job = (runId: string) => ({
    orgId,
    runId,
    sendId: randomUUID(),
    step: "w",
    idx: 0,
    action: {
      kind: "send_wa" as const,
      contactId,
      template: "welcome",
      vars: {},
    },
  });
  const seed = async () =>
    seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "end",
      state: { contactId, vars: { name: "Asha" } },
    });

  it("the provider takes the message but its answer is lost: the job never sends again and a person is handed the lead; the sequence goes on", async () => {
    const runId = await seed();
    let sent = 0;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        send: async () => {
          sent += 1; // Meta took the message …
          throw new Error("socket hang up"); // … and its answer never arrived
        },
      },
    };
    const once = job(runId);

    await handleSendWa(deps, once);
    await handleSendWa(deps, once); // the same job delivered again

    expect(sent).toBe(1);
    const [send] = await sendOf(runId);
    expect(send).toMatchObject({ status: "unknown", provider_ref: null });
    expect(send.reason).toContain("socket hang up");
    expect(send.payload).toEqual({
      to: "+919876500000",
      template: "welcome",
      vars: { name: "Asha" },
    }); // what was about to be sent, saved first
    const after = await leftBehind(runId);
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0]).toMatchObject({
      contact_id: contactId,
      title:
        "Check whether this WhatsApp message went out before sending again",
    });
    expect(after.conversations).toBe(0);
    expect(after.status).toBe("waiting"); // a message's sequence doesn't wait on it, so it isn't parked
  });

  it("the database goes away right after the provider took the message: the job fails, and its next run hands the lead over without sending again", async () => {
    const runId = await seed();
    const db = flakyPool();
    let sent = 0;
    let checks = 0;
    const deps: SendWaDeps = {
      pool: db.pool,
      guard: async () => {
        checks += 1;
        return { ok: true };
      },
      sender: {
        send: async () => {
          sent += 1;
          db.trip(); // the next connection, the one that saves the provider's answer, fails
          return { providerRef: `wamid.lost-${REF}` };
        },
      },
    };
    const once = job(runId);

    try {
      await expect(handleSendWa(deps, once)).rejects.toThrow(
        "the database went away",
      );
      expect((await sendOf(runId))[0]?.status).toBe("sending");
      await handleSendWa(deps, once); // the job's next run (pg-boss retries a failed job)
    } finally {
      await db.pool.end();
    }

    expect(sent).toBe(1);
    expect((await sendOf(runId))[0]?.status).toBe("unknown");
    const after = await leftBehind(runId);
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0].payload.reason).toContain(
      "saved the message but not the provider's answer",
    );
    expect(checks).toBe(1); // the next run stopped at the saved message, before the guardrails
    expect(after.conversations).toBe(0);
  });

  it("a sent message is saved as sent with the provider's id, and its job delivered again sends nothing more", async () => {
    const runId = await seed();
    let sent = 0;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        send: async () => {
          sent += 1;
          return { providerRef: `wamid.ok-${REF}` };
        },
      },
    };
    const once = job(runId);

    await handleSendWa(deps, once);
    await handleSendWa(deps, once);

    expect(sent).toBe(1);
    expect(await sendOf(runId)).toEqual([
      expect.objectContaining({
        status: "sent",
        provider_ref: `wamid.ok-${REF}`,
      }),
    ]);
    const after = await leftBehind(runId);
    expect(after.conversations).toBe(1);
    expect(after.tasks).toHaveLength(0);
    const message = await admin.query(
      `select m.content, m.tool_call from messages m
         join conversations c on c.id = m.conversation_id
        where c.workflow_run_id = $1`,
      [runId],
    );
    expect(message.rows).toEqual([
      {
        content: "template:welcome",
        tool_call: { providerRef: `wamid.ok-${REF}` },
      },
    ]); // the outbound message, carrying the provider's id for it
  });

  it("a guardrail check that fails before the send saves and sends nothing, so the job's next run sends once", async () => {
    const runId = await seed();
    let sent = 0;
    let checks = 0;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => {
        checks += 1;
        if (checks === 1) throw new Error("guardrails unreachable");
        return { ok: true };
      },
      sender: {
        send: async () => {
          sent += 1;
          return { providerRef: `wamid.after-guard-${REF}` };
        },
      },
    };
    const once = job(runId);

    await expect(handleSendWa(deps, once)).rejects.toThrow(
      "guardrails unreachable",
    );
    expect(await sendOf(runId)).toEqual([]); // nothing saved: the provider was never called
    expect((await leftBehind(runId)).tasks).toHaveLength(0);
    await handleSendWa(deps, once); // the job's next run

    expect(sent).toBe(1);
    expect((await sendOf(runId))[0]?.status).toBe("sent");
    expect((await leftBehind(runId)).tasks).toHaveLength(0);
  });

  it("the message's record fails after the provider's answer was saved: the job's next run records it once and sends nothing", async () => {
    const runId = await seed();
    const db = flakyPool();
    let sent = 0;
    const deps: SendWaDeps = {
      pool: db.pool,
      guard: async () => ({ ok: true }),
      sender: {
        send: async () => {
          sent += 1;
          db.trip(1); // the answer is saved; the connection after it, the one that records the message, fails
          return { providerRef: `wamid.record-${REF}` };
        },
      },
    };
    const once = job(runId);

    try {
      await expect(handleSendWa(deps, once)).rejects.toThrow(
        "the database went away",
      );
      expect((await sendOf(runId))[0]?.status).toBe("sent"); // the provider's answer outlived the failure
      expect((await leftBehind(runId)).conversations).toBe(0);
      await handleSendWa(deps, once); // the job's next run records it
      await handleSendWa(deps, once); // and a further run records nothing more
    } finally {
      await db.pool.end();
    }

    expect(sent).toBe(1);
    const after = await leftBehind(runId);
    expect(after.conversations).toBe(1);
    expect(after.tasks).toHaveLength(0);
    const usage = await admin.query(
      `select meta from usage_events u join conversations c on c.id = u.conversation_id
        where c.workflow_run_id = $1 and u.kind = 'wa_message'`,
      [runId],
    );
    expect(usage.rows).toEqual([
      {
        meta: {
          sendKey: `send_wa:${runId}:${once.sendId}`,
          template: "welcome",
        },
      },
    ]); // metered once, naming the send it records
  });

  it("the same job delivered again while its first run is still recording the message records and meters it once", async () => {
    const runId = await seed();
    const once = job(runId);
    let sent = 0;
    const sender = {
      send: async () => {
        sent += 1;
        return { providerRef: `wamid.twice-${REF}` };
      },
    };
    let reached = () => {};
    const atRecord = new Promise<void>((done) => {
      reached = done;
    });
    // the second delivery says when it reaches the record step: its look at the send, or at the usage row
    const later: SendWaDeps = {
      pool: hooked((text) => {
        if (/from sends[\s\S]*for update|from usage_events/.test(text))
          reached();
      }),
      guard: async () => ({ ok: true }),
      sender,
    };
    // the first, as it starts recording, is delivered again, and waits until that delivery reaches its record step
    let second: Promise<void> | undefined;
    const first: SendWaDeps = {
      pool: hooked(async (text) => {
        if (second || !text.includes("insert into conversations")) return;
        second = handleSendWa(later, once);
        await atRecord;
        await new Promise((r) => setTimeout(r, 200)); // its query reaches the database
      }),
      guard: async () => ({ ok: true }),
      sender,
    };

    await handleSendWa(first, once);
    await second;

    expect(sent).toBe(1);
    const recorded = await admin.query(
      `select (select count(*)::int from conversations where workflow_run_id = $1) as conversations,
              (select count(*)::int from messages m join conversations c on c.id = m.conversation_id
                where c.workflow_run_id = $1) as messages,
              (select count(*)::int from usage_events where kind = 'wa_message' and meta ->> 'sendKey' = $2) as metered`,
      [runId, `send_wa:${runId}:${once.sendId}`],
    );
    expect(recorded.rows).toEqual([
      { conversations: 1, messages: 1, metered: 1 },
    ]);
  });

  it("a message the guardrails refuse is saved as blocked with the reason, and nothing is sent", async () => {
    const runId = await seed();
    let sent = 0;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => ({ ok: false, reason: "dnc" }) as const,
      sender: {
        send: async () => {
          sent += 1;
          return { providerRef: `nope-${REF}` };
        },
      },
    };

    await handleSendWa(deps, job(runId));

    expect(sent).toBe(0);
    expect(await sendOf(runId)).toEqual([
      expect.objectContaining({ status: "blocked", reason: "dnc" }),
    ]);
  });
});

describe("send_wa on the lead's thread", () => {
  it("two sends to one lead, from two runs, go on the lead's one open WhatsApp thread as lines 1 and 2; it follows the newer run", async () => {
    const lead = (
      await admin.query(
        `insert into contacts (org_id, first_name) values ($1, 'Meera') returning id`,
        [orgId],
      )
    ).rows[0].id;
    await admin.query(
      `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
       values ($1, $2, 'whatsapp', '+919876500077', true)`,
      [orgId, lead],
    );
    let n = 0;
    const deps: SendWaDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        send: async () => {
          n += 1;
          return { providerRef: `wamid.thread${n}-${REF}` };
        },
      },
    };
    const runs: string[] = [];
    for (const template of ["welcome", "reminder"]) {
      const runId = await seedRun(await seedWorkflow(CALL_WF), {
        currentStep: "end",
        contact: lead,
        state: { contactId: lead },
      });
      runs.push(runId);
      await handleSendWa(deps, {
        orgId,
        runId,
        sendId: randomUUID(),
        step: "w",
        idx: 0,
        action: { kind: "send_wa", contactId: lead, template, vars: {} },
      });
    }
    const threads = await admin.query(
      `select id, workflow_run_id, status, started_at from conversations
        where org_id = $1 and contact_id = $2 and channel = 'whatsapp'`,
      [orgId, lead],
    );
    expect(threads.rows).toEqual([
      expect.objectContaining({ workflow_run_id: runs[1], status: "active" }),
    ]);
    expect(threads.rows[0].started_at).toBeInstanceOf(Date);
    const said = await admin.query(
      "select seq, content, tool_call from messages where conversation_id = $1 order by seq",
      [threads.rows[0].id],
    );
    expect(said.rows).toEqual([
      {
        seq: 1,
        content: "template:welcome",
        tool_call: { providerRef: `wamid.thread1-${REF}` },
      },
      {
        seq: 2,
        content: "template:reminder",
        tool_call: { providerRef: `wamid.thread2-${REF}` },
      },
    ]);
  });
});
