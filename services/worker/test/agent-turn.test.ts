// The run_agent_turn job handler, the bridge to the harness turn loop, against the real local database
// (conversations, messages, usage_events and row-level security through withOrg), so it runs with the local stack's
// settings (`bun run gate`, CI). The handler is invoked DIRECTLY with a job payload (no pg-boss here); a duplicate
// delivery must add no second turn.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import {
  type LlmProvider,
  type LlmTurn,
  ToolRegistry,
} from "@revenue-os/harness";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handleAgentTurn } from "../src/handlers/agent-turn";

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
