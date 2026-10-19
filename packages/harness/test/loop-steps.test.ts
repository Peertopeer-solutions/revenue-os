// runTurn given OrgUnits: each round reads in one short transaction, asks the model with none open, and saves in
// another (src/loop.ts), on the real local database. Two runs of one turn at once save one answer, the model is given
// its time limit, and a model that never answers is cut off.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool, withOrg } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { type OrgUnits, runTurn } from "../src/loop";
import { ToolRegistry } from "../src/registry";
import type { LlmProvider } from "../src/types";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appService = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let orgId = "";
let units: OrgUnits;

const turnDeps = (provider: LlmProvider, modelTimeLimitMs?: number) => ({
  provider,
  registry: new ToolRegistry(),
  toolsAllowed: [],
  systemPrompt: "You are a scheduler.",
  modelTimeLimitMs,
});

/** A conversation whose lead, one of its own, has written once. */
async function conversation(): Promise<string> {
  const contactId = (
    await admin.query(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [orgId],
    )
  ).rows[0].id;
  const id = (
    await admin.query(
      `insert into conversations (org_id, contact_id, channel, direction, status)
       values ($1, $2, 'whatsapp', 'inbound', 'active') returning id`,
      [orgId, contactId],
    )
  ).rows[0].id;
  await admin.query(
    `insert into messages (org_id, conversation_id, seq, role, content) values ($1, $2, 1, 'contact', 'Is the flat free?')`,
    [orgId, id],
  );
  return id;
}

beforeAll(async () => {
  orgId = (await companies.add("Loop Steps Org")).id;
  units = {
    orgId,
    inTransaction: (work) =>
      withOrg(appService, orgId, (tx) => work({ orgId, db: tx })),
  };
});

afterAll(async () => {
  await companies.cleanup();
  await appService.end();
  await admin.end();
});

describe("runTurn in short steps", () => {
  it("two runs of one turn at once save one answer, and keep both answers' usage", async () => {
    const id = await conversation();
    // Both runs read the conversation before either answer is saved: the model answers once both have asked.
    let release: () => void = () => {};
    const bothAsked = new Promise<void>((res) => {
      release = res;
    });
    let asked = 0;
    const provider: LlmProvider = {
      complete: async () => {
        asked += 1;
        if (asked === 2) release();
        await bothAsked;
        return { text: `Yes (${asked}).`, usage: { in: 1, out: 1 } };
      },
    };

    const runs = await Promise.allSettled([
      runTurn(turnDeps(provider), units, id),
      runTurn(turnDeps(provider), units, id),
    ]);

    expect(runs.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const answers = await admin.query(
      `select seq from messages where conversation_id = $1 and role = 'agent'`,
      [id],
    );
    expect(answers.rows).toEqual([{ seq: 2 }]);
    const usage = await admin.query(
      `select count(*)::int n from usage_events where conversation_id = $1 and kind = 'llm'`,
      [id],
    );
    expect(usage.rows[0].n).toBe(2);
  });

  it("gives the model its time limit, and cuts off a model that never answers", async () => {
    const id = await conversation();
    const seen: { timeoutMs?: number; signal?: AbortSignal }[] = [];
    const provider: LlmProvider = {
      complete: (req) => {
        seen.push({ timeoutMs: req.timeoutMs, signal: req.signal });
        return new Promise(() => {});
      },
    };

    await expect(runTurn(turnDeps(provider, 100), units, id)).rejects.toThrow(
      "the AI model did not answer within 100 ms",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.timeoutMs).toBe(100);
    expect(seen[0]?.signal?.aborted).toBe(true);
    const saved = await admin.query(
      `select count(*)::int n from messages where conversation_id = $1`,
      [id],
    );
    expect(saved.rows[0].n).toBe(1); // nothing saved from a turn that never got its answer
  });
});
