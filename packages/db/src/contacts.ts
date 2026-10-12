// The company's contacts: CSV import, deduped through contact_identities' unique key (org_id, kind, value), so the
// schema is the guarantee and the code just routes around it; and the console's contact list.
// G1: runtime-agnostic.
import { normalizePhoneE164 } from "@revenue-os/shared";
import type pg from "pg";
import { audit } from "./audit";
import { withOrg } from "./client";

const CORE_COLUMNS = new Set(["first_name", "last_name", "phone"]);

export interface ImportSummary {
  created: number;
  merged: number;
  invalid: number;
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
      const attributes: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!CORE_COLUMNS.has(k) && v !== "") attributes[k] = v;
      }

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
            JSON.stringify(attributes),
            row.first_name ?? "",
            row.last_name ?? "",
            orgId,
          ],
        );
        summary.merged++;
      } else {
        const contact = await tx.query(
          `insert into contacts (org_id, first_name, last_name, source, attributes)
					 values ($1, nullif($2, ''), nullif($3, ''), 'csv_import', $4) returning id`,
          [
            orgId,
            row.first_name ?? "",
            row.last_name ?? "",
            JSON.stringify(attributes),
          ],
        );
        await tx.query(
          `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
					 values ($1, $2, 'phone', $3, true)`,
          [orgId, contact.rows[0].id, phone],
        );
        summary.created++;
      }
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

export interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  lifecycle_stage: string;
  score: number | null;
  last_interaction_at: string | null;
  created_at: string;
  latest_conversation_id: string | null;
}

export async function listContacts(
  pool: pg.Pool,
  orgId: string,
): Promise<ContactRow[]> {
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
              latest.id as latest_conversation_id
         from contacts c
         left join lateral (
                     select conv.id
                       from conversations conv
                      where conv.org_id = $1 and conv.contact_id = c.id
                      order by conv.started_at desc nulls last, conv.created_at desc
                      limit 1
                   ) latest on true
        where c.org_id = $1 and c.deleted_at is null and c.merged_into_id is null
        order by c.last_interaction_at desc nulls last, c.created_at desc
        limit 100`,
      [orgId],
    );
    return result.rows;
  });
}
