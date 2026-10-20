// The eval RUNNER, driven against the REAL local stack (real DB rows, real harness runTurn), with
// the two LLM-shaped seams (provider + persona player) INJECTED as mocks. Tests NEVER call
// Anthropic: the real provider is wired only at runtime via ANTHROPIC_API_KEY. Real local
// database: runs with the local stack's settings (`bun run gate`, CI).
//
// Covers loading/malformed rows, driving via injected provider+player, sends captured not
// delivered, the assertions engine (integration side), persistence, exit discipline + summary,
// and --scenario scoping. Row-level security on eval runs lives in tests/eval-runs-rls.test.ts;
// the pure assertion semantics live in eval-assertions.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPool, withOrg } from "@revenue-os/db";
import type { LlmProvider, LlmTurn, SendPort } from "@revenue-os/harness";
import pg from "pg";
import { OPTED_IN } from "../tests/opted-in";
import { testCompanies } from "../tests/test-companies";
import {
  type CapturedSend,
  type EvalDeps,
  loadScenarios,
  type PersonaPlayer,
  runEvals,
  runScenario,
} from "./eval-runner";

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
let agentId = "";
let contactId = "";

const TOOLS = [
  "book_appointment",
  "update_contact",
  "send_confirmation",
] as const;

async function insertScenario(
  key: string,
  persona: string,
  script: string,
  assertions: string,
) {
  await admin.query(
    `insert into eval_scenarios (org_id, key, persona, script, assertions)
     values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
    [orgId, key, persona, script, assertions],
  );
}

beforeAll(async () => {
  orgId = (await companies.add("Eval Runner Org")).id;
  const agent = await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, 'eval-agent', 1, 'draft', 'claude-sonnet-4-6', 'You are a scheduler.', $2)
     returning id`,
    [orgId, TOOLS as unknown as string[]],
  );
  agentId = agent.rows[0].id;
  const contact = await admin.query(
    `insert into contacts (org_id, first_name, consent) values ($1, 'Persona', $2) returning id`,
    [orgId, OPTED_IN], // the persona agreed to WhatsApp messages, so a captured send is never refused
  );
  contactId = contact.rows[0].id;

  await insertScenario(
    "eager_buyer",
    '{"name":"Eager buyer","language":"en","traits":["decisive"]}',
    '{"turns":["asks about 2BHK","agrees to site visit"]}',
    '{"expect_outcome":"site_visit_booked"}',
  );
  await insertScenario(
    "always_passes",
    '{"name":"Trivial","language":"en"}',
    '{"turns":["says hi"]}',
    "{}",
  );
  await insertScenario(
    "needs_outcome",
    '{"name":"No-show","language":"en"}',
    '{"turns":["asks a question"]}',
    '{"expect_outcome":"site_visit_booked"}',
  );
  // a malformed persona (missing required name) must fail ONLY its own scenario.
  await insertScenario("malformed_persona", "{}", '{"turns":["hi"]}', "{}");
});

afterAll(async () => {
  await companies.cleanup();
  await appService.end();
  await admin.end();
});

// ── seams: canned, never a real LLM ───────────────────────────────────────────────────────
function fakeLlm(turns: LlmTurn[]): LlmProvider & { calls: number } {
  const p = {
    calls: 0,
    complete: async () => {
      const t = turns[Math.min(p.calls, turns.length - 1)];
      p.calls += 1;
      return t;
    },
  };
  return p;
}

const textLlm = (): LlmProvider & { calls: number } =>
  fakeLlm([{ text: "Understood.", usage: { in: 10, out: 5 } }]);

/** Canned persona player: replays script.turns in order, then ends the conversation. */
const cannedPlayer: PersonaPlayer & { calls: number } = Object.assign(
  async (scn: { script: { turns: string[] } }, i: number) =>
    scn.script.turns[i] ?? null,
  { calls: 0 },
);

