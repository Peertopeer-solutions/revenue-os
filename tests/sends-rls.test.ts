// sends carries org_id and is walled off between companies (AGENTS.md hard rail 3, tenancy): migration 021's
// row-level security on the worker's record of each call and WhatsApp message (services/worker/src/sends.ts).
// Fixtures are made as `postgres` (row-level security doesn't apply to it); the login under test is app_service,
// the worker's own, through withOrg.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool, withOrg } from "@revenue-os/db";
import { Pool } from "pg";
import { testCompanies } from "./test-companies";

const admin = new Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appService = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
let [orgA, orgB, leadA, leadB, sendA] = ["", "", "", "", ""];

const lead = async (org: string) =>
  (
    await admin.query<{ id: string }>(
      `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
      [org],
    )
  ).rows[0]?.id ?? "";

beforeAll(async () => {
  orgA = (await companies.add("Sends A")).id;
  orgB = (await companies.add("Sends B")).id;
  [leadA, leadB] = [await lead(orgA), await lead(orgB)];
  sendA =
    (
      await admin.query<{ id: string }>(
        `insert into sends (org_id, send_key, channel, contact_id, status, provider_ref)
         values ($1, $2, 'whatsapp', $3, 'sent', 'wamid.a') returning id`,
        [orgA, `send_wa:${randomUUID()}`, leadA],
      )
    ).rows[0]?.id ?? "";
});

afterAll(async () => {
  await companies.cleanup();
  await appService.end();
  await admin.end();
});

describe("sends tenant isolation", () => {
  it("withOrg(A) sees company A's send", async () => {
    const rows = await withOrg(appService, orgA, (tx) =>
      tx
        .query(`select id from sends where org_id = $1`, [orgA])
        .then((r) => r.rows),
    );
    expect(rows.map((r) => r.id)).toEqual([sendA]);
  });

  it("withOrg(B) cannot read company A's send, even when asked for it by id", async () => {
    const rows = await withOrg(appService, orgB, (tx) =>
      tx
        .query(`select id from sends where id = $1`, [sendA])
        .then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  it("withOrg(B) cannot mark company A's send as unknown, nor sent", async () => {
    const changed = await withOrg(appService, orgB, (tx) =>
      tx
        .query(
          `update sends set status = 'unknown' where id = $1 and org_id = $2`,
          [sendA, orgA],
        )
        .then((r) => r.rowCount),
    );
    expect(changed).toBe(0);
    const still = await admin.query(`select status from sends where id = $1`, [
      sendA,
    ]);
    expect(still.rows[0].status).toBe("sent");
  });

  it("withOrg(B) cannot save a send into company A (row-level security), nor a send of its own about A's lead (the link)", async () => {
    expect(
      withOrg(appService, orgB, (tx) =>
        tx.query(
          `insert into sends (org_id, send_key, channel, contact_id) values ($1, $2, 'voice', $3)`,
          [orgA, `place_call:${randomUUID()}`, leadA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      withOrg(appService, orgB, (tx) =>
        tx.query(
          `insert into sends (org_id, send_key, channel, contact_id) values ($1, $2, 'voice', $3)`,
          [orgB, `place_call:${randomUUID()}`, leadA],
        ),
      ),
    ).rejects.toThrow(/sends_contact_id_fkey/);
    // company B's own lead it may save a send for
    await withOrg(appService, orgB, (tx) =>
      tx.query(
        `insert into sends (org_id, send_key, channel, contact_id) values ($1, $2, 'voice', $3)`,
        [orgB, `place_call:${randomUUID()}`, leadB],
      ),
    );
  });
});
