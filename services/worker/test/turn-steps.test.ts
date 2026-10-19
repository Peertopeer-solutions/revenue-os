// The AI turn runs in short steps with no transaction open while the model thinks (packages/harness/src/loop.ts), so
// what happens between those steps must still come out right, on the real local database:
// - a turn whose model fails after a tool round was saved is finished by its job's next run, never dropped;
// - a call whose run is handed to a person while the call's AI turn runs is not folded afterwards.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import { type LlmProvider, ToolRegistry } from "@revenue-os/harness";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handleAgentTurn } from "../src/handlers/agent-turn";
import { handlePlaceCall } from "../src/handlers/place-call";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 3,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let orgId = "";
let agentId = "";
let contactId = "";

beforeAll(async () => {
  orgId = (await companies.add("Turn Steps Org")).id;
  agentId = (
    await admin.query(
      `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
       values ($1, 'closer', 1, 'active', 'm', 'You are a scheduler.', '{}') returning id`,
      [orgId],
    )
  ).rows[0].id;
  contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [orgId],
    )
  ).rows[0].id;
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', '+919876511111', true)`,
    [orgId, contactId],
  );
});

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

const messagesOf = async (conversationId: string) =>
  (
    await admin.query(
      `select seq, role, content from messages where conversation_id = $1 order by seq`,
      [conversationId],
    )
  ).rows;

