// The AI's turn loop (docs/tech-stack.md T26.5): build the prompt, ask the model, record usage, run each tool call it
// asks for (src/tool-call.ts: validate, guard(), run, audit), add the tool's result as a message, and repeat up to
// MAX_TOOL_ROUNDS times before saving the model's closing message. Every message is written by the database package's
// one writer, addMessage.
// Stateless: every effect is a row; a crash mid-turn loses nothing that matters. The model gets a time limit, and a
// caller that passes OrgUnits holds no transaction, so no locked row, while the model thinks.
// G1: runtime-agnostic.

import { addMessage } from "@revenue-os/db";
import { assembleContext } from "./context";
import { emitUsage } from "./meter";
import type { ToolRegistry } from "./registry";
import { withTimeLimit } from "./time-limit";
import { runToolCall } from "./tool-call";
import type { LlmProvider, LlmTurn, OrgCtx, PolicyHook } from "./types";

const MAX_TOOL_ROUNDS = 5;

export interface TurnDeps {
  provider: LlmProvider;
  registry: ToolRegistry;
  toolsAllowed: readonly string[]; // agents.tools_allowed — docs/security.md S8.1 capability boundary
  systemPrompt: string;
  pipeline?: PolicyHook[];
  providerName?: string;
  modelTimeLimitMs?: number; // the longest the turn waits for the model (MODEL_TIME_LIMIT_MS when unset)
}

/** The seq the conversation's next line would take: a turn's answer is out of date once it moves. */
async function nextSeq(ctx: OrgCtx, conversationId: string): Promise<number> {
  const r = await ctx.db.query(
    `select coalesce(max(seq), 0) + 1 as seq from messages where conversation_id = $1 and org_id = $2`,
    [conversationId, ctx.orgId],
  );
  return Number(r.rows[0]?.seq ?? 1);
}

/** The longest the turn waits for the AI model's answer before it gives up (the worker may set its own). */
export const MODEL_TIME_LIMIT_MS = 60_000;

/**
 * How a turn reaches the database when it must not hold a transaction across the AI model's answer: each step's
 * database work runs in a short transaction of its own (the worker's withOrg), and the model is asked between two
 * such steps with none open, so no row stays locked while the model thinks.
 */
export type OrgUnits = {
  orgId: string;
  inTransaction: <T>(work: (ctx: OrgCtx) => Promise<T>) => Promise<T>;
};

/**
 * Drives one turn of `conversationId`. Given an OrgCtx, every step runs on its database (the caller's one
 * transaction). Given OrgUnits, each round reads the conversation in one short transaction, asks the model with none
 * open, and saves the answer in another, which first locks the conversation: when a message was added meanwhile
 * (another run of the same turn answered, or the lead wrote again), this answer is out of date, so only its usage is
 * saved and the turn stops; the newer message's own turn answers it.
 */
export async function runTurn(
  deps: TurnDeps,
  at: OrgCtx | OrgUnits,
  conversationId: string,
): Promise<void> {
  const step =
    "inTransaction" in at
      ? at.inTransaction
      : <T>(work: (ctx: OrgCtx) => Promise<T>) => work(at);
  const limit = deps.modelTimeLimitMs ?? MODEL_TIME_LIMIT_MS;

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const { input, seen } = await step(async (ctx) => ({
      input: await assembleContext(ctx, conversationId, deps.systemPrompt),
      seen: await nextSeq(ctx, conversationId),
    }));
    const turn = await withTimeLimit("the AI model", limit, (signal) =>
      deps.provider.complete({
        system: input.system,
        messages: input.messages,
        tools: deps.registry.specs(deps.toolsAllowed),
        timeoutMs: limit,
        signal,
      }),
    );
    const again = await step((ctx) =>
      saveRound(deps, ctx, conversationId, round, seen, turn),
    );
    if (!again) return;
  }
}

/** Saves one round's answer and runs its tools; says whether the turn goes on to another round. */
async function saveRound(
  deps: TurnDeps,
  ctx: OrgCtx,
  conversationId: string,
  round: number,
  seen: number,
  turn: LlmTurn,
): Promise<boolean> {
  const providerName = deps.providerName ?? "fake";
  await ctx.db.query(
    `select 1 from conversations where id = $1 and org_id = $2 for update`,
    [conversationId, ctx.orgId],
  );
  await emitUsage(ctx, {
    conversationId,
    kind: "llm",
    provider: providerName,
    quantity: turn.usage.in + turn.usage.out,
    unit: "tokens",
    meta: { in: turn.usage.in, out: turn.usage.out, round },
  });
  if ((await nextSeq(ctx, conversationId)) !== seen) return false; // a message came meanwhile: this answer is stale

  if (!turn.toolCalls || turn.toolCalls.length === 0) {
    if (turn.text)
      await addMessage(ctx.db, ctx.orgId, conversationId, {
        role: "agent",
        content: turn.text,
      });
    return false;
  }
  for (const call of turn.toolCalls)
    await addMessage(ctx.db, ctx.orgId, conversationId, {
      role: "tool",
      toolCall: await runToolCall(deps, ctx, conversationId, round, call),
    });
  return true;
}
