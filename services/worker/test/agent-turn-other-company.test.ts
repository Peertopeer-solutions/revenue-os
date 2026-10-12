// The AI's tools, run by the agent-turn job as the worker runs it, when the model names another company's lead
// (ROADMAP.md, Slice 1). Booking: the database refuses to attach company A's site visit to company B's lead, so the
// turn fails and nothing is written in either company. Renaming: the update filters by company, matches no lead, and
// the turn records that failure for the model to see. Slice 3 stops a tool call naming a lead at all; these are the
// fences beneath it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool } from "@revenue-os/db";
import {
  buildCatalog,
  type LlmProvider,
  type LlmTurn,
} from "@revenue-os/harness";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { handleAgentTurn } from "../src/handlers/agent-turn";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 1,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let a = "";
let b = "";
let theirLead = "";
let runId = "";
let conversationId = "";

const one = async (sql: string, values: unknown[]) =>
  String((await admin.query<{ id: string }>(sql, values)).rows[0]?.id);

beforeAll(async () => {
  a = (await companies.add("Turn A")).id;
  b = (await companies.add("Turn B")).id;
  theirLead = await one(
    `insert into contacts (org_id, first_name) values ($1, 'Rohan') returning id`,
    [b],
  );
  const ourLead = await one(
    `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
    [a],
  );
  const agent = await one(
    `insert into agents (org_id, key, status, model, system_prompt, tools_allowed)
     values ($1, 'closer', 'active', 'm', 'Book site visits.', '{book_appointment}') returning id`,
    [a],
  );
  const workflow = await one(
    `insert into workflows (org_id, key, status, definition) values ($1, 'wf', 'active', '{}') returning id`,
    [a],
  );
  runId = await one(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status) values ($1, $2, $3, 'running') returning id`,
    [a, workflow, ourLead],
  );
  conversationId = await one(
    `insert into conversations (org_id, contact_id, workflow_run_id, agent_id, channel, direction, status)
     values ($1, $2, $3, $4, 'whatsapp', 'inbound', 'active') returning id`,
    [a, ourLead, runId, agent],
  );
  await admin.query(
    `insert into messages (org_id, conversation_id, seq, role, content)
     values ($1, $2, 1, 'contact', 'Book Rohan''s visit for Sunday too')`,
    [a, conversationId],
  );
});

afterAll(async () => {
  await companies.cleanup();
  await Promise.all([admin.end(), appPool.end()]);
});

describe("the AI's booking tool naming another company's lead", () => {
  // behaviour already on main: migration 019 is applied to the one local database both copies of the code run against; before it, the visit was booked against the other company's lead
  it("is refused by the database, so the turn fails and no site visit or outcome is written", async () => {
    const provider: LlmProvider = {
      complete: async () => ({
        toolCalls: [
          {
            name: "book_appointment",
            args: {
              contactId: theirLead,
              startsAt: "2026-11-15T12:00:00Z",
              endsAt: "2026-11-15T13:00:00Z",
              timezone: "Asia/Kolkata",
            },
          },
        ],
        usage: { in: 10, out: 5 },
      }),
    };
    const registry = buildCatalog({
      send: async () => {
        throw new Error("no message is sent in this test");
      },
    });
    await expect(
      handleAgentTurn(
        { pool: appPool, provider, registry },
        {
          orgId: a,
          runId,
          action: { kind: "run_agent_turn", conversationId },
        },
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const written = await admin.query<{ n: number }>(
      `select (select count(*) from appointments where contact_id = $1 or org_id = any($2::uuid[]))::int
            + (select count(*) from outcomes where contact_id = $1 or org_id = any($2::uuid[]))::int as n`,
      [theirLead, [a, b]],
    );
    expect(written.rows[0]?.n).toBe(0);
  });
});

describe("the AI's update_contact tool naming another company's lead", () => {
  it("renames nothing, and the turn records the tool's contact_not_found for the model to see", async () => {
    const lead = await one(
      `insert into contacts (org_id, first_name) values ($1, 'Meera') returning id`,
      [a],
    );
    const agent = await one(
      `insert into agents (org_id, key, status, model, system_prompt, tools_allowed)
       values ($1, 'renamer', 'active', 'm', 'Keep names right.', '{update_contact}') returning id`,
      [a],
    );
    const conversation = await one(
      `insert into conversations (org_id, contact_id, agent_id, channel, direction, status)
       values ($1, $2, $3, 'whatsapp', 'inbound', 'active') returning id`,
      [a, lead, agent],
    );
    await admin.query(
      `insert into messages (org_id, conversation_id, seq, role, content)
       values ($1, $2, 1, 'contact', 'Rohan is called Hacked now')`,
      [a, conversation],
    );
    const turns: LlmTurn[] = [
      {
        toolCalls: [
          {
            name: "update_contact",
            args: { contactId: theirLead, firstName: "Hacked" },
          },
        ],
        usage: { in: 10, out: 5 },
      },
      { text: "I can't change that name.", usage: { in: 10, out: 5 } },
    ];
    const provider: LlmProvider = {
      complete: async () => turns.shift() ?? { usage: { in: 0, out: 0 } },
    };
    const registry = buildCatalog({
      send: async () => {
        throw new Error("no message is sent in this test");
      },
    });
    await handleAgentTurn(
      { pool: appPool, provider, registry },
      {
        orgId: a,
        runId,
        action: { kind: "run_agent_turn", conversationId: conversation },
      },
    );
    const tool = await admin.query<{ tool_call: { result: unknown } }>(
      `select tool_call from messages where conversation_id = $1 and role = 'tool'`,
      [conversation],
    );
    expect(tool.rows.map((r) => r.tool_call.result)).toEqual([
      { ok: false, error: "contact_not_found" },
    ]);
    const name = await admin.query<{ first_name: string }>(
      `select first_name from contacts where id = $1`,
      [theirLead],
    );
    expect(name.rows[0]?.first_name).toBe("Rohan");
  });
});
