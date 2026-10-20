// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step field (data, not a thenable) in the
// workflow definition JSON, e.g. { kind:"wait", for:"P1D", then:"c2" } — the same suppression scheduler.test.ts
// carries. The interpreter reads step.then.
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
import { processVapiEvents } from "../src/vapi/process";
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

  it("the call placed first, its own events filed after: one outbound conversation keeping its lead, run and agent, started when the job placed the call, an hour before its first event", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, { currentStep: "c", state: { contactId } });
    const ref = `vapi-first-${REF}`;
    await handlePlaceCall(
      {
        pool: appPool,
        guard: async () => ({ ok: true }),
        sender: { place: async () => ({ providerRef: ref }) },
        provider: fakeLlm([{ text: "Namaste.", usage: { in: 1, out: 1 } }]),
        registry: new ToolRegistry(),
        outcome: async () => "completed",
      },
      {
        orgId,
        runId,
        action: { kind: "place_call", contactId, agentKey: "closer" },
      },
    );
    const placedAt = (
      await admin.query(
        "select started_at from conversations where org_id = $1 and provider_ref = $2",
        [orgId, ref],
      )
    ).rows[0]?.started_at as Date;
    expect(placedAt).toBeInstanceOf(Date); // the job's open set the start time
    await admin.query(
      `insert into webhook_events (org_id, provider, event_type, dedupe_key, payload)
       values ($1, 'vapi', 'transcript', $2, $3::jsonb)`,
      [
        orgId,
        `vapi:${ref}-t1`,
        JSON.stringify({
          message: {
            type: "transcript",
            call: { id: ref },
            id: `${ref}-t1`,
            timestamp: new Date(placedAt.getTime() + 3_600_000).toISOString(),
            role: "user",
            transcript: "Haan, boliye.",
          },
        }),
      ],
    );
    await processVapiEvents(appPool, orgId);
    const convos = await admin.query(
      `select id, contact_id, workflow_run_id, agent_id, direction, started_at
         from conversations where org_id = $1 and provider_ref = $2`,
      [orgId, ref],
    );
    expect(convos.rows).toEqual([
      expect.objectContaining({
        contact_id: contactId,
        workflow_run_id: runId,
        agent_id: expect.any(String),
        direction: "outbound",
        started_at: placedAt, // a later event never moves the start
      }),
    ]);
    const said = await admin.query(
      "select seq, role, content from messages where conversation_id = $1 order by seq",
      [convos.rows[0].id],
    );
    expect(said.rows).toEqual([
      { seq: 1, role: "agent", content: "Namaste." },
      { seq: 2, role: "contact", content: "Haan, boliye." },
    ]);
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

/** c1 → (no answer) → wait a day → c2, as the scheduler parks it. */
const TWO_CALLS = {
  entry: "c1",
  steps: {
    c1: {
      kind: "call",
      agent: "closer",
      on: { no_answer: "w", completed: "end" },
    },
    w: { kind: "wait", for: "P1D", then: "c2" },
    c2: {
      kind: "call",
      agent: "closer",
      on: { completed: "end", no_answer: "end" },
    },
    end: { kind: "end" },
  },
};

