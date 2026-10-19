// The job handlers + the agent.turn runTurn bridge, against the real local database: needs
// Postgres (workflow_runs / conversations / messages / usage_events / tasks + RLS via withOrg), so
// it runs with the local stack's settings (`bun run gate`, CI). Handlers are invoked DIRECTLY with
// a job payload (no pg-boss here — the handlers do not enqueue). Correctness-critical &
// IDEMPOTENCY-CRITICAL: the reload-no-op (exactly-once), guard-BEFORE-send (guardrails run before
// every send), and lastDisposition-fold assertions
// are exact and unfakeable (spies share a call-log; duplicate deliveries assert a single effect).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import {
  type LlmProvider,
  type LlmTurn,
  ToolRegistry,
} from "@revenue-os/harness";
import pg from "pg";
import { OPTED_IN } from "../../../tests/opted-in";
import { testCompanies } from "../../../tests/test-companies";
import { handleAgentTurn } from "../src/handlers/agent-turn";
import { handleCallPost } from "../src/handlers/call-post";
import {
  handlePlaceCall,
  type PlaceCallDeps,
} from "../src/handlers/place-call";
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
const HAPPY_REF = `vapi-call-happy-${REF}`;
let orgId = "";
let orgB = ""; // a second tenant for the cross-tenant denial case
let contactId = "";
let agentId = ""; // an active "closer" agent for orgId (place_call / agent.turn load its config)
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

/** A whatsapp/voice conversation for the agent.turn bridge, with one inbound contact message. */
async function seedConversation(opts: {
  runId: string;
  agentId: string;
  org?: string;
  contact?: string;
}): Promise<string> {
  const c = await admin.query(
    `insert into conversations
       (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status)
     values ($1, $2, $3, $4, 'whatsapp', 'outbound', 'active') returning id`,
    [opts.org ?? orgId, opts.contact ?? contactId, opts.runId, opts.agentId],
  );
  const id = c.rows[0].id;
  await admin.query(
    `insert into messages (org_id, conversation_id, seq, role, content)
     values ($1, $2, 1, 'contact', 'Yes, tomorrow works for me.')`,
    [opts.org ?? orgId, id],
  );
  return id;
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
    `insert into contacts (org_id, first_name, consent) values ($1, 'Asha', $2) returning id`,
    [orgId, OPTED_IN],
  );
  contactId = c.rows[0].id;
  // phone identity (E.164) so the send handlers can resolve `to`
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', '+919876500000', true)`,
    [orgId, contactId],
  );
  agentId = await seedAgent(orgId, "closer");
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

describe("agent.turn (run_agent_turn) handler", () => {
  it("invokes the runTurn bridge: an agent message + a usage row land on the conversation", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {
      currentStep: "end",
      state: { contactId },
    });
    const conversationId = await seedConversation({ runId, agentId });
    const before = await countMessages(conversationId);
    const deps = {
      pool: appPool,
      provider: fakeLlm([
        { text: "Great, I'll confirm your slot.", usage: { in: 10, out: 5 } },
      ]),
      registry: new ToolRegistry(),
    };

    await handleAgentTurn(deps, {
      orgId,
      runId,
      action: { kind: "run_agent_turn", conversationId },
    });

    expect(await countMessages(conversationId)).toBeGreaterThan(before); // a turn ran
    expect(await countUsage(conversationId)).toBeGreaterThan(0); // metered
  });

  it("is idempotent: a DUPLICATE delivery adds no second turn (exactly-once)", async () => {
    const wf = await seedWorkflow(CALL_WF);
    const runId = await seedRun(wf, {
      currentStep: "end",
      state: { contactId },
    });
    const conversationId = await seedConversation({ runId, agentId });
    const before = await countMessages(conversationId);
    const deps = {
      pool: appPool,
      provider: fakeLlm([{ text: "confirmed", usage: { in: 8, out: 4 } }]),
      registry: new ToolRegistry(),
    };
    const job = {
      orgId,
      runId,
      action: { kind: "run_agent_turn" as const, conversationId },
    };

    await handleAgentTurn(deps, job);
    const afterOne = await countMessages(conversationId);
    await handleAgentTurn(deps, job); // re-delivery of the same job
    const afterTwo = await countMessages(conversationId);

    expect(afterOne).toBeGreaterThan(before); // the first turn added a message
    expect(afterTwo).toBe(afterOne); // ...the duplicate added nothing
  });
});

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
