// The merge-update inside importContacts merges a re-imported phone number into the company's own contact.
// A company's identity row can't point at another company's contact (migration 019; tests/company-links.test.ts),
// so a merge never reaches another company through one. Fixtures as `postgres` (RLS-exempt); code under test runs
// as `app_service` via withOrg.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { createPool, importContacts } from "../src";

const LOCAL_DB_URL =
  process.env.LOCAL_DB_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const APP_SERVICE_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";

const admin = new Pool({ connectionString: LOCAL_DB_URL, max: 2 });
const companies = testCompanies(admin);
let appService: Pool;
let orgC = "";
const HAPPY_PHONE = "+15550120002";
const ACTOR = "00000000-0000-0000-0000-000000000012";

beforeAll(async () => {
  orgC = (await companies.add("Merge Scope Org C")).id;
  appService = createPool(APP_SERVICE_URL);
});

afterAll(async () => {
  await companies.cleanup();
  await appService?.end();
  await admin.end();
});

describe("importContacts merge-update org scoping", () => {
  it("still merges within the org (happy path intact)", async () => {
    const first = await importContacts(
      appService,
      orgC,
      [{ first_name: "Carla", phone: HAPPY_PHONE }],
      ACTOR,
    );
    expect(first.created).toBe(1);

    const second = await importContacts(
      appService,
      orgC,
      [
        {
          first_name: "",
          last_name: "Chandra",
          phone: HAPPY_PHONE,
          city: "Pune",
        },
      ],
      ACTOR,
    );
    expect(second.merged).toBe(1);
    expect(second.created).toBe(0);

    const row = await admin.query(
      `select c.first_name, c.last_name, c.attributes from contacts c
			 join contact_identities ci on ci.contact_id = c.id
			 where ci.org_id = $1 and ci.value = $2`,
      [orgC, HAPPY_PHONE],
    );
    expect(row.rows[0].first_name).toBe("Carla"); // coalesce keeps existing
    expect(row.rows[0].last_name).toBe("Chandra"); // fills missing
    expect(row.rows[0].attributes).toEqual({ city: "Pune" });
  });
});
