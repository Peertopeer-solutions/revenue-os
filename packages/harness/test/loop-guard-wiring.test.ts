// Guardrail ACTIVATION, loop half: the tool loop must hand guard() the CHANNEL and
// the CONTACT behind a send. Today loop.ts:111-115 builds `{kind:'tool', toolName, autonomy}` and
// nothing else, so dncHook / quietHoursHook / attemptCapHook (all three in defaultPipeline, all
// three keyed on action.channel) are INERT on every tool-driven send: they return null before
// their first DB read. The packages/channels doorways guard their own sends — the loop path does
// not, and that is a hole in the rule "guardrails run before every send, with no code path around guard()" (AGENTS.md), not a nicety.
//
// GROUND TRUTH (investigated, not assumed):
//   • The only production send tool is send_confirmation (tools/send-confirmation.ts) — port-only
//     by that rule — and it declares its send in its ZOD-VALIDATED args: {contactId, channel, body}.
//     book_appointment / update_contact carry a contactId but no channel. So "this invocation is
//     a send on channel X to contact Y" is readable off `parsed.data` at loop.ts:98, AFTER the
//     loop's schema check has validated it and BEFORE guard() runs.
//   • The conversation's own contact is the fallback identity: `conversations.contact_id`, the
//     same column retrieval.ts:50 reads (nullable — "unknown caller until resolved").
// These tests pin the CONTRACT (what guard sees, and what happens to the send), never a
// mechanism: an implementation that instead declares channel on the Tool passes them unchanged
// so long as send_confirmation ends up channel-bearing.
//
// ENV-FREE by construction: runTurn touches the world only through ctx.db.query and the injected
// provider/send port, so a canned fake DB replaces Postgres entirely. The DB-backed loop suite
// (test/loop.test.ts) stays CI-owned.
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { runTurn } from "../src/loop";
import { ToolRegistry } from "../src/registry";
import { buildCatalog } from "../src/tools";
import type {
  GuardedAction,
  LlmProvider,
  LlmTurn,
  OrgScopedDb,
  PolicyHook,
} from "../src/types";

const ORG = "org-1";
const CONVERSATION = "conv-1";
const ARGS_CONTACT = "11111111-1111-4111-8111-111111111111"; // named in the tool's args
const CONVO_CONTACT = "22222222-2222-4222-8222-222222222222"; // conversations.contact_id
const NOW = "2026-07-16T16:30:00Z"; // 22:00 IST — inside a 21:00–09:00 quiet window

type QueryLog = { text: string; values?: unknown[] };

