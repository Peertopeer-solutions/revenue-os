// The place_call job handler against the real local database (workflow_runs, conversations, messages, usage_events
// and row-level security through withOrg), so it runs with the local stack's settings (`bun run gate`, CI). The
// handler is invoked DIRECTLY with a job payload (no pg-boss here). Correctness-critical and idempotency-critical:
// the reload-no-op (exactly-once), guard-BEFORE-send (guardrails run before every send) and lastDisposition-fold
// assertions are exact and unfakeable (spies share a call-log; duplicate deliveries assert a single effect).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import {
  type LlmProvider,
  type LlmTurn,
  ToolRegistry,
} from "@revenue-os/harness";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import {
  handlePlaceCall,
  type PlaceCallDeps,
} from "../src/handlers/place-call";
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
const HAPPY_REF = `vapi-call-happy-${REF}`;
let orgId = "";
let orgB = ""; // a second tenant for the cross-tenant denial case
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

/** An active agent version — place_call / agent.turn load system_prompt + tools_allowed from it. */
async function seedAgent(org = orgId, key = "closer"): Promise<string> {
  const r = await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, $2, 1, 'active', 'claude-sonnet-4-6', 'You are a scheduler.', '{}') returning id`,
    [org, key],
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

async function getRun(id: string) {
  const r = await admin.query(
    `select status, current_step, state, attempts, wake_at, last_error from workflow_runs where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function countConversations(runId: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int n from conversations where workflow_run_id = $1`,
    [runId],
  );
  return r.rows[0].n;
}

async function getConversation(runId: string) {
  const r = await admin.query(
    `select id, channel, provider, provider_ref, status from conversations where workflow_run_id = $1`,
    [runId],
  );
  return r.rows[0];
}

async function countMessages(conversationId: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int n from messages where conversation_id = $1`,
    [conversationId],
  );
  return r.rows[0].n;
}

