// The AI's turn loop: build the prompt, ask the model, record usage, validate the tool arguments with zod, run guard(),
// run the tool, write the audit row, add the tool's result as a message, and repeat up to MAX_TOOL_ROUNDS times before
// saving the model's closing message. The audit row, an approval's task and every message are written by the database
// package's one writers (audit, createTask, addMessage), in the turn's own transaction.
// Stateless: every effect is a row; a crash mid-turn loses nothing that matters.
// G1: runtime-agnostic.

import { addMessage, audit, createTask } from "@revenue-os/db";
import { assembleContext } from "./context";
import { emitUsage } from "./meter";
import { guard } from "./policies";
import type { ToolRegistry } from "./registry";
import type {
  GuardedAction,
  LlmProvider,
  OrgCtx,
  PolicyHook,
  ToolResult,
} from "./types";

const MAX_TOOL_ROUNDS = 5;

// What guard() is told about a tool call. The do-not-call, calling-hours and attempt-limit checks all key on
// action.channel, so a send that arrives without a channel is a send nobody guards (AGENTS.md: guardrails run before
// every send, with no code path around guard()). Both facts are read off the arguments after zod has validated them:
// send_confirmation declares {contactId, channel, body}.
const WIRE_CHANNELS = ["voice", "whatsapp", "sms", "email"] as const;
type WireChannel = (typeof WIRE_CHANNELS)[number];

const strField = (args: unknown, key: string): string | undefined => {
  const v = (args as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" ? v : undefined;
};

/** Only the four wire channels make an action a guarded SEND — 'internal' and friends do not. */
const wireChannel = (args: unknown): WireChannel | undefined => {
  const c = strField(args, "channel");
  return WIRE_CHANNELS.includes(c as WireChannel)
    ? (c as WireChannel)
    : undefined;
};

/** The conversation's own contact — the fallback recipient when the args name none (nullable:
 *  "unknown caller until resolved", as retrieveMemories says). Read only for identity-less sends. */
async function conversationContactId(
  ctx: OrgCtx,
  conversationId: string,
): Promise<string | undefined> {
  const r = await ctx.db.query(
    `select contact_id from conversations where id = $1 and org_id = $2`,
    [conversationId, ctx.orgId],
  );
  const id = r.rows[0]?.contact_id;
  return typeof id === "string" ? id : undefined;
}

/** An approval-gated tool call becomes a task for a person (AGENTS.md hard rail 5: never a silent drop), always for the
 *  conversation's lead and its run. A conversation with no lead leaves no one to ask about, so the turn fails, loudly. */
async function askForApproval(
  ctx: OrgCtx,
  conversationId: string,
  tool: string,
  args: unknown,
): Promise<void> {
  const convo = (
    await ctx.db.query(
      `select contact_id, workflow_run_id from conversations where id = $1 and org_id = $2`,
      [conversationId, ctx.orgId],
    )
  ).rows[0];
  const contactId = convo?.contact_id;
  if (typeof contactId !== "string")
    throw new Error(
      `an approval is a task for the conversation's lead, and conversation ${conversationId} has none`,
    );
  const run = convo?.workflow_run_id;
  await createTask(ctx.db, ctx.orgId, {
    contactId,
    conversationId,
    workflowRunId: typeof run === "string" ? run : undefined,
    kind: "approval",
    title: `Approve: ${tool}`,
    payload: { tool, args },
    actor: { type: "agent" },
  });
}

export interface TurnDeps {
  provider: LlmProvider;
  registry: ToolRegistry;
  toolsAllowed: readonly string[]; // agents.tools_allowed — docs/security.md S8.1 capability boundary
  systemPrompt: string;
  pipeline?: PolicyHook[];
  providerName?: string;
}

/** One tool call the model asked for: validated, guarded, run (or turned into an approval) → what the transcript keeps. */
async function runTool(
  deps: TurnDeps,
  ctx: OrgCtx,
  conversationId: string,
  call: { name: string; args: unknown },
  round: number,
): Promise<Record<string, unknown>> {
  const tool = deps.registry.get(call.name, deps.toolsAllowed);
  if (!tool)
    return {
      name: call.name,
      result: { ok: false, error: "unknown_or_unallowed_tool" },
    };
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success)
    // the seatbelt against made-up arguments: invalid args never reach execute()
    return { name: call.name, result: { ok: false, error: "invalid_args" } };

  const channel = wireChannel(parsed.data);
  const action: GuardedAction = {
    kind: "tool",
    toolName: tool.name,
    autonomy: tool.autonomy,
    channel,
    contactId:
      strField(parsed.data, "contactId") ??
      (channel ? await conversationContactId(ctx, conversationId) : undefined),
  };
  const verdict = await guard(ctx, action, deps.pipeline);

  let result: ToolResult;
  if (verdict.ok) {
    // Thread the turn's conversationId so a tool write attributes to the run (book_appointment's
    // outcome → conversations.workflow_run_id). Additive: tools that ignore it are unaffected.
    result = await tool.execute(
      { ...ctx, conversationId },
      parsed.data as never,
    );
    await audit(ctx.db, ctx.orgId, {
      actorType: "agent",
      action: `tool.${tool.name}`,
      resourceType: "conversation",
      resourceId: conversationId,
      meta: { round, ok: result.ok },
    });
  } else if (verdict.reason === "approval_required") {
    await askForApproval(ctx, conversationId, tool.name, parsed.data);
    result = { ok: false, error: "approval_required" };
  } else {
    result = { ok: false, error: verdict.reason };
  }
  return { name: tool.name, args: parsed.data, result };
}

export async function runTurn(
  deps: TurnDeps,
  ctx: OrgCtx,
  conversationId: string,
): Promise<void> {
  const providerName = deps.providerName ?? "fake";

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const input = await assembleContext(ctx, conversationId, deps.systemPrompt);
    const turn = await deps.provider.complete({
      system: input.system,
      messages: input.messages,
      tools: deps.registry.specs(deps.toolsAllowed),
    });
    await emitUsage(ctx, {
      conversationId,
      kind: "llm",
      provider: providerName,
      quantity: turn.usage.in + turn.usage.out,
      unit: "tokens",
      meta: { in: turn.usage.in, out: turn.usage.out, round },
    });

    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      if (turn.text)
        await addMessage(ctx.db, ctx.orgId, conversationId, {
          role: "agent",
          content: turn.text,
        });
      return;
    }

    for (const call of turn.toolCalls)
      await addMessage(ctx.db, ctx.orgId, conversationId, {
        role: "tool",
        toolCall: await runTool(deps, ctx, conversationId, call, round),
      });
  }
}
