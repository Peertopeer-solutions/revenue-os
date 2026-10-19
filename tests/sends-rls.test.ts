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
  // behaviour already on main: migration 021 is applied to the one local database both copies of the code run against; it is the table's own row-level security and links that this checks
  it("withOrg(A) sees company A's send", async () => {
    const rows = await withOrg(appService, orgA, (tx) =>
      tx
        .query(`select id from sends where org_id = $1`, [orgA])
        .then((r) => r.rows),
    );
    expect(rows.map((r) => r.id)).toEqual([sendA]);
  });

  // behaviour already on main: migration 021 is applied to the one local database both copies of the code run against; it is the table's own row-level security and links that this checks
  it("withOrg(B) cannot read company A's send, even when asked for it by id", async () => {
    const rows = await withOrg(appService, orgB, (tx) =>
      tx
        .query(`select id from sends where id = $1`, [sendA])
        .then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
  });

  // behaviour already on main: migration 021 is applied to the one local database both copies of the code run against; it is the table's own row-level security and links that this checks
  it("withOrg(B) cannot change company A's send, nor move a send of its own into company A", async () => {
    // an update that reads no column: only the update policy stands between company B and every company's sends
    const changed = await withOrg(appService, orgB, (tx) =>
      tx.query(`update sends set status = 'unknown'`).then((r) => r.rowCount),
    );
    expect(changed).toBe(0); // company B holds no send yet
    // and one that names A's send by id
    const named = await withOrg(appService, orgB, (tx) =>
      tx
        .query(`update sends set status = 'unknown' where id = $1`, [sendA])
        .then((r) => r.rowCount),
    );
    expect(named).toBe(0);
    const still = await admin.query(
      `select status, provider_ref from sends where id = $1`,
      [sendA],
    );
    expect(still.rows[0]).toEqual({ status: "sent", provider_ref: "wamid.a" });
    // company B's own send can't be moved into company A
    const own =
      (
        await admin.query<{ id: string }>(
          `insert into sends (org_id, send_key, channel, contact_id) values ($1, $2, 'voice', $3) returning id`,
          [orgB, `place_call:${randomUUID()}`, leadB],
        )
      ).rows[0]?.id ?? "";
    await expect(
      withOrg(appService, orgB, (tx) =>
        tx.query(`update sends set org_id = $1 where id = $2`, [orgA, own]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // behaviour already on main: migration 021 is applied to the one local database both copies of the code run against; it is the table's own row-level security and links that this checks
  it("withOrg(B) cannot save a send into company A (row-level security), nor a send of its own about A's lead (the link)", async () => {
    await expect(
      withOrg(appService, orgB, (tx) =>
        tx.query(
          `insert into sends (org_id, send_key, channel, contact_id) values ($1, $2, 'voice', $3)`,
          [orgA, `place_call:${randomUUID()}`, leadA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
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
