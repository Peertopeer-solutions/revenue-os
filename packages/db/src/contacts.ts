// The company's contacts: CSV import, deduped through contact_identities' unique key (org_id, kind, value), so the
// schema is the guarantee and the code just routes around it; and the console's contact list.
// G1: runtime-agnostic.
import { normalizePhoneE164 } from "@revenue-os/shared";
import type pg from "pg";
import { audit } from "./audit";
import { withOrg } from "./client";
import { recordDoNotCall, recordWhatsAppOptIn } from "./consent";

const CORE_COLUMNS = new Set(["first_name", "last_name", "phone"]);
// The column a list marks a lead do-not-call in, by any of its usual names, read by its letters and digits alone
// (so "Do Not Call", "do-not-call", "DoNotCall" and "Do Not Call?" all match), a "(Y/N)" after it aside.
const DO_NOT_CALL_COLUMNS = new Set([
  "donotcall",
  "donotcontact",
  "donotdisturb",
  "dnc",
  "dnd",
]);
// What a do-not-call cell says to leave the lead open. Any other value blocks them, as do-not-call blocks when in
// doubt (docs/decisions-in-force/2026-10-01-guard-postures.md).
const OPEN = new Set(["", "no", "n", "false", "0"]);
// The columns a list records a WhatsApp opt-in in, and where the lead gave it, read the same way. Only a clear yes opts
// a lead in; anything else records nothing, as no opt-in means no WhatsApp message.
const OPT_IN_COLUMNS = new Set(["whatsappoptin", "waoptin", "whatsappconsent"]);
const OPT_IN_SOURCE_COLUMNS = new Set(["whatsappoptinsource", "optinsource"]);
const YES = new Set(["yes", "y", "true", "1"]);

export interface ImportSummary {
  created: number;
  merged: number;
  invalid: number;
}

const letters = (column: string) =>
  column
    .toLowerCase()
    .replace(/\(y\/n\)/g, "")
    .replace(/[^a-z0-9]/g, "");
const doNotCallColumn = (column: string) =>
  DO_NOT_CALL_COLUMNS.has(letters(column));
const consentColumn = (column: string) =>
  doNotCallColumn(column) ||
  OPT_IN_COLUMNS.has(letters(column)) ||
  OPT_IN_SOURCE_COLUMNS.has(letters(column));

/** Whether the row's list marks its lead do-not-call. */
const saysDoNotCall = (row: Record<string, string>) =>
  Object.entries(row).some(
    ([k, v]) => doNotCallColumn(k) && !OPEN.has(v.trim().toLowerCase()),
  );

/** Where the row's lead gave their WhatsApp opt-in, when its list says they did: its source column, else the list. */
function optInSource(row: Record<string, string>): string | null {
  const cell = (names: Set<string>) =>
    Object.entries(row)
      .find(([k]) => names.has(letters(k)))?.[1]
      ?.trim();
  if (!YES.has(cell(OPT_IN_COLUMNS)?.toLowerCase() ?? "")) return null;
  return cell(OPT_IN_SOURCE_COLUMNS)?.slice(0, 200) || "imported list";
}

/** The row's other filled-in columns, kept as the lead's details. */
const details = (row: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([k, v]) => !CORE_COLUMNS.has(k) && !consentColumn(k) && v !== "",
    ),
  );

