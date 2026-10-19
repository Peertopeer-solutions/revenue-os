// A lead's consent. A do-not-call block lives in the one place the guard before every send reads it,
// contacts.consent -> 'dnc' (dncHook, packages/harness/src/policies/do-not-call.ts), and recordDoNotCall is the one way
// every part of the product records it: a call's AI reading, a person in the console, an imported list. It only ever
// adds a block; migration 020 refuses any change that lifts one, which only the lead's own written YES may do (Slice 2).
// A WhatsApp opt-in lives beside it, contacts.consent -> 'whatsapp_optin' (whatsappOptInHook,
// packages/harness/src/policies/whatsapp-opt-in.ts): null until recorded, then {status: "opted_in" | "withdrawn",
// source, at}. recordWhatsAppOptIn and withdrawWhatsAppOptIn are the one way to write it, and a withdrawal is final
// here: only the lead's own written YES re-opts them (Slice 2), never a list or a person.
// G1: runtime-agnostic.
import type pg from "pg";
import { audit } from "./audit";

/** Where a do-not-call request came from: the call it was heard on, or the person who recorded it. */
type DoNotCallSource =
  | { from: "call"; conversationId: string }
  | { from: "console" | "import"; userId: string };

/**
 * Blocks the company's lead from every later message and call, in the transaction `tx` (withOrg's), and audits who
 * recorded it and from where. "already" when the lead was blocked before (nothing changes, nothing is audited);
 * "not_found" when the company has no such lead.
 */
export async function recordDoNotCall(
  tx: pg.PoolClient,
  orgId: string,
  contactId: string,
  source: DoNotCallSource,
): Promise<"blocked" | "already" | "not_found"> {
  const lead = await tx.query<{ blocked: boolean }>(
    `select coalesce(consent -> 'dnc' = 'true'::jsonb, false) as blocked
       from contacts where id = $1 and org_id = $2 for update`,
    [contactId, orgId],
  );
  const row = lead.rows[0];
  if (!row) return "not_found";
  if (row.blocked) return "already";
  await tx.query(
    `update contacts set consent = consent || '{"dnc": true}', updated_at = now() where id = $1 and org_id = $2`,
    [contactId, orgId],
  );
  const call = source.from === "call";
  await audit(tx, orgId, {
    actorType: call ? "integration" : "user",
    actorId: call ? undefined : source.userId,
    action: "contact.do_not_call",
    resourceType: "contact",
    resourceId: contactId,
    meta: call
      ? { from: "call", conversation_id: source.conversationId }
      : { from: source.from },
  });
  return "blocked";
}

type OptInStatus = "opted_in" | "withdrawn";

/**
 * Where the lead gave (or withdrew) their WhatsApp opt-in (an event, a form, a list), and the person who recorded it;
 * none when the product itself did, as the demo's scripted enquiry form does.
 */
export interface OptInSource {
  source: string;
  userId?: string;
}

/** Sets the lead's WhatsApp opt-in to `to`, unless it already says so or was withdrawn; audits a change. */
async function setWhatsAppOptIn(
  tx: pg.PoolClient,
  orgId: string,
  contactId: string,
  to: OptInStatus,
  by: OptInSource,
): Promise<OptInStatus | "already" | "not_found"> {
  const lead = await tx.query<{ status: string | null }>(
    `select consent -> 'whatsapp_optin' ->> 'status' as status
       from contacts where id = $1 and org_id = $2 for update`,
    [contactId, orgId],
  );
  const row = lead.rows[0];
  if (!row) return "not_found";
  if (row.status === to) return "already";
  if (row.status === "withdrawn") return "withdrawn";
  await tx.query(
    `update contacts set consent = consent || jsonb_build_object('whatsapp_optin',
       jsonb_build_object('status', $3::text, 'source', $4::text, 'at', now())), updated_at = now()
      where id = $1 and org_id = $2`,
    [contactId, orgId, to, by.source],
  );
  await audit(tx, orgId, {
    actorType: by.userId ? "user" : "system",
    actorId: by.userId,
    action:
      to === "opted_in"
        ? "contact.whatsapp_opt_in"
        : "contact.whatsapp_opt_out",
    resourceType: "contact",
    resourceId: contactId,
    meta: { source: by.source },
  });
  return to;
}

/**
 * Records that the company's lead agreed to WhatsApp messages, and where, in `tx` (withOrg's). "already" when they had
 * (nothing changes, nothing is audited); "withdrawn" when they withdrew it, which this refuses; "not_found" when the
 * company has no such lead.
 */
export const recordWhatsAppOptIn = (
  tx: pg.PoolClient,
  orgId: string,
  contactId: string,
  by: OptInSource,
) => setWhatsAppOptIn(tx, orgId, contactId, "opted_in", by);

/** Records that the lead withdrew (or never gave) their WhatsApp opt-in; "already" when it was withdrawn before. */
export const withdrawWhatsAppOptIn = (
  tx: pg.PoolClient,
  orgId: string,
  contactId: string,
  by: OptInSource,
) => setWhatsAppOptIn(tx, orgId, contactId, "withdrawn", by);
