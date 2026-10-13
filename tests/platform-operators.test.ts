// Our operator list (supabase/migrations/018_platform_operators.sql): the people who may create a company. No one
// reads or writes platform_operators through the product: not the worker's own role (app_service), inside a company's
// transaction or outside one, and not a signed-in person through the database's data interface. The worker asks
// only app.is_platform_operator, which answers yes or no and which no other role may call. Fixtures are made as
// `postgres`, whom row-level security lets through; the code under test connects as app_service.
import { afterAll, describe, expect, it } from "bun:test";
import { createPool, withOrg } from "@revenue-os/db";
import { Pool } from "pg";
import { testCompanies } from "./test-companies";
import { testUser } from "./test-users";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
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

afterAll(async () => {
  await companies.cleanup();
  await appService.end();
  await admin.end();
});

describe("our operator list", () => {
  it("names only the people on it", async () => {
    const { isPlatformOperator } = await import("@revenue-os/db");
    const operator = await testUser(admin, "listed", { operator: true });
    const stranger = await testUser(admin, "unlisted");
    expect(await isPlatformOperator(appService, operator.userId)).toBe(true);
    expect(await isPlatformOperator(appService, stranger.userId)).toBe(false);
    expect(await isPlatformOperator(appService, crypto.randomUUID())).toBe(
      false,
    );
    expect(await isPlatformOperator(appService, "not-a-user-id")).toBe(false);
  });

  // behaviour already on main: migration 018 is applied to the one local database both copies of the code run against
  it("is closed to the worker's own role, inside a company's transaction and outside one", async () => {
    const { id } = await companies.add("Operator list reader");
    await expect(
      withOrg(appService, id, (tx) =>
        tx.query("select user_id from platform_operators"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withOrg(appService, id, (tx) =>
        tx.query("insert into platform_operators (user_id) values ($1)", [
          crypto.randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appService.query("delete from platform_operators"),
    ).rejects.toThrow(/permission denied/);
  });

  // behaviour already on main: migration 018 is applied to the one local database both copies of the code run against
  it("lets only the worker's role ask whether someone is on it", async () => {
    const someone = crypto.randomUUID();
    for (const role of ["anon", "authenticated", "service_role"]) {
      const db = await admin.connect();
      try {
        await db.query("begin");
        await db.query(`set local role ${role}`);
        await expect(
          db.query("select app.is_platform_operator($1)", [someone]),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await db.query("rollback");
        db.release();
      }
    }
  });

  it("is served to no signed-in person by the database's data interface, its own entry included", async () => {
    const operator = await testUser(admin, "data-api", { operator: true });
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_operators?select=user_id`,
      {
        headers: {
          apikey: ANON_KEY,
          authorization: `Bearer ${operator.token}`,
        },
      },
    );
    // The data interface's own refusal, the database's "permission denied" (42501): the gateway alone, with the data
    // interface not running, refuses too, which proves nothing about the table.
    const body = await res.json();
    expect([res.ok, body.code, body.message]).toEqual([
      false,
      "42501",
      "permission denied for table platform_operators",
    ]);
    expect(JSON.stringify(body)).not.toContain(operator.userId);
  });
});
