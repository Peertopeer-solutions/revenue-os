// Prompt assembly (docs/tech-stack.md T26.6): the system prompt plus the tail of the company's own transcript, by seq.
// Contact memories join here as the labelled data block of docs/security.md S8.4 (retrieval.ts owns the frame and the
// ≤800-token budget). The knowledge base is still to come.
// An optional workflow context prepends a "why I'm calling" block (additive — the base system prompt is preserved,
// never replaced) so a turn a sequence drives knows its goal.
// G1: runtime-agnostic.
import { memoryBlock, retrieveMemories } from "./retrieval";
import type { Msg, OrgCtx } from "./types";
import type { WorkflowState } from "./workflow/schema";

const TRANSCRIPT_TAIL = 50;

/** The "why I'm calling" block, built from the run's current step + state (passed in,
 *  never queried). Additive — it goes ABOVE the base prompt; the base prompt stays verbatim. */
function whyBlock(workflow: {
  currentStep: string;
  state: WorkflowState;
}): string {
  const lines = [
    "# Why I'm reaching out",
    `You are running workflow step "${workflow.currentStep}". Stay on this goal.`,
  ];
  const vars = workflow.state.vars;
  if (vars && Object.keys(vars).length > 0) {
    lines.push(
      `Known context: ${Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}.`,
    );
  }
  if (workflow.state.lastDisposition) {
    lines.push(
      `Last outcome on this contact: ${workflow.state.lastDisposition}.`,
    );
  }
  return lines.join("\n");
}

/** A tool round rendered back INTO the prompt. messages.tool_call (jsonb) is the
 *  structured record; content on those rows is null, so without this the model sees an empty
 *  message and re-issues the same call every round (duplicate sends). Name + args + outcome is
 *  the minimum evidence "your call already ran" needs. */
function renderToolCall(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const { name, args, result } = payload as {
    name?: unknown;
    args?: unknown;
    result?: unknown;
  };
  const parts = [`tool ${typeof name === "string" ? name : "unknown"}`];
  if (args !== undefined) parts.push(`args ${JSON.stringify(args)}`);
  if (result !== undefined) parts.push(`result ${JSON.stringify(result)}`);
  return `[${parts.join(" · ")}]`;
}

/** The prompt-facing line for one transcript row: what was said, plus any tool payload. */
function renderRow(row: Record<string, unknown>): string {
  return [
    typeof row.content === "string" ? row.content : "",
    renderToolCall(row.tool_call),
  ]
    .filter((part) => part.trim() !== "")
    .join("\n");
}

export async function assembleContext(
  ctx: OrgCtx,
  conversationId: string,
  systemPrompt: string,
  workflow?: { currentStep: string; state: WorkflowState },
): Promise<{ system: string; messages: Msg[] }> {
  const r = await ctx.db.query(
    `select role, content, tool_call from (
		   select role, content, tool_call, seq from messages
		   where conversation_id = $1 and org_id = $3 order by seq desc limit $2
		 ) tail order by seq asc`,
    [conversationId, TRANSCRIPT_TAIL, ctx.orgId],
  );
  const prompt = workflow
    ? `${whyBlock(workflow)}\n\n${systemPrompt}`
    : systemPrompt;
  // Memory goes BELOW the prompt (the why-block → base join stays byte-exact) and only when
  // there is something to say: no memories must mean no frame at all.
  const block = memoryBlock(await retrieveMemories(ctx, conversationId));
  return {
    system: block ? `${prompt}\n\n${block}` : prompt,
    // Empty rows are DROPPED, never sent: a content-less block is a 400 at Anthropic, and rows
    // written before renderToolCall existed (tool rows with a null content and no payload) are exactly that.
    messages: r.rows
      .map((m) => ({ role: m.role as Msg["role"], content: renderRow(m) }))
      .filter((m) => m.content.trim() !== ""),
  };
}
