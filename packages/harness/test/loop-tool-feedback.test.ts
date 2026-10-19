// A tool result must re-enter the prompt, or the loop re-sends.
//
// TODAY: on a tool round loop.ts:197-200 appends ONLY a role:'tool' row whose `content` is NULL
// (the payload lives in the `tool_call` jsonb), and the assistant turn that REQUESTED the call is
// never persisted at all. context.ts:45-51 then selects `role, content` only — `tool_call` is never
// read, and the tool row materializes as content "". So round N+1's prompt is byte-identical to
// round N's plus one EMPTY message: the model has no evidence its tool ran. Unreachable today only
// because H1 stops execute() from running; it goes live the moment H1 lands, and a real
// context-conditioned model then re-issues the same call every round — up to MAX_TOOL_ROUNDS (5)
// duplicate WhatsApp sends / bookings from ONE turn. (The empty-content messages are themselves
// invalid Anthropic input, which H2 would swallow as silence.)
//
// WHAT THESE TESTS PIN — that the INFORMATION is present, never a wire format. Round 2's prompt
// (and, separately, a LATER turn's freshly-assembled prompt) must carry the tool name, the args the
// assistant asked for, and the call's outcome. Deliberately NOT pinned: role names, whether the
// assistant turn is its own row, the rendering ("[tool x → ok]" and a JSON blob both pass), or the
// column the payload is stored in. Both halves are pinned because context.ts REBUILDS from the
// table on the next turn: a fix that only patches in-memory state leaves the next turn blind.
//
// ENV-FREE by construction (the convention of test/loop-guard-wiring.test.ts): runTurn touches the
// world only through ctx.db.query and the injected provider/send port, so a canned db with a real
// in-memory `messages` table replaces Postgres. It returns FULL rows (role, content, tool_call, seq)
// and hands `tool_call` back as a parsed object, exactly as pg does with jsonb — so a fix that
// renders tool_call inside context.ts works here as it would in prod. The DB-backed loop suite
// (test/loop.test.ts) stays CI-owned. TENANCY: no new table — cross-tenant denial does not apply.
import { describe, expect, it } from "bun:test";
import { assembleContext } from "../src/context";
import { runTurn } from "../src/loop";
import { buildCatalog, type ConfirmationMessage } from "../src/tools";
import type {
  LlmProvider,
  LlmTurn,
  Msg,
  OrgCtx,
  OrgScopedDb,
} from "../src/types";

const ORG = "org-1";
const CONV = "conv-1";
const CONTACT = "11111111-1111-4111-8111-111111111111";
const SYSTEM = "You are a test agent.";
// A marker only the tool's ARGS carry: it can reach round 2 only if the assistant's tool-call turn
// (or a rendering of it) is actually in the prompt.
const BODY = "Your site visit is confirmed for 5pm — MARKER-BODY-8f3.";
const CONFIRMATION = { contactId: CONTACT, channel: "whatsapp", body: BODY };
/** Any honest rendering of a successful tool result says so one of these ways. */
const OUTCOME = /"ok"\s*:\s*true|\bok\b|success/i;

type MessageRow = {
  seq: number;
  role: string;
  content: string | null;
  tool_call: unknown;
};

const maxSeq = (rows: MessageRow[]) =>
  rows.reduce((m, r) => Math.max(m, r.seq), 0);

