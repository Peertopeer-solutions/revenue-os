// The do-not-call check: no message or call to a lead whose consent says do-not-call, or whose consent can't be read.
// G1: runtime-agnostic.
import type { PolicyHook } from "../types";

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
