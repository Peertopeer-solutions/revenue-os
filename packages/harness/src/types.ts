// T26.1 — every shared type lives here, nowhere else.
// G1: runtime-agnostic.
import type { z } from "zod";

/** Structural view of packages/db's tx client — the ONLY door to data (T26.1). */
export interface OrgScopedDb {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

// Clock seam (T2): hooks that reason about time (quiet-hours, attempt-cap windows) read
// `ctx.now?.() ?? new Date()` so tests can inject a fixed instant. Optional — absent in prod
// (falls back to wall-clock), supplied by tests and any deterministic caller.
//
// conversationId (T9/M2): the turn's conversation, threaded in by runTurn so a tool's write can
// attribute to the run — book_appointment stamps outcomes.conversation_id, which traces to the run
// via conversations.workflow_run_id (moat #4, spec §9). Optional: absent outside a turn (unit tests,
// inline callers) where the tool writes a null link.
//
// onGuardEvent (task-56): the guard pipeline's observability sink, shaped like the clock seam —
// optional, so prod may ignore it. A hook that DECLINES to evaluate (quiet-hours fails open when
// tz:'contact' cannot be resolved) says so here instead of guessing silently.
export type OrgCtx = {
  orgId: string;
  db: OrgScopedDb;
  now?: () => Date;
  conversationId?: string;
  onGuardEvent?: (e: {
    hook: string;
    decision?: string;
    reason?: string;
  }) => void;
};

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export type Autonomy = "auto" | "approval" | "forbidden";

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>; // args validated BEFORE anything runs (T11 seatbelt)
  autonomy: Autonomy; // default; org guardrail_policies may tighten, never loosen
  execute(ctx: OrgCtx, args: I): Promise<ToolResult>;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown; // provider-facing JSON schema (adapter-specific rendering)
}

export interface Msg {
  role: "agent" | "contact" | "human_agent" | "system" | "tool";
  content: string;
}

export type LlmTurn = {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  usage: { in: number; out: number };
};

export interface LlmProvider {
  complete(req: {
    system: string;
    messages: Msg[];
    tools?: ToolSpec[];
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal; // aborted when the turn gives up waiting (src/time-limit.ts)
  }): Promise<LlmTurn>;
}

export type Verdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "dnc"
        | "quiet_hours"
        | "attempt_cap"
        | "approval_required"
        | "spend_cap"
        | "forbidden";
    };

/** A guardable action — the policy pipeline sees these, never raw tool internals. */
export interface GuardedAction {
  kind: "tool";
  toolName: string;
  autonomy: Autonomy;
  contactId?: string;
  channel?: "voice" | "whatsapp" | "sms" | "email";
}

/** A policy hook returns a failing Verdict to block, or null to pass to the next hook. */
export type PolicyHook = (
  ctx: OrgCtx,
  action: GuardedAction,
) => Promise<Verdict | null>;