/** Files one row under its phone number: a new lead, or the company's lead with that number, enriched. */
async function importRow(
  tx: pg.PoolClient,
  orgId: string,
  phone: string,
  row: Record<string, string>,
): Promise<{ contactId: string; created: boolean }> {
  const existing = await tx.query(
    `select contact_id from contact_identities
				 where org_id = $1 and kind = 'phone' and value = $2`,
    [orgId, phone],
  );

  if (existing.rows.length > 0) {
    // merge: enrich attributes + fill missing names on the EXISTING contact — never a new row
    await tx.query(
      `update contacts set
					   attributes = attributes || $2::jsonb,
					   first_name = coalesce(first_name, nullif($3, '')),
					   last_name  = coalesce(last_name,  nullif($4, '')),
					   updated_at = now()
					 where id = $1 and org_id = $5`,
      [
        existing.rows[0].contact_id,
        JSON.stringify(details(row)),
        row.first_name ?? "",
        row.last_name ?? "",
        orgId,
      ],
    );
    return { contactId: existing.rows[0].contact_id, created: false };
  }
  const contact = await tx.query(
    `insert into contacts (org_id, first_name, last_name, source, attributes)
					 values ($1, nullif($2, ''), nullif($3, ''), 'csv_import', $4) returning id`,
    [
      orgId,
      row.first_name ?? "",
      row.last_name ?? "",
      JSON.stringify(details(row)),
    ],
  );
  await tx.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
					 values ($1, $2, 'phone', $3, true)`,
    [orgId, contact.rows[0].id, phone],
  );
  return { contactId: contact.rows[0].id, created: true };
}

export async function importContacts(
  pool: pg.Pool,
  orgId: string,
  rows: Record<string, string>[],
  actorUserId: string,
): Promise<ImportSummary> {
  return withOrg(pool, orgId, async (tx) => {
    const summary: ImportSummary = { created: 0, merged: 0, invalid: 0 };

    for (const row of rows) {
      const phone = normalizePhoneE164(row.phone ?? "");
      if (!phone) {
        summary.invalid++;
        continue;
      }
      const { contactId, created } = await importRow(tx, orgId, phone, row);
      summary[created ? "created" : "merged"]++;
      if (saysDoNotCall(row))
        await recordDoNotCall(tx, orgId, contactId, {
          from: "import",
          userId: actorUserId,
        });
      const source = optInSource(row);
      if (source)
        // a lead who withdrew stays withdrawn: only their own written YES re-opts them
        await recordWhatsAppOptIn(tx, orgId, contactId, {
          source,
          userId: actorUserId,
        });
    }

    await audit(tx, orgId, {
      actorType: "user",
      actorId: actorUserId,
      action: "contacts.import",
      resourceType: "contacts",
      meta: { ...summary, rows: rows.length },
    });
    return summary;
  });
}

/** The company's leads with this E.164 number, as their phone or their WhatsApp number. */
export async function leadsWithNumber(
  tx: pg.PoolClient,
  orgId: string,
  number: string,
): Promise<string[]> {
  const r = await tx.query<{ contact_id: string }>(
    `select distinct contact_id from contact_identities
      where org_id = $1 and kind in ('phone', 'whatsapp') and value = $2`,
    [orgId, number],
  );
  return r.rows.map((row) => row.contact_id);
}

export interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  lifecycle_stage: string;
  score: number | null;
  last_interaction_at: string | null;
  created_at: string;
  latest_conversation_id: string | null;
  do_not_call: boolean;
}

/**
 * The company's leads for the console's list: the 100 with the latest interaction or, given `search`, those whose name
 * holds it or whose phone or WhatsApp number holds its digits (four or more), so a person can find any lead.
 */
export async function listContacts(
  pool: pg.Pool,
  orgId: string,
  search = "",
): Promise<ContactRow[]> {
  const words = search.trim();
  const digits = search.replace(/\D/g, "");
  return withOrg(pool, orgId, async (tx) => {
    // latest_conversation_id, which the contacts screen links to the transcript: the contact's newest conversation,
    // from a lateral sub-select. Both the contacts and the sub-select's conversations filter by company themselves,
    // on top of the database's per-company rules (docs/patterns/drizzle-query.md). Ordering is deterministic:
    // started_at desc, then the NOT-NULL created_at as a stable tiebreak so two conversations that share a started_at
    // (or both null — queued/ringing) never pick arbitrarily. Left join → null when none exist.
    const result = await tx.query(
      `select c.id, c.first_name, c.last_name, c.lifecycle_stage, c.score::float8 as score,
              c.last_interaction_at::text as last_interaction_at,
              c.created_at::text as created_at,
              latest.id as latest_conversation_id,
              coalesce(c.consent -> 'dnc' = 'true'::jsonb, false) as do_not_call
         from contacts c
         left join lateral (
                     select conv.id
                       from conversations conv
                      where conv.org_id = $1 and conv.contact_id = c.id
                      order by conv.started_at desc nulls last, conv.created_at desc
                      limit 1
                   ) latest on true
        where c.org_id = $1 and c.deleted_at is null and c.merged_into_id is null
          and ($2 = '' or concat_ws(' ', c.first_name, c.last_name) ilike '%' || $2 || '%'
               or ($3 <> '' and exists (
                     select 1 from contact_identities i
                      where i.org_id = $1 and i.contact_id = c.id and i.kind in ('phone', 'whatsapp')
                        and i.value like '%' || $3 || '%')))
        order by c.last_interaction_at desc nulls last, c.created_at desc
        limit 100`,
      [
        orgId,
        words.replace(/[\\%_]/g, "\\$&"),
        digits.length >= 4 ? digits : "",
      ],
    );
    return result.rows;
  });
}
