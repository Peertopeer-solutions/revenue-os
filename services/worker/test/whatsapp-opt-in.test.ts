// No WhatsApp message to a lead without a recorded opt-in. A lead's opt-in, and where they gave it, is recorded by a
// person through the worker's API or by an imported list's opt-in column; a person records a withdrawal through the
// API. Then the lead's next WhatsApp message goes through the real send_wa handler with the real guard, on the
// product's own database login, and only the provider is faked: a lead with no opt-in, or a withdrawn one, gets
// nothing, and a lead who opted in gets the message. On the local stack (`bun run gate`, CI).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import { guard } from "@revenue-os/harness";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { type TestUser, testUser } from "../../../tests/test-users";
import { handleSendWa } from "../src/handlers/send-wa";
import app from "../src/index";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const appPool = createPool(
  process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
);
const companies = testCompanies(admin);

let owner: TestUser; // the company's admin
let operator: TestUser;
let viewer: TestUser;
let stranger: TestUser; // admin of another company
let orgId = "";
let orgB = "";

function api(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
  );
}

async function createOrg(user: TestUser, label: string): Promise<string> {
  const { id } = await companies.add(label, async (name, slug) => {
    const res = await api("/orgs", user.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug, vertical: "real_estate" }),
    });
    return ((await res.json()) as { id: string }).id;
  });
  return id;
}

async function invite(userId: string, role: string) {
  const res = await api(`/orgs/${orgId}/members`, owner.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status}`);
}

let phoneSeq = 0;
/** A fresh Indian mobile number (a number is unique only within its company, and each run makes its own). */
function phone(): string {
  phoneSeq += 1;
  return `+919811${String(phoneSeq).padStart(6, "0")}`;
}

/** A lead of `org` with a phone and a WhatsApp number, and no opt-in recorded. */
async function newLead(org = orgId, number = phone()): Promise<string> {
  const c = await admin.query<{ id: string }>(
    `insert into contacts (org_id, first_name) values ($1, 'Kavya') returning id`,
    [org],
  );
  const id = c.rows[0]?.id ?? "";
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'phone', $3, true), ($1, $2, 'whatsapp', $3, false)`,
    [org, id, number],
  );
  return id;
}

const optInOf = async (contactId: string) =>
  (
    await admin.query(
      `select consent -> 'whatsapp_optin' as opt_in from contacts where id = $1`,
      [contactId],
    )
  ).rows[0]?.opt_in ?? null;

/**
 * The company's lead a list filed under this phone number, given the same number as their WhatsApp number (an import
 * records phone numbers only), so a refused message is the opt-in's doing, never a missing number.
 */
async function leadByPhone(number: string): Promise<string> {
  const lead =
    (
      await admin.query<{ contact_id: string }>(
        `select contact_id from contact_identities where org_id = $1 and kind = 'phone' and value = $2`,
        [orgId, number],
      )
    ).rows[0]?.contact_id ?? "";
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', $3, false) on conflict do nothing`,
    [orgId, lead, number],
  );
  return lead;
}

/** The lead's opt-in and opt-out audit rows, in any company. */
const audits = async (contactId: string) =>
  (
    await admin.query(
      `select action, actor_id, meta from audit_log
        where action like 'contact.whatsapp_opt_%' and resource_id = $1 order by created_at`,
      [contactId],
    )
  ).rows;

// Written as JSON text: its step's `then` is the sequence's own field, which as an object key lint takes for a promise's.
const WA_WF: unknown = JSON.parse(
  '{"entry": "w", "steps": {"w": {"kind": "whatsapp", "template": "hello", "then": "end"}, "end": {"kind": "end"}}}',
);

/**
 * The lead's next WhatsApp message, in a sequence of its own, as the worker's send_wa job makes it: how many reached
 * the (fake) provider, and the conversations the send left.
 */