describe("the AI turn's short steps", () => {
  // behaviour already on main: there the whole turn was one transaction, so the failure undid the tool round and the next run redid the turn; this checks the next run still answers now that each round is saved on its own
  it("a turn whose model fails after a tool round was saved is answered by its job's next run", async () => {
    const conversationId = (
      await admin.query(
        `insert into conversations (org_id, contact_id, agent_id, channel, direction, status)
         values ($1, $2, $3, 'whatsapp', 'inbound', 'active') returning id`,
        [orgId, contactId, agentId],
      )
    ).rows[0].id;
    await admin.query(
      `insert into messages (org_id, conversation_id, seq, role, content) values ($1, $2, 1, 'contact', 'Is the flat free?')`,
      [orgId, conversationId],
    );
    let asked = 0;
    const provider: LlmProvider = {
      complete: async () => {
        asked += 1;
        if (asked === 1)
          return {
            toolCalls: [{ name: "check_flat", args: {} }],
            usage: { in: 1, out: 1 },
          };
        if (asked === 2) throw new Error("model 529 in round 2");
        return { text: "Yes, it is free.", usage: { in: 1, out: 1 } };
      },
    };
    const deps = { pool: appPool, provider, registry: new ToolRegistry() };
    const job = {
      orgId,
      runId: randomUUID(),
      action: { kind: "run_agent_turn" as const, conversationId },
    };

    await expect(handleAgentTurn(deps, job)).rejects.toThrow("model 529");
    await handleAgentTurn(deps, job); // the job's next run

    expect(asked).toBe(3);
    expect(
      (await messagesOf(conversationId)).map((m) => [m.seq, m.role]),
    ).toEqual([
      [1, "contact"],
      [2, "tool"],
      [3, "agent"],
    ]);
  });

  it("a call whose run is handed to a person while its AI turn runs is not folded afterwards", async () => {
    const sendId = randomUUID();
    const workflowId = (
      await admin.query(
        `insert into workflows (org_id, key, version, status, definition)
         values ($1, $2, 1, 'active', $3::jsonb) returning id`,
        [
          orgId,
          `turn-steps-${randomUUID()}`,
          JSON.stringify({
            entry: "c",
            steps: {
              c: { kind: "call", agent: "closer", on: { completed: "end" } },
              end: { kind: "end" },
            },
          }),
        ],
      )
    ).rows[0].id;
    const runId = (
      await admin.query(
        `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state)
         values ($1, $2, $3, 'waiting', 'c', $4::jsonb) returning id`,
        [orgId, workflowId, contactId, JSON.stringify({ callSendId: sendId })],
      )
    ).rows[0].id;
    // While the model thinks, a person takes the run over. The run must be free to change at once.
    const provider: LlmProvider = {
      complete: async () => {
        const c = await admin.connect();
        try {
          await c.query("begin");
          await c.query("set local lock_timeout = '2s'");
          await c.query(
            `update workflow_runs set status = 'failed' where id = $1`,
            [runId],
          );
          await c.query("commit");
        } finally {
          c.release();
        }
        return { text: "Namaste.", usage: { in: 1, out: 1 } };
      },
    };

    await handlePlaceCall(
      {
        pool: appPool,
        guard: async () => ({ ok: true }),
        sender: { place: async () => ({ providerRef: `vapi-ts-${sendId}` }) },
        provider,
        registry: new ToolRegistry(),
        outcome: async () => "completed",
      },
      {
        orgId,
        runId,
        sendId,
        step: "c",
        idx: 0,
        action: { kind: "place_call", contactId, agentKey: "closer" },
      },
    );

    const run = (
      await admin.query(
        `select status, state from workflow_runs where id = $1`,
        [runId],
      )
    ).rows[0];
    expect(run.status).toBe("failed");
    expect(run.state.lastDisposition).toBeUndefined();
  });

  it("a call job run again after its outcome failed folds the call without running or billing its AI turn twice", async () => {
    const sendId = randomUUID();
    const runId = await callRun(sendId);
    let asked = 0;
    let outcomes = 0;
    let dials = 0;
    const deps = {
      pool: appPool,
      guard: async () => ({ ok: true }) as const,
      sender: {
        place: async () => {
          dials += 1;
          return { providerRef: `vapi-ts-${sendId}` };
        },
      },
      provider: {
        complete: async () => {
          asked += 1;
          return { text: `Namaste (${asked}).`, usage: { in: 1, out: 1 } };
        },
      },
      registry: new ToolRegistry(),
      outcome: async () => {
        outcomes += 1;
        if (outcomes === 1) throw new Error("outcome service down");
        return "completed";
      },
    };
    const job = {
      orgId,
      runId,
      sendId,
      step: "c",
      idx: 0,
      action: { kind: "place_call" as const, contactId, agentKey: "closer" },
    };

    await expect(handlePlaceCall(deps, job)).rejects.toThrow(
      "outcome service down",
    );
    await handlePlaceCall(deps, job); // the job's next run

    expect({ dials, asked, outcomes }).toEqual({
      dials: 1,
      asked: 1,
      outcomes: 2,
    });
    const convo = (
      await admin.query(
        `select id from conversations where workflow_run_id = $1`,
        [runId],
      )
    ).rows[0].id;
    expect((await messagesOf(convo)).map((m) => [m.role, m.content])).toEqual([
      ["agent", "Namaste (1)."],
    ]);
    const usage = await admin.query(
      `select count(*)::int n from usage_events where conversation_id = $1 and kind = 'llm'`,
      [convo],
    );
    expect(usage.rows[0].n).toBe(1);
    const run = (
      await admin.query(`select state from workflow_runs where id = $1`, [
        runId,
      ])
    ).rows[0];
    expect(run.state.lastDisposition).toBe("completed");
  });
});

/** A run of a fresh lead waiting at a call step, parked for the call job whose send id `sendId` is. */
async function callRun(sendId: string): Promise<string> {
  const workflowId = (
    await admin.query(
      `insert into workflows (org_id, key, version, status, definition)
       values ($1, $2, 1, 'active', $3::jsonb) returning id`,
      [
        orgId,
        `turn-steps-${randomUUID()}`,
        JSON.stringify({
          entry: "c",
          steps: {
            c: { kind: "call", agent: "closer", on: { completed: "end" } },
            end: { kind: "end" },
          },
        }),
      ],
    )
  ).rows[0].id;
  return (
    await admin.query(
      `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state)
       values ($1, $2, $3, 'waiting', 'c', $4::jsonb) returning id`,
      [orgId, workflowId, contactId, JSON.stringify({ callSendId: sendId })],
    )
  ).rows[0].id;
}