/** Eval-mode send: records instead of delivering. Inline so the only stub under test is runner. */
function makeCaptureSend(): { send: SendPort; captured: CapturedSend[] } {
  const captured: CapturedSend[] = [];
  const send: SendPort = async (ctx, msg) => {
    captured.push({ ctx, msg });
    return { ok: true };
  };
  return { send, captured };
}

function baseDeps(provider: LlmProvider, send: SendPort): EvalDeps {
  return {
    provider,
    player: cannedPlayer,
    send,
    agentId,
    systemPrompt: "You are a scheduler.",
    toolsAllowed: TOOLS,
  };
}

// ── Scenario loading + malformed-row tolerance ──────────────────────────────────────────────
describe("loadScenarios", () => {
  it("Zod-parses valid rows and returns them", async () => {
    const res = await withOrg(appService, orgId, (tx) =>
      loadScenarios({ orgId, db: tx }),
    );
    const keys = res.scenarios.map((s) => s.key).sort();
    expect(keys).toContain("eager_buyer");
    expect(keys).toContain("always_passes");
  });

  it("a malformed scenario row is recorded as an error, not thrown, and does not drop the good rows", async () => {
    const res = await withOrg(appService, orgId, (tx) =>
      loadScenarios({ orgId, db: tx }),
    );
    // the good rows survived
    expect(res.scenarios.some((s) => s.key === "eager_buyer")).toBe(true);
    // the malformed one is absent from scenarios and present in errors
    expect(res.scenarios.some((s) => s.key === "malformed_persona")).toBe(
      false,
    );
    expect(res.errors.some((e) => e.key === "malformed_persona")).toBe(true);
  });
});

// ── Conversation driving via INJECTED provider + persona player ─────────────────────────────
describe("runScenario conversation driving", () => {
  it("drives contact turns from the injected player and agent turns through the real runTurn with the injected provider", async () => {
    const provider = textLlm();
    const { send } = makeCaptureSend();
    const scenario = {
      id: "x",
      key: "always_passes",
      persona: { name: "Trivial", language: "en" },
      script: { turns: ["says hi", "says bye"] },
      assertions: {},
    };

    const result = await withOrg(appService, orgId, (tx) =>
      runScenario(baseDeps(provider, send), { orgId, db: tx }, scenario),
    );

    // the injected mock provider was the ONLY brain consulted (Anthropic never reachable in tests)
    expect(provider.calls).toBeGreaterThan(0);
    expect(result.conversationId).toBeDefined();

    const msgs = await admin.query(
      `select role from messages where conversation_id = $1 order by seq`,
      [result.conversationId],
    );
    const roles = msgs.rows.map((m) => m.role);
    expect(roles).toContain("contact"); // player turns persisted
    expect(roles).toContain("agent"); // real runTurn persisted the closing text
  });

  it("finishes each scenario's conversation, even one whose driving fails, so the next scenario on the same lead gets its own", async () => {
    const { send } = makeCaptureSend();
    const scenario = {
      id: "x",
      key: "always_passes",
      persona: { name: "Trivial", language: "en" },
      script: { turns: ["says hi"] },
      assertions: {},
    };
    const ok = await withOrg(appService, orgId, (tx) =>
      runScenario(baseDeps(textLlm(), send), { orgId, db: tx }, scenario),
    );
    const broken: LlmProvider = {
      complete: async () => {
        throw new Error("model down");
      },
    };
    let failedIn = "";
    await withOrg(appService, orgId, async (tx) => {
      await runScenario(
        baseDeps(broken, send),
        { orgId, db: tx },
        scenario,
      ).catch((err: Error) => {
        failedIn = err.message;
      });
    });
    expect(failedIn).toBe("model down");
    const convos = await admin.query(
      `select id, status, ended_at from conversations
        where org_id = $1 and contact_id = (select contact_id from conversations where id = $2)
        order by created_at`,
      [orgId, ok.conversationId],
    );
    expect(convos.rows.at(-2)).toMatchObject({
      id: ok.conversationId,
      status: "completed",
    });
    expect(convos.rows.at(-1)?.id).not.toBe(ok.conversationId);
    expect(convos.rows.at(-1)?.status).toBe("completed");
    expect(convos.rows.at(-1)?.ended_at).toBeInstanceOf(Date);
  });
});