async function nextMessage(contactId: string) {
  let whatsapp = 0;
  const wf = await admin.query<{ id: string }>(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [orgId, `optin-${randomUUID()}`, JSON.stringify(WA_WF)],
  );
  const run = await admin.query<{ id: string }>(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state, wake_at)
     values ($1, $2, $3, 'waiting', 'w', $4::jsonb, now()) returning id`,
    [orgId, wf.rows[0]?.id, contactId, JSON.stringify({ contactId })],
  );
  const runId = run.rows[0]?.id ?? "";
  await handleSendWa(
    {
      pool: appPool,
      guard,
      sender: {
        send: async () => {
          whatsapp += 1;
          return { providerRef: `wamid-${randomUUID()}` };
        },
      },
    },
    {
      orgId,
      runId,
      step: "w",
      idx: 0,
      action: { kind: "send_wa", contactId, template: "hello", vars: {} },
    },
  );
  const left = await admin.query(
    `select count(*)::int n from conversations where org_id = $1 and workflow_run_id = $2`,
    [orgId, runId],
  );
  return { whatsapp, conversations: left.rows[0]?.n };
}

const REFUSED = { whatsapp: 0, conversations: 0 };
const SENT = { whatsapp: 1, conversations: 1 };

const optIn = (
  contactId: string,
  token: string | null,
  body: unknown = { source: "Godrej Woods site visit form" },
  org = orgId,
) =>
  api(`/orgs/${org}/contacts/${contactId}/whatsapp-opt-in`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const optOut = (
  contactId: string,
  token: string | null,
  body: unknown = { source: "lead replied STOP" },
) =>
  api(`/orgs/${orgId}/contacts/${contactId}/whatsapp-opt-out`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const importCsv = (csv: string) =>
  api(`/orgs/${orgId}/contacts/import`, operator.token, {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: csv,
  });

beforeAll(async () => {
  owner = await testUser(admin, "optin-owner", { operator: true });
  stranger = await testUser(admin, "optin-stranger", { operator: true });
  operator = await testUser(admin, "optin-operator");
  viewer = await testUser(admin, "optin-viewer");
  orgId = await createOrg(owner, "WhatsApp opt-in");
  orgB = await createOrg(stranger, "WhatsApp opt-in other");
  await invite(operator.userId, "operator");
  await invite(viewer.userId, "viewer");
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

describe("a lead with no recorded opt-in", () => {
  it("is refused a WhatsApp message: the send_wa job sends nothing and leaves no conversation", async () => {
    const lead = await newLead();
    expect(await optInOf(lead)).toBeNull();
    expect(await nextMessage(lead)).toEqual(REFUSED);
  });

  it("an opt-in with no source is no opt-in, and the message is refused", async () => {
    const lead = await newLead();
    await admin.query(
      `update contacts set consent = consent || '{"whatsapp_optin": {"status": "opted_in"}}' where id = $1`,
      [lead],
    );
    expect(await nextMessage(lead)).toEqual(REFUSED);
  });
});

describe("the API", () => {
  it("an operator records the lead's opt-in and where it came from, and the lead's next WhatsApp message is sent", async () => {
    const lead = await newLead();
    const res = await optIn(lead, operator.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ whatsapp_opt_in: true });
    expect(await optInOf(lead)).toMatchObject({
      status: "opted_in",
      source: "Godrej Woods site visit form",
    });
    expect(await nextMessage(lead)).toEqual(SENT);
    expect(await audits(lead)).toEqual([
      {
        action: "contact.whatsapp_opt_in",
        actor_id: operator.userId,
        meta: { source: "Godrej Woods site visit form" },
      },
    ]);
  });

  it("recording an opt-in twice answers the same, keeps the first source and audits once", async () => {
    const lead = await newLead();
    expect((await optIn(lead, owner.token)).status).toBe(200);
    const again = await optIn(lead, operator.token, { source: "a later form" });
    expect(again.status).toBe(200);
    expect((await optInOf(lead))?.source).toBe("Godrej Woods site visit form");
    expect(await audits(lead)).toHaveLength(1);
  });

  it("a withdrawn opt-in refuses the lead's next WhatsApp message", async () => {
    const lead = await newLead();
    expect((await optIn(lead, operator.token)).status).toBe(200);
    expect(await nextMessage(lead)).toEqual(SENT);
    const res = await optOut(lead, operator.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ whatsapp_opt_in: false });
    expect(await optInOf(lead)).toMatchObject({
      status: "withdrawn",
      source: "lead replied STOP",
    });
    expect(await nextMessage(lead)).toEqual(REFUSED);
    expect((await audits(lead)).map((a) => a.action)).toEqual([
      "contact.whatsapp_opt_in",
      "contact.whatsapp_opt_out",
    ]);
  });

  it("opting in again after a withdrawal is refused (409), by a person and by a list, and the lead stays refused", async () => {
    const number = phone();
    const lead = await newLead(orgId, number);
    expect((await optIn(lead, operator.token)).status).toBe(200);
    expect((await optOut(lead, owner.token)).status).toBe(200);
    const again = await optIn(lead, owner.token);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "opt_in_withdrawn" });
    const list = await importCsv(`phone,WhatsApp opt-in\n${number},yes\n`);
    expect(list.status).toBe(200);
    expect((await optInOf(lead))?.status).toBe("withdrawn");
    expect(await nextMessage(lead)).toEqual(REFUSED);
    expect(await audits(lead)).toHaveLength(2);
  });

  it("a lead who never opted in can be marked withdrawn, and a later list can't opt them in", async () => {
    const number = phone();
    const lead = await newLead(orgId, number);
    expect((await optOut(lead, operator.token)).status).toBe(200);
    await importCsv(`phone,wa_opt_in\n${number},yes\n`);
    expect((await optInOf(lead))?.status).toBe("withdrawn");
    expect(await nextMessage(lead)).toEqual(REFUSED);
  });

  it("a viewer, another company's admin and no sign-in are refused, and the lead stays without an opt-in", async () => {
    const lead = await newLead();
    expect((await optIn(lead, viewer.token)).status).toBe(403);
    expect((await optIn(lead, stranger.token)).status).toBe(403);
    expect((await optIn(lead, null)).status).toBe(401);
    expect((await optOut(lead, viewer.token)).status).toBe(403);
    expect(await optInOf(lead)).toBeNull();
  });

  it("a body without a source, with an empty or over-200-character source, or with other fields is refused", async () => {
    const lead = await newLead();
    for (const body of [
      {},
      { source: "" },
      { source: "   " },
      { source: "x".repeat(201) },
      { source: "form", status: "opted_in" },
      "yes",
    ]) {
      const res = await optIn(lead, operator.token, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(
      (await optIn(lead, operator.token, { source: "x".repeat(200) })).status,
    ).toBe(200);
  });

  it("another company's lead and a lead that doesn't exist are not found, and a malformed id is refused", async () => {
    const theirs = await newLead(orgB);
    const res = await optIn(theirs, owner.token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await optInOf(theirs)).toBeNull();
    expect((await optOut(theirs, owner.token)).status).toBe(404);
    expect((await optIn(randomUUID(), owner.token)).status).toBe(404);
    expect((await optIn("not-a-lead", owner.token)).status).toBe(400);
  });
});

describe("an imported list", () => {
  it("records the opt-in and its source column, or 'imported list', for new and known leads, and their next message is sent", async () => {
    const [fresh, known, plain] = [phone(), phone(), phone()];
    const existing = await newLead(orgId, known);
    const res = await importCsv(
      `first_name,phone,WhatsApp Opt-in,Opt-in source\nRavi,${fresh},Yes,Diwali expo stall\nMeera,${known},y,\nAsha,${plain},true,Website form\n`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, merged: 1, invalid: 0 });
    const ravi = await leadByPhone(fresh);
    expect(await optInOf(ravi)).toMatchObject({
      status: "opted_in",
      source: "Diwali expo stall",
    });
    expect((await optInOf(existing))?.source).toBe("imported list");
    expect((await optInOf(await leadByPhone(plain)))?.source).toBe(
      "Website form",
    );
    expect(await nextMessage(ravi)).toEqual(SENT);
    expect(await nextMessage(existing)).toEqual(SENT);
    expect(await audits(ravi)).toEqual([
      {
        action: "contact.whatsapp_opt_in",
        actor_id: operator.userId,
        meta: { source: "Diwali expo stall" },
      },
    ]);
  });

  it("only a clear yes opts a lead in: any other value, or no column, records nothing and the message is refused", async () => {
    const values = ["no", "n", "", "maybe", "0", "false"];
    const numbers = values.map(() => phone());
    const rows = values.map((v, i) => `${numbers[i]},${v}`).join("\n");
    expect((await importCsv(`phone,whatsapp_consent\n${rows}\n`)).status).toBe(
      200,
    );
    const bare = phone();
    expect((await importCsv(`phone\n${bare}\n`)).status).toBe(200);
    for (const n of [...numbers, bare]) {
      const lead = await leadByPhone(n);
      expect(await optInOf(lead)).toBeNull();
      expect(await nextMessage(lead)).toEqual(REFUSED);
    }
  });

  it("reads the column by its usual names, and keeps the opt-in columns out of the lead's other details", async () => {
    const headers = [
      "whatsapp_opt_in",
      "WA Opt-In",
      "WhatsApp Consent",
      '"WhatsApp opt-in (Y/N)"',
    ];
    const numbers = headers.map(() => phone());
    for (const [i, header] of headers.entries())
      expect(
        (
          await importCsv(
            `phone,${header},whatsapp_opt_in_source,city\n${numbers[i]},1,Expo,Pune\n`,
          )
        ).status,
      ).toBe(200);
    for (const n of numbers) {
      const lead = await leadByPhone(n);
      expect(await optInOf(lead)).toMatchObject({
        status: "opted_in",
        source: "Expo",
      });
      const details = await admin.query(
        `select attributes from contacts where id = $1`,
        [lead],
      );
      expect(details.rows[0]?.attributes).toEqual({ city: "Pune" });
    }
  });
});
