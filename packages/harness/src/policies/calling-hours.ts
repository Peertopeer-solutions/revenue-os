// The calling-hours check: no send while the company's quiet window is open, in the lead's own time zone or the one
// the company set.
// G1: runtime-agnostic.
import { isWithinQuietHours } from "../quiet-hours";
import type { PolicyHook } from "../types";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_TZ = "Asia/Kolkata";

/**
 * Quiet-hours guardrail: blocks outbound SENDS during an org's configured quiet window
 * (guardrail_policies key 'quiet_hours', config {start,end,tz}). START inclusive, END
 * exclusive; tz 'contact' resolves per-contact (falling back to Asia/Kolkata), else a literal
 * IANA zone. Deliberately FAIL-OPEN: this is a courtesy gate, so a missing/malformed policy or
 * any DB hiccup returns null (pass) rather than blocking every send — a transient read error
 * must not silence all outbound traffic. (The DNC hook, do-not-call.ts, is hard-safety and fails
 * CLOSED; do not copy this posture there.)
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