// ── Sends are CAPTURED in eval mode, never delivered ────────────────────────────────────────
describe("runScenario send capture", () => {
  it("a scenario whose agent calls send_confirmation records the send and performs no real delivery", async () => {
    const provider = fakeLlm([
      {
        toolCalls: [
          {
            name: "send_confirmation",
            args: { contactId, channel: "whatsapp", body: "See you Saturday!" },
          },
        ],
        usage: { in: 40, out: 8 },
      },
      { text: "Sent.", usage: { in: 20, out: 4 } },
    ]);
    const { send, captured } = makeCaptureSend();
    const scenario = {
      id: "s",
      key: "always_passes",
      persona: { name: "Trivial", language: "en" },
      script: { turns: ["confirm my visit"] },
      assertions: {},
    };

    await withOrg(appService, orgId, (tx) =>
      runScenario(baseDeps(provider, send), { orgId, db: tx }, scenario),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].msg.body).toBe("See you Saturday!");
  });
});

// ── Assertions engine (integration side) + persistence ──────────────────────────────────────
describe("runScenario assertions + persistence", () => {
  it("expect_outcome PASSES when the agent produces the outcome, and persists one eval_runs row", async () => {
    const provider = fakeLlm([
      {
        toolCalls: [
          {
            name: "book_appointment",
            args: {
              contactId,
              startsAt: "2026-09-01T10:00:00.000Z",
              endsAt: "2026-09-01T10:30:00.000Z",
              timezone: "Asia/Kolkata",
            },
          },
        ],
        usage: { in: 50, out: 12 },
      },
      { text: "Booked.", usage: { in: 30, out: 6 } },
    ]);
    const { send } = makeCaptureSend();
    const scenario = {
      id: "e",
      key: "eager_buyer",
      persona: { name: "Eager", language: "en" },
      script: { turns: ["book my visit"] },
      assertions: { expect_outcome: "site_visit_booked" },
    };

    const result = await withOrg(appService, orgId, (tx) =>
      runScenario(baseDeps(provider, send), { orgId, db: tx }, scenario),
    );

    expect(result.passed).toBe(true);
    const detail = result.scores.assertions.find(
      (a) => a.kind === "expect_outcome",
    );
    expect(detail?.passed).toBe(true);

    const rows = await admin.query(
      `select passed, scores, transcript_ref, agent_id, org_id
         from eval_runs where transcript_ref = $1`,
      [result.conversationId],
    );
    expect(rows.rowCount).toBe(1); // exactly one row per scenario
    expect(rows.rows[0].passed).toBe(true);
    expect(rows.rows[0].transcript_ref).toBe(result.conversationId);
    expect(rows.rows[0].agent_id).toBe(agentId);
    expect(rows.rows[0].org_id).toBe(orgId);
    // scores jsonb carries per-assertion detail (the minimum persistence promises)
    expect(JSON.stringify(rows.rows[0].scores)).toContain("site_visit_booked");
  });

  it("expect_outcome FAILS (and persists passed=false) when the agent never produces the outcome", async () => {
    const provider = textLlm();
    const { send } = makeCaptureSend();
    const scenario = {
      id: "n",
      key: "needs_outcome",
      persona: { name: "No-show", language: "en" },
      script: { turns: ["chats aimlessly"] },
      assertions: { expect_outcome: "site_visit_booked" },
    };

    const result = await withOrg(appService, orgId, (tx) =>
      runScenario(baseDeps(provider, send), { orgId, db: tx }, scenario),
    );

    expect(result.passed).toBe(false);
    const rows = await admin.query(
      `select passed from eval_runs where transcript_ref = $1`,
      [result.conversationId],
    );
    expect(rows.rows[0].passed).toBe(false);
  });
});

