// The worker's database login cuts off long queries, lock waits and idle transactions (migration 023): every new
// connection as app_service, the login the worker and its job runner use (services/worker/src/db.ts), starts with the
// three limits set, so a stuck query, lock wait or forgotten transaction ends on its own instead of holding the
// worker's connections and rows.
import { afterAll, describe, expect, it } from "bun:test";
import { createPool, withOrg } from "@revenue-os/db";
import { Pool } from "pg";
import { testCompanies } from "./test-companies";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appService = createPool(DB_URL);
const companies = testCompanies(admin);

afterAll(async () => {
  await companies.cleanup();
  await appService.end();
  await admin.end();
});

describe("the worker's database login", () => {
  // behaviour already on main: migration 023 is applied to the one local database both copies of the code run against; it is the login's own settings that this checks
  it("starts every connection with limits on long queries, lock waits and idle transactions", async () => {
    const org = (await companies.add("Login Limits")).id;
    const row = await withOrg(appService, org, async (tx) => {
      const r = await tx.query(
        `select current_user as login,
                current_setting('statement_timeout') as statement_timeout,
                current_setting('lock_timeout') as lock_timeout,
                current_setting('idle_in_transaction_session_timeout') as idle_in_transaction_session_timeout`,
      );
      return r.rows[0];
    });
    expect(row).toEqual({
      login: "app_service",
      statement_timeout: "30s",
      lock_timeout: "10s",
      idle_in_transaction_session_timeout: "1min",
    });
  });

  // behaviour already on main: migration 023 is applied to the one local database both copies of the code run against; it is the login's own settings that this checks
  it("gives up waiting for a row another transaction holds, instead of waiting for ever", async () => {
    const org = (await companies.add("Login Lock Wait")).id;
    const contact = (
      await admin.query<{ id: string }>(
        `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
        [org],
      )
    ).rows[0]?.id;
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query(`select 1 from contacts where id = $1 for update`, [
        contact,
      ]);
      const started = Date.now();
      const wait = withOrg(appService, org, (tx) =>
        tx.query(
          `select 1 from contacts where id = $1 and org_id = $2 for update`,
          [contact, org],
        ),
      );
      await expect(wait).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  }, 30_000);
});
