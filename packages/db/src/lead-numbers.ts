// The one way to find the number a lead is reached on, read inside the caller's transaction: for a call, any phone or
// WhatsApp number they gave; for WhatsApp, only a WhatsApp number. Of those, their primary number first, then the
// oldest, then by id, so the same number always wins. A lead who was deleted, or merged into another lead, is reached
// on none: null, and the caller sends nothing (it hands the lead to a person instead).
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import type { Db } from "./client";

const KINDS = { voice: ["phone", "whatsapp"], whatsapp: ["whatsapp"] };

export async function leadNumber(
  db: Db,
  orgId: string,
  contactId: string,
  channel: keyof typeof KINDS,
): Promise<string | null> {
  const r = await db.query(
    `select ci.value from contact_identities ci
       join contacts c on c.org_id = $1 and c.id = ci.contact_id
      where ci.org_id = $1 and ci.contact_id = $2 and ci.kind = any($3::app.identity_kind[])
        and c.deleted_at is null and c.merged_into_id is null
      order by ci.is_primary desc, ci.created_at, ci.id
      limit 1`,
    [orgId, contactId, KINDS[channel]],
  );
  const value = r.rows[0]?.value;
  return typeof value === "string" && value !== "" ? value : null;
}