/** Canned org-scoped db with a REAL in-memory messages table. */
function makeCtx(): { ctx: OrgCtx; messages: MessageRow[] } {
  const messages: MessageRow[] = [
    {
      seq: 1,
      role: "contact",
      content: "Hi — can you confirm my site visit?",
      tool_call: null,
    },
  ];
  const db: OrgScopedDb = {
    query: async (text: string, values: unknown[] = []) => {
      // Columns are read off the statement's OWN column list, so a fix may add or reorder them.
      // Assumption: one $n placeholder per column (the shape loop.ts uses today) — a fix that
      // computes seq in SQL instead would need this fake updated (flagged in the report).
      if (/insert\s+into\s+messages/i.test(text)) {
        const cols = /insert\s+into\s+messages\s*\(([^)]*)\)/i.exec(text)?.[1];
        const row: Record<string, unknown> = {};
        for (const [i, c] of (cols ?? "").split(",").entries())
          row[c.trim()] = values[i];
        const raw = row.tool_call;
        messages.push({
          seq: Number(row.seq ?? maxSeq(messages) + 1),
          role: String(row.role ?? ""),
          content: (row.content ?? null) as string | null,
          // jsonb semantics: pg hands tool_call BACK as a parsed object, so the fake must too.
          tool_call: typeof raw === "string" ? JSON.parse(raw) : (raw ?? null),
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*(insert|update)\s/i.test(text)) return { rows: [], rowCount: 1 };
      if (/coalesce\(max\(seq\)/i.test(text))
        return { rows: [{ seq: maxSeq(messages) + 1 }], rowCount: 1 };
      if (/contact_memories/i.test(text)) return { rows: [], rowCount: 0 };
      if (/from\s+conversations/i.test(text))
        return { rows: [{ contact_id: CONTACT }], rowCount: 1 };
      if (/from\s+messages|from\s*\(/i.test(text)) {
        const rows = [...messages]
          .sort((a, b) => a.seq - b.seq)
          .map((r) => ({ ...r }) as Record<string, unknown>);
        return { rows, rowCount: rows.length };
      }
      if (/guardrail_policies|workflow_runs/i.test(text))
        return { rows: [], rowCount: 0 }; // unconfigured = no quiet hours, no attempt cap
      if (/from\s+contacts/i.test(text))
        return {
          rows: [
            {
              consent: {
                dnc: false,
                whatsapp_optin: { status: "opted_in", source: "test fixture" },
              },
              timezone: "Asia/Kolkata",
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    },
  };
  return { ctx: { orgId: ORG, db }, messages };
}

/** Scripted provider that RECORDS the messages it is handed each round. */
function recordingProvider(turns: LlmTurn[]): {
  provider: LlmProvider;
  prompts: Msg[][];
} {
  const prompts: Msg[][] = [];
  let i = 0;
  return {
    prompts,
    provider: {
      complete: async (req) => {
        prompts.push(req.messages);
        return turns[Math.min(i++, turns.length - 1)] as LlmTurn;
      },
    },
  };
}

/** A model that READS its context, like the real one: it calls the tool only while the transcript
 *  shows no trace of that call. This is the fake the current fixtures never had. */
function contextConditionedProvider(
  name: string,
  args: unknown,
): {
  provider: LlmProvider;
  prompts: Msg[][];
} {
  const prompts: Msg[][] = [];
  return {
    prompts,
    provider: {
      complete: async (req) => {
        prompts.push(req.messages);
        return JSON.stringify(req.messages).includes(name)
          ? { text: "All set — anything else?", usage: { in: 10, out: 3 } }
          : { toolCalls: [{ name, args }], usage: { in: 10, out: 5 } };
      },
    },
  };
}

/** One turn: the production catalog, a recording send port, a scripted 2-round provider. */
async function runScriptedTurn() {
  const { ctx, messages } = makeCtx();
  const sends: ConfirmationMessage[] = [];
  const { provider, prompts } = recordingProvider([
    {
      toolCalls: [{ name: "send_confirmation", args: CONFIRMATION }],
      usage: { in: 10, out: 5 },
    },
    { text: "Confirmed.", usage: { in: 12, out: 2 } },
  ]);
  await runTurn(
    {
      provider,
      registry: buildCatalog({
        send: async (_c, m) => {
          sends.push(m);
          return { ok: true };
        },
      }),
      toolsAllowed: ["send_confirmation"],
      systemPrompt: SYSTEM,
    },
    ctx,
    CONV,
  );
  return { ctx, messages, prompts, sends };
}

describe("task-57 H3 — the tool result re-enters the prompt", () => {
  it("a context-conditioned model does not re-issue the same call: ONE send per turn", async () => {
    const { ctx } = makeCtx();
    const sends: ConfirmationMessage[] = [];
    const { provider, prompts } = contextConditionedProvider(
      "send_confirmation",
      CONFIRMATION,
    );
    await runTurn(
      {
        provider,
        registry: buildCatalog({
          send: async (_c, m) => {
            sends.push(m);
            return { ok: true };
          },
        }),
        toolsAllowed: ["send_confirmation"],
        systemPrompt: SYSTEM,
      },
      ctx,
      CONV,
    );
    // Today: the transcript never mentions the call, so the model repeats it every round —
    // MAX_TOOL_ROUNDS (5) identical WhatsApp messages to the contact from a single turn.
    expect(sends).toHaveLength(1);
    expect(prompts).toHaveLength(2); // one tool round, then the closing text round
  });

  it("round 2's prompt carries the tool name, the args it was called with, and the outcome", async () => {
    const { prompts } = await runScriptedTurn();
    expect(prompts).toHaveLength(2);
    const round1 = JSON.stringify(prompts[0]);
    const round2 = JSON.stringify(prompts[1]);
    expect(round2).not.toBe(round1);
    expect(round2).toContain("send_confirmation");
    expect(round2).toContain("MARKER-BODY-8f3");
    expect(round2).toMatch(OUTCOME);
  });

  it("no empty-content message is ever handed to the provider", async () => {
    // Anthropic rejects empty content blocks — the NULL-content tool row is a 400 in prod (which
    // H2 would swallow as silence).
    const { prompts } = await runScriptedTurn();
    for (const prompt of prompts)
      for (const m of prompt) expect(m.content.trim()).not.toBe("");
  });

  it("a LATER turn still sees the tool round: assembleContext rebuilds it from the table", async () => {
    // The next turn is a fresh process with only the rows to go on — the persistence half of the
    // contract. A fix that patches in-memory state alone leaves this turn blind.
    const { ctx } = await runScriptedTurn();
    const next = await assembleContext(ctx, CONV, SYSTEM);
    const transcript = JSON.stringify(next.messages);
    expect(transcript).toContain("send_confirmation");
    expect(transcript).toMatch(OUTCOME);
  });

  it("[guard — green today] the persisted rows keep the call, its args and its result", async () => {
    // Pins the payload against a "fix" that renders a summary into the prompt but drops the
    // structured record the console/audit trail reads.
    const { messages } = await runScriptedTurn();
    const persisted = JSON.stringify(messages);
    expect(persisted).toContain("send_confirmation");
    expect(persisted).toContain("MARKER-BODY-8f3");
    expect(persisted).toMatch(OUTCOME);
  });
});