// ── must_capture, integration: the `captured` map is READ BACK from the contact
//    ROW (ground truth), never echoed from tool-call args. update_contact's real .strict() schema
//    writes first_name/last_name (verified in the schema of updateContact, packages/harness/src/tools/update-contact.ts;
//    it CANNOT write budget_min/preferred_location — no such columns, unknown keys rejected). So
//    must_capture names the snake_case DB COLUMNS while the tool args are camelCase — arg-echo
//    (firstName/lastName) therefore cannot satisfy must_capture, which is the discriminator.
describe("runScenario must_capture ground truth", () => {
  it("passes must_capture only when the named fields are present on the contact ROW the agent wrote (read-back, not arg-echo)", async () => {
    const provider = fakeLlm([
      {
        toolCalls: [
          {
            name: "update_contact",
            args: { contactId, firstName: "Ground", lastName: "Truth" },
          },
        ],
        usage: { in: 40, out: 9 },
      },
      { text: "Captured.", usage: { in: 20, out: 4 } },
    ]);
    const { send } = makeCaptureSend();
    const scenario = {
      id: "c",
      key: "capture_case",
      persona: { name: "Buyer", language: "en" },
      script: { turns: ["my name is Ground Truth"] },
      assertions: { must_capture: ["first_name", "last_name"] },
    };

    const result = await withOrg(appService, orgId, (tx) =>
      runScenario(baseDeps(provider, send), { orgId, db: tx }, scenario),
    );

    // (a) ground truth: the contact ROW actually holds the written fields
    const row = await admin.query(
      `select first_name, last_name from contacts where id = $1`,
      [contactId],
    );
    expect(row.rows[0].first_name).toBe("Ground");
    expect(row.rows[0].last_name).toBe("Truth");

    // (b) the engine read those fields back FROM the row (snake_case), not the camelCase args
    const byName = Object.fromEntries(
      result.scores.assertions.map((a) => [a.name, a]),
    );
    expect(byName.first_name?.kind).toBe("must_capture");
    expect(byName.first_name?.passed).toBe(true);
    expect(byName.last_name?.passed).toBe(true);
  });
});

// ── Exit discipline, summary, and --scenario scoping ────────────────────────────────────────
describe("runEvals exit discipline + scoping", () => {
  it("exits 1 when any scenario fails and prints one summary line per scenario key", async () => {
    const provider = textLlm(); // no tools → every expect_outcome scenario fails
    const { send } = makeCaptureSend();

    const out = await withOrg(appService, orgId, (tx) =>
      runEvals(baseDeps(provider, send), { orgId, db: tx }),
    );

    expect(out.exitCode).toBe(1); // eager_buyer/needs_outcome/malformed_persona fail
    expect(out.summary).toContain("always_passes");
    expect(out.summary).toContain("eager_buyer");
    // a malformed row is a recorded failure, never a crash of the whole run
    const malformed = out.results.find((r) => r.key === "malformed_persona");
    expect(malformed?.passed).toBe(false);
    expect(malformed?.error).toBeDefined();
  });

  it("all-pass runs exit 0", async () => {
    const provider = textLlm();
    const { send } = makeCaptureSend();
    const out = await withOrg(appService, orgId, (tx) =>
      runEvals(
        baseDeps(provider, send),
        { orgId, db: tx },
        {
          scenario: "always_passes",
        },
      ),
    );
    expect(out.exitCode).toBe(0);
  });

  it("--scenario <key> runs exactly one scenario", async () => {
    const provider = textLlm();
    const { send } = makeCaptureSend();
    const out = await withOrg(appService, orgId, (tx) =>
      runEvals(
        baseDeps(provider, send),
        { orgId, db: tx },
        {
          scenario: "always_passes",
        },
      ),
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0].key).toBe("always_passes");
  });
});
