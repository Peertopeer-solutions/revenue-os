// The guard() pipeline: config-driven checks that run before ANY side effect (docs/security.md S8.2; AGENTS.md:
// guardrails run before every send, with no code path around them). Hooks are ordered; first failing verdict wins.
// It holds the autonomy, do-not-call, calling-hours and attempt-limit checks; the last three read only the company's
// own guardrail_policies rows, contacts and runs. A spending limit does not exist yet.
// G1: runtime-agnostic.
import { isWithinQuietHours } from "./quiet-hours";
import type { GuardedAction, OrgCtx, PolicyHook, Verdict } from "./types";

/** Autonomy tiers: forbidden blocks outright; approval routes to a human task (runTurn in loop.ts). */
export const autonomyHook: PolicyHook = async (_ctx, action) => {
  if (action.autonomy === "forbidden")
    return { ok: false, reason: "forbidden" };
  if (action.autonomy === "approval")
    return { ok: false, reason: "approval_required" };
  return null;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_TZ = "Asia/Kolkata";

/**
 * Quiet-hours guardrail: blocks outbound SENDS during an org's configured quiet window
 * (guardrail_policies key 'quiet_hours', config {start,end,tz}). START inclusive, END
 * exclusive; tz 'contact' resolves per-contact (falling back to Asia/Kolkata), else a literal
 * IANA zone. Deliberately FAIL-OPEN: this is a courtesy gate, so a missing/malformed policy or
 * any DB hiccup returns null (pass) rather than blocking every send — a transient read error
 * must not silence all outbound traffic. (The DNC hook below is hard-safety and fails CLOSED;
 * do not copy this posture there.)
 */
export const quietHoursHook: PolicyHook = async (ctx, action) => {
  // Gate SENDS only — a non-send tool carries no channel and is never quieted.
  if (!action.channel) return null;
  try {
    const policy = await ctx.db.query(
      "select config from guardrail_policies where key = $1 and org_id = $2 and active = true limit 1",
      ["quiet_hours", ctx.orgId],
    );
    const config = policy.rows[0]?.config as
      | Record<string, unknown>
      | undefined;
    if (!config) return null; // unconfigured = no restriction

    // Validate the window BEFORE any contact lookup — malformed config fails open.
    const start = config.start;
    const end = config.end;
    if (
      typeof start !== "string" ||
      typeof end !== "string" ||
      !HHMM.test(start) ||
      !HHMM.test(end)
    ) {
      return null;
    }

    const tzMode = config.tz;
    let zone: string;
    if (tzMode === "contact") {
      const c = action.contactId
        ? await ctx.db.query(
            "select timezone from contacts where id = $1 and org_id = $2 limit 1",
            [action.contactId, ctx.orgId],
          )
        : undefined;
      const row = c?.rows[0];
      if (!row) {
        // No identity (or a deleted id, or another company's) ⇒ no timezone. A courtesy gate may not
        // GUESS one: fail open, but never silently — the skip is the observable decision.
        ctx.onGuardEvent?.({
          hook: "quiet_hours",
          reason: "unresolved_contact_tz",
        });
        return null;
      }
      const contactTz = row.timezone;
      zone =
        typeof contactTz === "string" && contactTz ? contactTz : DEFAULT_TZ;
    } else if (typeof tzMode === "string" && tzMode) {
      zone = tzMode; // literal IANA zone — no contacts lookup
    } else {
      return null; // unknown tz mode → fail open
    }

    return isWithinQuietHours(ctx.now?.() ?? new Date(), start, end, zone)
      ? { ok: false, reason: "quiet_hours" }
      : null;
  } catch {
    // FAIL-OPEN: a transient DB error must not block every outbound send.
    return null;
  }
};

/**
 * DNC guardrail: blocks outbound SENDS to a contact whose consent flag is set
 * (contacts.consent->>'dnc', default `{"dnc": false, ...}` in migration 003_crm.sql). The action's
 * contactId is the "do-not-contact THIS person" signal. Hard-safety, so it FAILS CLOSED — any
 * read error blocks (never fall open to a send on uncertainty). A channel-less tool carries no
 * send, so it returns null BEFORE any DB read: a DB outage must not block the plain-tool path.
 * An UNRESOLVABLE identity (no contactId, or an id matching zero rows — deleted, hallucinated, or
 * another company's) is strictly less knowledge than a failed read, so it blocks too. You may not
 * send to someone whose consent you cannot look up.
 */
export const dncHook: PolicyHook = async (ctx, action) => {
  if (!action.channel) return null; // plain-tool path — never DNC-gated, never DB-read
  if (!action.contactId) return { ok: false, reason: "dnc" };
  try {
    const res = await ctx.db.query(
      "select consent from contacts where id = $1 and org_id = $2 limit 1",
      [action.contactId, ctx.orgId],
    );
    const row = res.rows[0];
    if (!row) return { ok: false, reason: "dnc" }; // unknown recipient ⇒ unknowable consent
    const consent = row.consent as Record<string, unknown> | undefined;
    return consent?.dnc === true ? { ok: false, reason: "dnc" } : null;
  } catch {
    // FAIL-CLOSED: block on uncertainty — a DNC read error must never fall open to a send.
    return { ok: false, reason: "dnc" };
  }
};

/**
 * Attempt-cap guardrail: blocks a SEND once a contact has hit the per-channel cap within its
 * rolling window (guardrail_policies key 'attempt_caps', config {"<channel>":{max,per_hours}},
 * as the seed packs real_estate.sql and b2b_wholesale.sql set it). Attempts are per-channel
 * ISO-timestamp ARRAYS on workflow_runs.attempts (migration 006_harness.sql), read from the
 * company's newest run of the contact through the runs_contact index (org_id, contact_id,
 * created_at desc). An unconfigured channel = no cap. FAILS CLOSED on a read error to
 * match its hard-safety class (grouped with DNC).
 */
export const attemptCapHook: PolicyHook = async (ctx, action) => {
  const { channel } = action;
  if (!channel) return null; // plain-tool path — no send to cap
  try {
    const policy = await ctx.db.query(
      "select config from guardrail_policies where key = $1 and org_id = $2 and active = true limit 1",
      ["attempt_caps", ctx.orgId],
    );
    const config = policy.rows[0]?.config as
      | Record<string, { max?: number; per_hours?: number }>
      | undefined;
    const cap = config?.[channel];
    if (
      !cap ||
      typeof cap.max !== "number" ||
      typeof cap.per_hours !== "number"
    ) {
      return null; // unconfigured channel = no cap
    }

    const run = await ctx.db.query(
      "select attempts from workflow_runs where contact_id = $1 and org_id = $2 order by created_at desc limit 1",
      [action.contactId, ctx.orgId],
    );
    const attempts = run.rows[0]?.attempts as
      | Record<string, string[]>
      | undefined;
    const stamps = attempts?.[channel] ?? [];

    const now = ctx.now?.() ?? new Date();
    const windowStart = now.getTime() - cap.per_hours * 3600 * 1000;
    const count = stamps.filter(
      (t) => new Date(t).getTime() >= windowStart,
    ).length;

    return count >= cap.max ? { ok: false, reason: "attempt_cap" } : null;
  } catch {
    // FAIL-CLOSED (judgment call — hard-safety class, no test pins the outage posture): block.
    return { ok: false, reason: "attempt_cap" };
  }
};

export const defaultPipeline: PolicyHook[] = [
  autonomyHook,
  dncHook,
  quietHoursHook,
  attemptCapHook,
];

export async function guard(
  ctx: OrgCtx,
  action: GuardedAction,
  pipeline: PolicyHook[] = defaultPipeline,
): Promise<Verdict> {
  for (const hook of pipeline) {
    const verdict = await hook(ctx, action);
    if (verdict && !verdict.ok) return verdict;
  }
  return { ok: true };
}