async function countUsage(conversationId: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int n from usage_events where conversation_id = $1`,
    [conversationId],
  );
  return r.rows[0].n;
}

/** Scripted fake LLM (mirrors loop.test): a text-only turn, no tool calls. */
function fakeLlm(turns: LlmTurn[]): LlmProvider {
  let i = 0;
  return {
    complete: async () => {
      const t = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return t;
    },
  };
}

beforeAll(async () => {
  orgId = (await companies.add("Handlers Org")).id;
  orgB = (await companies.add("Handlers Org B")).id;
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
  await seedAgent(orgId, "closer");
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

describe("place_call handler", () => {
  it("reloads a fresh call step, guards BEFORE the send, records the conversation, drives the turn (messages+usage), FOLDS the outcome and re-arms", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, { currentStep: "c", state: { contactId } });
    const log: string[] = [];
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        log.push("guard");
        return { ok: true };
      },
      sender: {
        place: async () => {
          log.push("send");
          return { providerRef: HAPPY_REF };
        },
      },
      provider: fakeLlm([
        {
          text: "Namaste, calling about your site visit.",
          usage: { in: 12, out: 6 },
        },
      ]),
      registry: new ToolRegistry(),
      outcome: async () => "no_answer",
    };

    await handlePlaceCall(deps, {
      orgId,
      runId,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    // guardrails before every send — the guard ran, and strictly BEFORE the send
    expect(log).toEqual(["guard", "send"]);
    // a voice conversation was recorded, carrying the provider ref
    const convo = await getConversation(runId);
    expect(convo).toBeDefined();
    expect(convo.channel).toBe("voice");
    expect(convo.provider_ref).toBe(HAPPY_REF);
    // the turn was driven -> transcript + usage landed (the runTurn bridge)
    expect(await countMessages(convo.id)).toBeGreaterThan(0);
    expect(await countUsage(convo.id)).toBeGreaterThan(0);
    // the call OUTCOME was FOLDED, and the run RE-ARMED for the call re-entry
    const run = await getRun(runId);
    expect(run.state.lastDisposition).toBe("no_answer");
    expect(run.status).toBe("waiting");
    expect(run.current_step).toBe("c"); // unchanged — the next tick routes the re-entry
  });

  it("a blocking guard verdict prevents the send: no conversation, no fold", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, { currentStep: "c", state: { contactId } });
    const log: string[] = [];
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        log.push("guard");
        return { ok: false, reason: "dnc" } as const;
      },
      sender: {
        place: async () => {
          log.push("send");
          return { providerRef: `should-not-happen-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "no_answer",
    };

    await handlePlaceCall(deps, {
      orgId,
      runId,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    expect(log).toContain("guard"); // reached the guard
    expect(log).not.toContain("send"); // ...and the send never fired
    expect(await countConversations(runId)).toBe(0);
    const run = await getRun(runId);
    expect(run.state.lastDisposition ?? null).toBeNull(); // no outcome folded on a blocked call
  });

  it("a DUPLICATE delivery reloads and NO-OPS: the send fires once, one conversation, one fold (exactly-once)", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, { currentStep: "c", state: { contactId } });
    let sendCount = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          sendCount += 1;
          return { providerRef: `vapi-${sendCount}-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "hello", usage: { in: 5, out: 3 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };
    const job = {
      orgId,
      runId,
      action: { kind: "place_call" as const, contactId, agentKey: "closer" },
    };

    await handlePlaceCall(deps, job);
    await handlePlaceCall(deps, job); // re-delivery of the same job

    expect(sendCount).toBe(1); // sent exactly once
    expect(await countConversations(runId)).toBe(1); // one conversation
    expect((await getRun(runId)).state.lastDisposition).toBe("completed"); // folded once
  });

  it("no-ops on a STALE run (already folded, or no longer waiting) BEFORE the guard — exactly-once", async () => {
    const wf = await seedWorkflow(CALL_WF);
    // a re-delivery AFTER the outcome was already folded:
    const alreadyDone = await seedRun(wf, {
      currentStep: "c",
      state: { contactId, lastDisposition: "completed" },
    });
    // a run that already advanced past 'waiting':
    const notWaiting = await seedRun(wf, {
      currentStep: "c",
      state: { contactId },
      status: "completed",
    });
    const log: string[] = [];
    let sendCount = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        log.push("guard");
        return { ok: true };
      },
      sender: {
        place: async () => {
          sendCount += 1;
          return { providerRef: `nope-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "no_answer",
    };

    await handlePlaceCall(deps, {
      orgId,
      runId: alreadyDone,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });
    await handlePlaceCall(deps, {
      orgId,
      runId: notWaiting,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    expect(sendCount).toBe(0); // never sent for a stale run
    expect(log).not.toContain("guard"); // the no-op happens on RELOAD, before the guard
    expect(await countConversations(alreadyDone)).toBe(0);
    expect(await countConversations(notWaiting)).toBe(0);
  });

  it("cross-tenant denial: a job scoped to org B cannot touch org A's run (RLS)", async () => {
    const wf = await seedWorkflow(CALL_WF, orgId);
    const runA = await seedRun(wf, { currentStep: "c", state: { contactId } });
    let sendCount = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          sendCount += 1;
          return { providerRef: `leak-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };

    // the handler re-scopes via withOrg(job.orgId = orgB); RLS hides A's run -> nothing happens
    await handlePlaceCall(deps, {
      orgId: orgB,
      runId: runA,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    expect(sendCount).toBe(0);
    expect(await countConversations(runA)).toBe(0);
    const run = await getRun(runA);
    expect(run.status).toBe("waiting"); // untouched
    expect(run.state.lastDisposition ?? null).toBeNull(); // no fold
  });
});

/** The call a run's job saved before dialling (services/worker/src/sends.ts), as the database holds it. */
async function sendOf(runId: string) {
  const r = await admin.query(
    `select status, provider_ref, reason, payload from sends where workflow_run_id = $1`,
    [runId],
  );
  return r.rows;
}

/** The review tasks handed to a person for a run, with the lead they are on. */
async function reviewTasks(runId: string) {
  const r = await admin.query(
    `select contact_id, title, payload from tasks where workflow_run_id = $1 and kind = 'review'`,
    [runId],
  );
  return r.rows;
}

describe("place_call never dials the same call twice", () => {
  const job = (runId: string) => ({
    orgId,
    runId,
    sendId: randomUUID(),
    action: { kind: "place_call" as const, contactId, agentKey: "closer" },
  });

  it("the dialer takes the call but its answer is lost: the job never dials again, a person is handed the lead, the run is parked", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    let dialled = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          dialled += 1; // the dialer placed the call …
          throw new Error("dialer timed out"); // … and its answer never arrived
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };
    const once = job(runId);

    await handlePlaceCall(deps, once);
    await handlePlaceCall(deps, once); // the same job delivered again

    expect(dialled).toBe(1);
    expect(await countConversations(runId)).toBe(0);
    const [send] = await sendOf(runId);
    expect(send).toMatchObject({ status: "unknown", provider_ref: null });
    expect(send.reason).toContain("dialer timed out");
    expect(send.payload).toEqual({ to: "+919876500000" }); // what was about to be dialled, saved first
    const tasks = await reviewTasks(runId);
    expect(tasks).toHaveLength(1); // handed over once, not once per delivery
    expect(tasks[0]).toMatchObject({
      contact_id: contactId,
      title: "Check whether this call went out before calling again",
    });
    expect(tasks[0].payload.reason).toContain("dialer timed out");
    const run = await getRun(runId);
    expect(run.status).toBe("failed"); // parked for the person: a call whose result is unknown can't route
    expect(run.last_error).toContain("dialer timed out");
  });

  it("the database goes away right after the dialer took the call: the job fails, and its next run hands the lead over without dialling again", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    const db = flakyPool();
    let dialled = 0;
    const deps: PlaceCallDeps = {
      pool: db.pool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          dialled += 1;
          db.trip(); // the next connection, the one that saves the dialer's answer, fails
          return { providerRef: `vapi-lost-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };
    const once = job(runId);

    try {
      await expect(handlePlaceCall(deps, once)).rejects.toThrow(
        "the database went away",
      );
      expect((await sendOf(runId))[0]?.status).toBe("sending"); // saved before dialling, answer not saved
      await handlePlaceCall(deps, once); // the job's next run (pg-boss retries a failed job)
    } finally {
      await db.pool.end();
    }

    expect(dialled).toBe(1);
    expect(await countConversations(runId)).toBe(0);
    expect((await sendOf(runId))[0]?.status).toBe("unknown");
    const tasks = await reviewTasks(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.reason).toContain(
      "saved the call but not the dialer's answer",
    );
    expect((await getRun(runId)).status).toBe("failed");
  });

  it("the call's outcome fails after its answer was saved: the job's next run folds that same call, dialling nothing", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    let dialled = 0;
    let outcomes = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-fold-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "Hello", usage: { in: 2, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => {
        outcomes += 1;
        if (outcomes === 1) throw new Error("outcome not ready");
        return "no_answer";
      },
    };
    const once = job(runId);

    await expect(handlePlaceCall(deps, once)).rejects.toThrow(
      "outcome not ready",
    );
    await handlePlaceCall(deps, once); // the job's next run

    expect(dialled).toBe(1);
    expect((await sendOf(runId))[0]).toMatchObject({
      status: "sent",
      provider_ref: `vapi-fold-${REF}`,
    });
    const convo = await getConversation(runId);
    expect(convo.provider_ref).toBe(`vapi-fold-${REF}`); // one conversation, the call that was placed
    expect(await countConversations(runId)).toBe(1);
    const run = await getRun(runId);
    expect(run.state.lastDisposition).toBe("no_answer");
    expect(run.status).toBe("waiting");
    expect(await reviewTasks(runId)).toHaveLength(0); // nothing for a person: the call's answer was saved
  });

  it("a run handed to a person while the dialer was answering is left as the person has it: the call is saved, but no turn runs and no outcome is folded", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          // another run of this job handed the lead over while this one waited for the dialer
          await admin.query(
            `update workflow_runs set status = 'failed', last_error = 'handed over' where id = $1`,
            [runId],
          );
          return { providerRef: `vapi-late-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "Hello", usage: { in: 2, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };

    await handlePlaceCall(deps, job(runId));

    expect((await sendOf(runId))[0]).toMatchObject({
      status: "sent",
      provider_ref: `vapi-late-${REF}`,
    }); // the dialer's answer is still saved: the call did go out
    const convo = await getConversation(runId);
    expect(await countMessages(convo.id)).toBe(0); // no turn ran on it
    const run = await getRun(runId);
    expect(run).toMatchObject({ status: "failed", last_error: "handed over" });
    expect(run.state.lastDisposition ?? null).toBeNull();
  });

  it("a call the guardrails refuse is saved as blocked with the reason, and its job delivered again dials nothing", async () => {
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
    });
    let dialled = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: false, reason: "quiet_hours" }) as const,
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `nope-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };
    const once = job(runId);

    await handlePlaceCall(deps, once);
    await handlePlaceCall(deps, once);

    expect(dialled).toBe(0);
    expect(await sendOf(runId)).toEqual([
      expect.objectContaining({ status: "blocked", reason: "quiet_hours" }),
    ]);
    expect(await reviewTasks(runId)).toHaveLength(0);
  });
});
