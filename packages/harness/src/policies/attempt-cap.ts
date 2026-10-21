// The attempt-cap check: no send once a lead has had the company's maximum of that channel's sends in its window.
// G1: runtime-agnostic.
import type { PolicyHook } from "../types";

/**
 * Attempt-cap guardrail: blocks a SEND once a contact has hit the per-channel cap within its
 * rolling window (guardrail_policies key 'attempt_caps', config {"<channel>":{max,per_hours}},
 * as each seed pack in supabase/seeds/ sets it). Attempts are per-channel
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
