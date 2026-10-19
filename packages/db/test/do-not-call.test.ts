// A lead's do-not-call block, in the one place every send's guard reads (contacts.consent ->> 'dnc'): recordDoNotCall
// adds it for the company's own lead and audits where it came from, and the database's own rule (app.keep_do_not_call,
// migration 020) refuses every change that would lift it, from any login, until Slice 2 builds the lead's written YES.
// The block is recorded on the product's own login (app_service, through withOrg), as production does.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { createPool, recordDoNotCall, withOrg } from "../src";

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
    `insert into contacts (org_id, first_name) values ($1, 'Meera') returning id`,
    [org],
  );
  return r.rows[0]?.id ?? "";
}

const consent = async (id: string) =>
  (await admin.query(`select consent from contacts where id = $1`, [id]))
    .rows[0]?.consent;
const audits = async (org: string, id: string) =>
  (
    await admin.query(
      `select actor_type, actor_id, meta from audit_log
        where org_id = $1 and action = 'contact.do_not_call' and resource_type = 'contact' and resource_id = $2`,
      [org, id],
    )
  ).rows;
const record = (org: string, id: string) =>
  withOrg(app, org, (tx) =>
    recordDoNotCall(tx, org, id, { from: "console", userId }),
  );

beforeAll(async () => {
  orgA = (await companies.add("Do-not-call A")).id;
  orgB = (await companies.add("Do-not-call B")).id;
});

afterAll(async () => {
  await companies.cleanup();
  await app.end();
  await admin.end();
});

describe("recordDoNotCall", () => {
  it("blocks the company's lead where the guard reads it and audits who recorded it, and from where", async () => {
    const id = await lead(orgA);
    expect(await record(orgA, id)).toBe("blocked");
    expect(await consent(id)).toEqual({
      dnc: true,
      whatsapp_optin: null,
      recording_consent: null,
    });
    expect(await audits(orgA, id)).toEqual([
      { actor_type: "user", actor_id: userId, meta: { from: "console" } },
    ]);
  });

  it("a call's block names the conversation it was heard on, as the AI's reading of that call", async () => {
    const id = await lead(orgA);
    const conversationId = randomUUID();
    const said = await withOrg(app, orgA, (tx) =>
      recordDoNotCall(tx, orgA, id, { from: "call", conversationId }),
    );
    expect(said).toBe("blocked");
    expect(await audits(orgA, id)).toEqual([
      {
        actor_type: "integration",
        actor_id: null,
        meta: { from: "call", conversation_id: conversationId },
      },
    ]);
  });

  it("recording it again keeps the block and adds no second audit row", async () => {
    const id = await lead(orgA);
    expect(await record(orgA, id)).toBe("blocked");
    expect(await record(orgA, id)).toBe("already");
    expect((await consent(id)).dnc).toBe(true);
    expect(await audits(orgA, id)).toHaveLength(1);
  });

  it("another company's lead is not found, stays open and gets no audit row", async () => {
    const theirs = await lead(orgB);
    expect(await record(orgA, theirs)).toBe("not_found");
    expect((await consent(theirs)).dnc).toBe(false);
    expect(await audits(orgA, theirs)).toEqual([]);
    expect(await audits(orgB, theirs)).toEqual([]);
  });

  it("a lead the company has none of is not found", async () => {
    expect(await record(orgA, randomUUID())).toBe("not_found");
  });
});

describe("app.keep_do_not_call: nothing lifts a block", () => {
  const lifts = [
    `update contacts set consent = consent || '{"dnc": false}' where id = $1`,
    `update contacts set consent = consent - 'dnc' where id = $1`,
    `update contacts set consent = '{}' where id = $1`,
    `update contacts set consent = jsonb_set(consent, '{dnc}', 'null') where id = $1`,
    `update contacts set consent = jsonb_set(consent, '{dnc}', '"false"') where id = $1`,
  ];

  for (const sql of lifts)
    it(`refuses, on the product's login and the database owner's: ${sql}`, async () => {
      const id = await lead(orgA);
      await record(orgA, id);
      await expect(
        withOrg(app, orgA, (tx) =>
          tx.query(`${sql} and org_id = $2`, [id, orgA]),
        ),
      ).rejects.toThrow("lead's own written YES");
      await expect(admin.query(sql, [id])).rejects.toThrow(
        "lead's own written YES",
      );
      expect((await consent(id)).dnc).toBe(true);
    });

  it("lets every other change through: a name, another consent field, and a lead with no block", async () => {
    const id = await lead(orgA);
    await record(orgA, id);
    await admin.query(
      `update contacts set first_name = 'Meera R', consent = consent || '{"recording_consent": true}' where id = $1`,
      [id],
    );
    expect((await consent(id)).dnc).toBe(true);
    const open = await lead(orgA);
    await admin.query(
      `update contacts set consent = consent || '{"dnc": false}' where id = $1`,
      [open],
    );
    expect((await consent(open)).dnc).toBe(false);
  });
});