/** Canned org-scoped DB: routes on statement shape, records everything the loop asks for. */
function makeCtx(
  opts: {
    conversationContactId?: string | null;
    policies?: Record<string, unknown>; // guardrail_policies key → config
    contacts?: Record<string, Record<string, unknown>>; // contacts keyed BY ID
    runAttempts?: Record<string, string[]>; // workflow_runs.attempts (newest run)
  } = {},
) {
  const queries: QueryLog[] = [];
  const db: OrgScopedDb = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/^\s*(insert|update)\s/i.test(text)) return { rows: [], rowCount: 1 };
      if (/coalesce\(max\(seq\)/i.test(text))
        return { rows: [{ seq: 1 }], rowCount: 1 };
      if (/contact_memories/i.test(text)) return { rows: [], rowCount: 0 };
      if (/from conversations/i.test(text)) {
        const contact_id =
          opts.conversationContactId === undefined
            ? CONVO_CONTACT
            : opts.conversationContactId;
        return { rows: [{ contact_id }], rowCount: 1 };
      }
      if (/from\s*\(/i.test(text) || /from messages/i.test(text))
        return {
          rows: [{ role: "contact", content: "hello" }],
          rowCount: 1,
        };
      if (/guardrail_policies/i.test(text)) {
        const config = opts.policies?.[String(values?.[0])];
        return config
          ? { rows: [{ config }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/workflow_runs/i.test(text))
        return opts.runAttempts
          ? { rows: [{ attempts: opts.runAttempts }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      if (/contacts/i.test(text)) {
        const id = values?.[0];
        const row = typeof id === "string" ? opts.contacts?.[id] : undefined;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { ctx: { orgId: ORG, db, now: () => new Date(NOW) }, queries };
}

/** Scripted provider: one tool call, then a closing text turn. */
function fakeLlm(name: string, args: unknown): LlmProvider {
  const turns: LlmTurn[] = [
    { toolCalls: [{ name, args }], usage: { in: 10, out: 5 } },
    { text: "done", usage: { in: 10, out: 2 } },
  ];
  let i = 0;
  return {
    complete: async () => turns[Math.min(i++, turns.length - 1)] as LlmTurn,
  };
}

/** A pipeline of ONE recorder hook: captures the action guard() was handed, blocks nothing. */
function recorder(): { hook: PolicyHook; actions: GuardedAction[] } {
  const actions: GuardedAction[] = [];
  const hook: PolicyHook = async (_ctx, action) => {
    actions.push(action);
    return null;
  };
  return { hook, actions };
}

/** The tool_call json on the last TOOL message the loop persisted (appendMessage binds role at
 *  $4 and tool_call at $6; the closing assistant message carries a null tool_call). */
function lastToolCall(queries: QueryLog[]): {
  name?: string;
  result?: { ok: boolean; error?: string; data?: unknown };
} {
  const rows = queries.filter(
    (q) => /insert into messages/i.test(q.text) && q.values?.[3] === "tool",
  );
  const raw = rows[rows.length - 1]?.values?.[5];
  return typeof raw === "string" ? JSON.parse(raw) : {};
}

const sendPort = () => {
  const calls: unknown[] = [];
  return {
    calls,
    port: async (_c: unknown, msg: unknown) => {
      calls.push(msg);
      return { ok: true };
    },
  };
};

const IST_QUIET = { start: "21:00", end: "09:00", tz: "contact" };
const WA_CAP = { whatsapp: { max: 2, per_hours: 24 } };
const TWO_WA_ATTEMPTS = {
  whatsapp: ["2026-07-16T10:00:00Z", "2026-07-16T14:00:00Z"], // both inside 24h of NOW
};
const CONFIRMATION = {
  contactId: ARGS_CONTACT,
  channel: "whatsapp",
  body: "See you at 5pm.",
};

describe("task-56 AC1 — the loop hands guard() the channel + contact behind a send", () => {
  it("send_confirmation (the production catalog's only send tool): guard sees channel 'whatsapp' AND the args' contactId", async () => {
    const { port } = sendPort();
    const { hook, actions } = recorder();
    const { ctx } = makeCtx();
    await runTurn(
      {
        provider: fakeLlm("send_confirmation", CONFIRMATION),
        registry: buildCatalog({ send: port }),
        toolsAllowed: ["send_confirmation"],
        systemPrompt: "t",
        pipeline: [hook],
      },
      ctx,
      CONVERSATION,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "tool",
      toolName: "send_confirmation",
      autonomy: "auto",
      channel: "whatsapp",
      contactId: ARGS_CONTACT, // the recipient the port will actually send to
    });
  });

  it("a send tool that names no contact falls back to the CONVERSATION's contact (conversations.contact_id)", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "send_followup",
      description: "channel in args, recipient implied by the conversation",
      schema: z
        .object({ channel: z.enum(["sms", "whatsapp"]), body: z.string() })
        .strict(),
      autonomy: "auto",
      execute: async () => ({ ok: true as const, data: null }),
    });
    const { hook, actions } = recorder();
    const { ctx } = makeCtx();
    await runTurn(
      {
        provider: fakeLlm("send_followup", { channel: "sms", body: "ping" }),
        registry,
        toolsAllowed: ["send_followup"],
        systemPrompt: "t",
        pipeline: [hook],
      },
      ctx,
      CONVERSATION,
    );
    expect(actions[0]).toMatchObject({
      channel: "sms", // read off the invocation, not hardcoded to whatsapp
      contactId: CONVO_CONTACT,
    });
  });

  it("a channel-LESS production tool is unchanged: guard sees NO channel and the tool still executes", async () => {
    const { port } = sendPort();
    const { hook, actions } = recorder();
    const { ctx, queries } = makeCtx();
    await runTurn(
      {
        provider: fakeLlm("update_contact", {
          contactId: ARGS_CONTACT,
          firstName: "Ada",
        }),
        registry: buildCatalog({ send: port }),
        toolsAllowed: ["update_contact"],
        systemPrompt: "t",
        pipeline: [hook],
      },
      ctx,
      CONVERSATION,
    );
    expect(actions[0]?.channel).toBeUndefined();
    expect(queries.some((q) => /^\s*update contacts/i.test(q.text))).toBe(true);
  });

  it("an args key called 'channel' that is not a wire channel ('internal') does NOT become a guarded send", async () => {
    // Otherwise a note-taking tool inherits the whole send posture — dnc would fail closed on it
    // and a cap keyed on an unknown channel would silently never apply. GuardedAction.channel is
    // typed to the four wire channels; anything else is channel-LESS.
    const registry = new ToolRegistry();
    registry.register({
      name: "log_note",
      description: "internal note, no outbound send",
      schema: z
        .object({ channel: z.literal("internal"), note: z.string() })
        .strict(),
      autonomy: "auto",
      execute: async () => ({ ok: true as const, data: null }),
    });
    const { hook, actions } = recorder();
    const { ctx } = makeCtx();
    await runTurn(
      {
        provider: fakeLlm("log_note", { channel: "internal", note: "n" }),
        registry,
        toolsAllowed: ["log_note"],
        systemPrompt: "t",
        pipeline: [hook],
      },
      ctx,
      CONVERSATION,
    );
    expect(actions[0]?.channel).toBeUndefined();
  });
});

// The acceptance criterion proper: with the REAL defaultPipeline (no injected pipeline), a
// tool-driven send is actually stopped. "Stopped" means BOTH: the send port is never touched, and
// the blocking reason is persisted on the tool message (loop.ts:146) so the transcript shows why.
describe("task-56 AC1 end-to-end — defaultPipeline BITES on a tool-driven send", () => {
  // Every lead here agreed to WhatsApp messages, so only the check each test is about can refuse its send.
  const optedIn = (
    contacts: NonNullable<Parameters<typeof makeCtx>[0]>["contacts"] = {},
  ) =>
    Object.fromEntries(
      Object.entries(contacts).map(([id, c]) => [
        id,
        {
          ...c,
          consent: {
            ...(c.consent as object),
            whatsapp_optin: { status: "opted_in", source: "test fixture" },
          },
        },
      ]),
    );
  const runSend = async (opts: Parameters<typeof makeCtx>[0]) => {
    const { port, calls } = sendPort();
    const { ctx, queries } = makeCtx({
      ...opts,
      contacts: optedIn(opts.contacts),
    });
    await runTurn(
      {
        provider: fakeLlm("send_confirmation", CONFIRMATION),
        registry: buildCatalog({ send: port }),
        toolsAllowed: ["send_confirmation"],
        systemPrompt: "t",
      },
      ctx,
      CONVERSATION,
    );
    return { calls, queries };
  };

  it("DNC-listed recipient (contacts.consent->>'dnc') → blocked 'dnc', the send port is never called", async () => {
    // The conversation's contact is CLEAN — only the recipient named in the args is listed. A
    // guard that checked the conversation's contact instead would let this send through.
    const { calls, queries } = await runSend({
      contacts: {
        [ARGS_CONTACT]: { id: ARGS_CONTACT, consent: { dnc: true } },
        [CONVO_CONTACT]: { id: CONVO_CONTACT, consent: { dnc: false } },
      },
    });
    expect(calls).toHaveLength(0);
    expect(lastToolCall(queries).result).toEqual({ ok: false, error: "dnc" });
  });

  it("inside the org's quiet window (tz:'contact') → blocked 'quiet_hours', the send port is never called", async () => {
    const { calls, queries } = await runSend({
      policies: { quiet_hours: IST_QUIET },
      contacts: {
        [ARGS_CONTACT]: {
          id: ARGS_CONTACT,
          consent: { dnc: false },
          timezone: "Asia/Kolkata", // 22:00 local at NOW — inside 21:00–09:00
        },
      },
    });
    expect(calls).toHaveLength(0);
    expect(lastToolCall(queries).result).toEqual({
      ok: false,
      error: "quiet_hours",
    });
  });

  it("attempt cap reached for the channel (2 whatsapp attempts, max 2 per 24h) → blocked 'attempt_cap', no send", async () => {
    const { calls, queries } = await runSend({
      policies: { attempt_caps: WA_CAP },
      contacts: {
        [ARGS_CONTACT]: { id: ARGS_CONTACT, consent: { dnc: false } },
      },
      runAttempts: TWO_WA_ATTEMPTS,
    });
    expect(calls).toHaveLength(0);
    expect(lastToolCall(queries).result).toEqual({
      ok: false,
      error: "attempt_cap",
    });
  });

  it("a clean recipient with no hostile policy still sends — activation must not block everything", async () => {
    const { calls, queries } = await runSend({
      contacts: {
        [ARGS_CONTACT]: { id: ARGS_CONTACT, consent: { dnc: false } },
      },
    });
    expect(calls).toHaveLength(1);
    expect(lastToolCall(queries).result).toEqual({ ok: true, data: null });
  });

  it("a channel-LESS tool passes EXACTLY as today under dnc + quiet-hours + cap configs that would all fire on a send", async () => {
    const { port } = sendPort();
    const { ctx, queries } = makeCtx({
      policies: { quiet_hours: IST_QUIET, attempt_caps: WA_CAP },
      contacts: {
        [ARGS_CONTACT]: {
          id: ARGS_CONTACT,
          consent: { dnc: true },
          timezone: "Asia/Kolkata",
        },
      },
      runAttempts: TWO_WA_ATTEMPTS,
    });
    await runTurn(
      {
        provider: fakeLlm("update_contact", {
          contactId: ARGS_CONTACT,
          firstName: "Ada",
        }),
        registry: buildCatalog({ send: port }),
        toolsAllowed: ["update_contact"],
        systemPrompt: "t",
      },
      ctx,
      CONVERSATION,
    );
    expect(queries.some((q) => /^\s*update contacts/i.test(q.text))).toBe(true);
    expect(lastToolCall(queries).result).toMatchObject({ ok: true });
  });

  it("POSITION: a send whose recipient cannot be resolved at all (conversation contact_id null, no id in args) → blocked 'dnc', no send", async () => {
    // The inbound "unknown caller until resolved" shape (retrieval.ts:50). No identity ⇒ no
    // consent lookup ⇒ no send: the fail-closed posture, end to end.
    const registry = new ToolRegistry();
    registry.register({
      name: "send_followup",
      description: "channel in args, recipient implied by the conversation",
      schema: z
        .object({ channel: z.enum(["sms", "whatsapp"]), body: z.string() })
        .strict(),
      autonomy: "auto",
      execute: async () => ({ ok: true as const, data: null }),
    });
    const { ctx, queries } = makeCtx({ conversationContactId: null });
    await runTurn(
      {
        provider: fakeLlm("send_followup", { channel: "sms", body: "ping" }),
        registry,
        toolsAllowed: ["send_followup"],
        systemPrompt: "t",
      },
      ctx,
      CONVERSATION,
    );
    expect(lastToolCall(queries).result).toEqual({ ok: false, error: "dnc" });
  });
});