describe("place_call never dials the same call twice", () => {
  /** A call job as the scheduler queues it, and its run parked on the call step naming that job's send id. */
  async function callRun() {
    const sendId = randomUUID();
    const runId = await seedRun(await seedWorkflow(CALL_WF), {
      currentStep: "c",
      state: { contactId, callSendId: sendId },
    });
    const once = {
      orgId,
      runId,
      sendId,
      step: "c",
      idx: 0,
      action: { kind: "place_call" as const, contactId, agentKey: "closer" },
    };
    return { runId, once };
  }

  it("the dialer takes the call but its answer is lost: the job never dials again, a person is handed the lead, the run is parked", async () => {
    const { runId, once } = await callRun();
    let dialled = 0;
    let checks = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        checks += 1;
        return { ok: true };
      },
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

    await handlePlaceCall(deps, once);
    await handlePlaceCall(deps, once); // the same job delivered again

    expect(dialled).toBe(1);
    expect(checks).toBe(1); // the second delivery stopped at the call handed over, before the guardrails
    expect(await countConversations(runId)).toBe(0);
    const why = "could not tell whether the provider took it: dialer timed out";
    const [send] = await sendOf(runId);
    expect(send).toMatchObject({
      status: "unknown",
      provider_ref: null,
      reason: why,
    });
    expect(send.payload).toEqual({ to: "+919876500000" }); // what was about to be dialled, saved first
    const tasks = await reviewTasks(runId);
    expect(tasks).toHaveLength(1); // handed over once, not once per delivery
    expect(tasks[0]).toMatchObject({
      contact_id: contactId,
      title: "Check whether this call went out before calling again",
    });
    expect(tasks[0].payload.reason).toBe(why);
    const run = await getRun(runId);
    expect(run.status).toBe("failed"); // parked for the person: a call whose result is unknown can't route
    expect(run.last_error).toBe(why);
  });

  it("the database goes away right after the dialer took the call: the job fails, and its next run hands the lead over without dialling again", async () => {
    const { runId, once } = await callRun();
    const db = flakyPool();
    let dialled = 0;
    let checks = 0;
    const deps: PlaceCallDeps = {
      pool: db.pool,
      guard: async () => {
        checks += 1;
        return { ok: true };
      },
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
    expect(checks).toBe(1); // the next run stopped at the saved call, before the guardrails
    expect((await getRun(runId)).status).toBe("failed");
  });

  it("the call's outcome fails after its answer was saved: the job's next run folds that same call, dialling nothing", async () => {
    const { runId, once } = await callRun();
    let dialled = 0;
    let outcomes = 0;
    const prompts: string[] = [];
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-fold-${REF}` };
        },
      },
      provider: {
        complete: async ({ system }) => {
          prompts.push(system);
          return { text: "Hello", usage: { in: 2, out: 1 } };
        },
      },
      registry: new ToolRegistry(),
      outcome: async () => {
        outcomes += 1;
        if (outcomes === 1) throw new Error("outcome not ready");
        return "no_answer";
      },
    };

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
    expect(prompts.length).toBeGreaterThan(0);
    for (const system of prompts)
      expect(system).toContain("You are a scheduler."); // the agent's own prompt
  });

  it("a guardrail check that fails before the dial saves and dials nothing, so the job's next run dials once", async () => {
    const { runId, once } = await callRun();
    let dialled = 0;
    let checks = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        checks += 1;
        if (checks === 1) throw new Error("guardrails unreachable");
        return { ok: true };
      },
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-after-guard-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };

    await expect(handlePlaceCall(deps, once)).rejects.toThrow(
      "guardrails unreachable",
    );
    expect(await sendOf(runId)).toEqual([]); // nothing saved: the provider was never called
    expect(await reviewTasks(runId)).toHaveLength(0);
    expect((await getRun(runId)).status).toBe("waiting"); // not parked: the job may simply run again
    await handlePlaceCall(deps, once); // the job's next run

    expect(dialled).toBe(1);
    expect((await sendOf(runId))[0]?.status).toBe("sent");
    expect(await reviewTasks(runId)).toHaveLength(0);
  });

  it("a late run of an older call job does nothing, whether its run now waits for a newer call job or on a timer before the next call", async () => {
    const onNewerCall = await seedRun(await seedWorkflow(TWO_CALLS), {
      currentStep: "c2",
      state: { contactId, callSendId: randomUUID() }, // the scheduler queued c2's call
    });
    const onTimer = await seedRun(await seedWorkflow(TWO_CALLS), {
      currentStep: "c2", // a wait parks the run on its next step, and names no call job
      wakeAt: new Date(Date.now() + 86_400_000),
    });
    let dialled = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-old-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };
    const olderJob = (runId: string) => ({
      orgId,
      runId,
      sendId: randomUUID(),
      step: "c1",
      idx: 0,
      action: { kind: "place_call" as const, contactId, agentKey: "closer" },
    });

    await handlePlaceCall(deps, olderJob(onNewerCall)); // c1's job, run again after c1's outcome was folded
    await handlePlaceCall(deps, olderJob(onTimer));

    expect(dialled).toBe(0);
    for (const runId of [onNewerCall, onTimer]) {
      expect(await sendOf(runId)).toEqual([]);
      const run = await getRun(runId);
      expect(run.status).toBe("waiting");
      expect(run.state.lastDisposition ?? null).toBeNull();
    }
    expect(new Date((await getRun(onTimer)).wake_at).getTime()).toBeGreaterThan(
      Date.now(),
    ); // its wait still runs
  });

  it("the same call job delivered twice at the same moment dials once", async () => {
    const { runId, once } = await callRun();
    let dialled = 0;
    let atGuard = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      // both deliveries reach the guardrail check before either saves the call
      guard: async () => {
        atGuard += 1;
        for (let i = 0; atGuard < 2 && i < 200; i++)
          await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      },
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-twice-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };

    await Promise.all([
      handlePlaceCall(deps, once),
      handlePlaceCall(deps, once),
    ]);

    expect(atGuard).toBe(2);
    expect(dialled).toBe(1);
    expect(await sendOf(runId)).toEqual([
      expect.objectContaining({ status: "sent" }),
    ]);
    expect(await countConversations(runId)).toBe(1);
    expect(await reviewTasks(runId)).toHaveLength(0);
  });

  it("a run handed to a person while the dialer was answering is left as the person has it: the call is saved, but no turn runs and no outcome is folded", async () => {
    const { runId, once } = await callRun();
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

    await handlePlaceCall(deps, once);

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

  it("a call the guardrails refuse is saved as blocked with the reason, and its job delivered again dials nothing and asks the guardrails nothing", async () => {
    const { runId, once } = await callRun();
    let dialled = 0;
    let checks = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        checks += 1;
        return { ok: false, reason: "quiet_hours" } as const;
      },
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

    await handlePlaceCall(deps, once);
    await handlePlaceCall(deps, once);

    expect(dialled).toBe(0);
    expect(checks).toBe(1); // the second delivery stopped at the blocked call
    expect(await sendOf(runId)).toEqual([
      expect.objectContaining({ status: "blocked", reason: "quiet_hours" }),
    ]);
    expect(await reviewTasks(runId)).toHaveLength(0);
  });

  it("a late run of an older call job on a step visited again does nothing: the run waits for the newer job's call", async () => {
    // c → (no answer) → wait a day → c again: the scheduler queued a new call job for the second visit
    const loop = {
      entry: "c",
      steps: {
        c: {
          kind: "call",
          agent: "closer",
          on: { no_answer: "w", completed: "end" },
        },
        w: { kind: "wait", for: "P1D", then: "c" },
        end: { kind: "end" },
      },
    };
    const runId = await seedRun(await seedWorkflow(loop), {
      currentStep: "c",
      state: { contactId, callSendId: randomUUID() },
    });
    let dialled = 0;
    let checks = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => {
        checks += 1;
        return { ok: true };
      },
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-revisit-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };

    // the first visit's job, on the same step, run again after its outcome was folded
    await handlePlaceCall(deps, {
      orgId,
      runId,
      sendId: randomUUID(),
      step: "c",
      idx: 0,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    });

    expect(dialled).toBe(0);
    expect(checks).toBe(0);
    expect(await sendOf(runId)).toEqual([]);
    const run = await getRun(runId);
    expect(run.status).toBe("waiting");
    expect(run.state.lastDisposition ?? null).toBeNull();
  });

  it("a call job for another step than the run's does nothing, whether it carries the run's send id or none (queued before send ids), and a job naming no step does nothing while its run is on a step that isn't a call", async () => {
    const sendId = randomUUID();
    const runId = await seedRun(await seedWorkflow(TWO_CALLS), {
      currentStep: "c2",
      state: { contactId, callSendId: sendId },
    });
    const onWait = await seedRun(await seedWorkflow(TWO_CALLS), {
      currentStep: "w",
    });
    let dialled = 0;
    const deps: PlaceCallDeps = {
      pool: appPool,
      guard: async () => ({ ok: true }),
      sender: {
        place: async () => {
          dialled += 1;
          return { providerRef: `vapi-other-step-${REF}` };
        },
      },
      provider: fakeLlm([{ text: "x", usage: { in: 1, out: 1 } }]),
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    };
    const c1 = {
      orgId,
      runId,
      step: "c1",
      idx: 0,
      action: { kind: "place_call" as const, contactId, agentKey: "closer" },
    };

    await handlePlaceCall(deps, { ...c1, sendId });
    await handlePlaceCall(deps, c1);
    await handlePlaceCall(deps, { orgId, runId: onWait, action: c1.action }); // built by hand: no send id, no step

    expect(dialled).toBe(0);
    for (const id of [runId, onWait]) {
      expect(await sendOf(id)).toEqual([]);
      const run = await getRun(id);
      expect(run.status).toBe("waiting");
      expect(run.state.lastDisposition ?? null).toBeNull();
    }
  });
});
