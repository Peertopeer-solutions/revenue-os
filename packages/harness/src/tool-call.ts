// One tool call the AI model asked for in a turn: validate its arguments with zod, run guard(), then run the tool and
// write its audit row, or, when approval is required, make a task for a person (never a silent drop). It runs in the
// turn's save step (src/loop.ts), and says what to record as the tool's message. The audit row and an approval's task
// are written by the database package's one writers (audit, createTask), in that step's transaction.
// G1: runtime-agnostic.

import { audit, createTask } from "@revenue-os/db";
import type { RoleRules } from "@revenue-os/shared";
import { guard } from "./policies";
import type { ToolRegistry } from "./registry";
import type {
  Autonomy,
  GuardedAction,
  OrgCtx,
  PolicyHook,
  ToolResult,
} from "./types";

// A role's approval rule only tightens a tool's own level: it may ask for a person's approval or forbid the tool,
// never let it act alone (RoleRulesSchema, packages/shared/src/role.ts).
const STRICTNESS: readonly Autonomy[] = ["auto", "approval", "forbidden"];
const tighter = (own: Autonomy, role?: Autonomy): Autonomy =>
  role && STRICTNESS.indexOf(role) > STRICTNESS.indexOf(own) ? role : own;

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

/** What a tool call leaves in the conversation: the tool, its arguments once valid, and what came of it. */
export type ToolCallRecord = {
  name: string;
  args?: unknown;
  result: ToolResult;
};

export async function runToolCall(
  deps: {
    registry: ToolRegistry;
    toolsAllowed: readonly string[];
    rules?: RoleRules;
    pipeline?: PolicyHook[];
  },
  ctx: OrgCtx,
  conversationId: string,
  round: number,
  call: { name: string; args: unknown },
): Promise<ToolCallRecord> {
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
    autonomy: tighter(tool.autonomy, deps.rules?.approval[tool.name]),
    channel,
    contactId:
      strField(parsed.data, "contactId") ??
      (channel ? await conversationContactId(ctx, conversationId) : undefined),
  };
  const verdict = await guard(ctx, action, deps.pipeline);

  let result: ToolResult;
  if (verdict.ok) {
    // Thread the turn's conversationId so a tool write attributes to the run (book_appointment's
    // outcome → conversations.workflow_run_id), and the role's rules, which a tool reads what the role allows from.
    result = await tool.execute(
      { ...ctx, conversationId, rules: deps.rules },
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
