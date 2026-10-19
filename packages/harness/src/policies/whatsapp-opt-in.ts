// The WhatsApp opt-in check: no WhatsApp message to a lead whose opt-in is missing, withdrawn, malformed or can't be
// read. The opt-in lives in contacts.consent -> 'whatsapp_optin': null until recorded, then
// {status: "opted_in" | "withdrawn", source, at} (recordWhatsAppOptIn and withdrawWhatsAppOptIn, packages/db/src/consent.ts).
// Like do-not-call it is hard safety, so it blocks when in doubt (docs/decisions-in-force/2026-10-01-guard-postures.md).
// G1: runtime-agnostic.
import type { PolicyHook } from "../types";

const NO_OPT_IN = { ok: false, reason: "no_whatsapp_optin" } as const;

/** Lets a WhatsApp send through only to a lead of the company whose recorded opt-in says opted_in and names its source. */
export const whatsappOptInHook: PolicyHook = async (ctx, action) => {
  if (action.channel !== "whatsapp") return null; // calls and plain tools are not WhatsApp messages
  if (!action.contactId) return NO_OPT_IN;
  try {
    const res = await ctx.db.query(
      "select consent from contacts where id = $1 and org_id = $2 limit 1",
      [action.contactId, ctx.orgId],
    );
    const consent = res.rows[0]?.consent as
      | { whatsapp_optin?: { status?: unknown; source?: unknown } | null }
      | undefined;
    const optIn = consent?.whatsapp_optin;
    return optIn?.status === "opted_in" &&
      typeof optIn.source === "string" &&
      optIn.source !== ""
      ? null
      : NO_OPT_IN;
  } catch {
    return NO_OPT_IN; // an unreadable opt-in is no opt-in
  }
};
