// A lead's WhatsApp opt-in, in the one place every send's guard reads (contacts.consent -> 'whatsapp_optin'):
// recordWhatsAppOptIn and withdrawWhatsAppOptIn write it for the company's own lead, with where the lead gave it, and
// audit each change; what each answers is what the API and the CSV import act on. Recorded on the product's own login
// (app_service, through withOrg), as production does.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import {
  createPool,
  recordWhatsAppOptIn,
  withdrawWhatsAppOptIn,
  withOrg,
} from "../src";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const app = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);
const userId = randomUUID();
let orgA = "";
let orgB = "";

async function lead(org: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, 'Kavya') returning id`,
    [org],
  );
  return r.rows[0]?.id ?? "";
}

const optInOf = async (id: string) =>
  (
    await admin.query(
      `select consent -> 'whatsapp_optin' as o from contacts where id = $1`,
      [id],
    )
  ).rows[0]?.o;
const audits = async (org: string, id: string) =>
  (
    await admin.query(
      `select action, actor_type, actor_id, meta from audit_log
        where org_id = $1 and resource_type = 'contact' and resource_id = $2
          and action like 'contact.whatsapp_opt_%' order by created_at`,
      [org, id],
    )
  ).rows;
const optIn = (org: string, id: string, source = "site visit form") =>
  withOrg(app, org, (tx) =>
    recordWhatsAppOptIn(tx, org, id, { source, userId }),
  );
const optOut = (org: string, id: string) =>
  withOrg(app, org, (tx) =>
    withdrawWhatsAppOptIn(tx, org, id, { source: "lead replied STOP", userId }),
  );

beforeAll(async () => {
  orgA = (await companies.add("WhatsApp opt-in A")).id;
  orgB = (await companies.add("WhatsApp opt-in B")).id;
});

afterAll(async () => {
  await companies.cleanup();
  await app.end();
  await admin.end();
});

describe("recordWhatsAppOptIn and withdrawWhatsAppOptIn", () => {
  it("opt a lead in with its source, then answer 'already' and change nothing on a second opt-in", async () => {
    const id = await lead(orgA);
    expect(await optIn(orgA, id)).toBe("opted_in");
    expect(await optInOf(id)).toMatchObject({
      status: "opted_in",
      source: "site visit form",
    });
    expect(await optIn(orgA, id, "another form")).toBe("already");
    expect((await optInOf(id))?.source).toBe("site visit form");
    expect(await audits(orgA, id)).toEqual([
      {
        action: "contact.whatsapp_opt_in",
        actor_type: "user",
        actor_id: userId,
        meta: { source: "site visit form" },
      },
    ]);
  });

  it("withdraw an opt-in, answer 'already' when withdrawn before, and refuse a new opt-in with 'withdrawn'", async () => {
    const id = await lead(orgA);
    await optIn(orgA, id);
    expect(await optOut(orgA, id)).toBe("withdrawn");
    expect(await optOut(orgA, id)).toBe("already");
    expect(await optIn(orgA, id)).toBe("withdrawn");
    expect((await optInOf(id))?.status).toBe("withdrawn");
    expect((await audits(orgA, id)).map((a) => a.action)).toEqual([
      "contact.whatsapp_opt_in",
      "contact.whatsapp_opt_out",
    ]);
  });

  it("answer 'not_found' for another company's lead and leave it untouched", async () => {
    const theirs = await lead(orgB);
    expect(await optIn(orgA, theirs)).toBe("not_found");
    expect(await optOut(orgA, theirs)).toBe("not_found");
    expect(await optInOf(theirs)).toBeNull();
    expect(await audits(orgB, theirs)).toEqual([]);
  });

  it("audit an opt-in the product records itself as the system's, with no person", async () => {
    const id = await lead(orgA);
    await withOrg(app, orgA, (tx) =>
      recordWhatsAppOptIn(tx, orgA, id, { source: "demo enquiry form" }),
    );
    expect(await audits(orgA, id)).toEqual([
      {
        action: "contact.whatsapp_opt_in",
        actor_type: "system",
        actor_id: null,
        meta: { source: "demo enquiry form" },
      },
    ]);
  });
});
