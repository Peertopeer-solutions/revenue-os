// A lead's consent. A do-not-call block lives in the one place the guard before every send reads it,
// contacts.consent -> 'dnc' (dncHook, packages/harness/src/policies.ts), and recordDoNotCall is the one way every
// part of the product records it: a call's AI reading, a person in the console, an imported list. It only ever adds
// a block; migration 020 refuses any change that lifts one, which only the lead's own written YES may do (Slice 2).
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
