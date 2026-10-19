// "Don't contact me", from each of the three ways it reaches us: a person marking the lead in the console (the
// worker's route), an imported list (the CSV import route) and a call (the end-of-call report's AI reading, through
// the Vapi webhook and its processor). Each records the block where the guard before every send reads it, and then
// that lead's next WhatsApp message and next call, each in a sequence of its own, are refused: the real send_wa and
// place_call handlers run with the real guard, on the product's own database login, and only the provider is faked.
// A lead nobody blocked gets both, so a refusal is the block's doing. On the local stack (`bun run gate`, CI).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool } from "@revenue-os/db";
import { guard, ToolRegistry } from "@revenue-os/harness";
import pg from "pg";
import { OPTED_IN } from "../../../tests/opted-in";
import { testCompanies } from "../../../tests/test-companies";
import { type TestUser, testUser } from "../../../tests/test-users";
import { pool } from "../src/db";
import { handlePlaceCall } from "../src/handlers/place-call";
import { handleSendWa } from "../src/handlers/send-wa";
import app from "../src/index";
import { processVapiEvents } from "../src/vapi/process";

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
const SECRET = process.env.VAPI_WEBHOOK_SECRET || "local-test-secret";
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
  return `+919800${String(phoneSeq).padStart(6, "0")}`;
}

/** A lead of `org` with a phone and a WhatsApp number, who agreed to WhatsApp messages. */
async function newLead(org = orgId, number = phone()): Promise<string> {
  const c = await admin.query<{ id: string }>(
    `insert into contacts (org_id, first_name, consent) values ($1, 'Meera', $2) returning id`,
    [org, OPTED_IN],
  );
  const id = c.rows[0]?.id ?? "";
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'phone', $3, true), ($1, $2, 'whatsapp', $3, false)`,
    [org, id, number],
  );
  return id;
}

const isBlocked = async (contactId: string) =>
  (
    await admin.query(
      `select consent -> 'dnc' = 'true'::jsonb as blocked from contacts where id = $1`,
      [contactId],
    )
  ).rows[0]?.blocked === true;

const leadByPhone = async (number: string) =>
  (
    await admin.query<{ contact_id: string }>(
      `select contact_id from contact_identities where org_id = $1 and kind = 'phone' and value = $2`,
      [orgId, number],
    )
  ).rows[0]?.contact_id ?? "";

/** The lead's do-not-call audit rows, in any company. */
const audits = async (contactId: string) =>
  (
    await admin.query(
      `select count(*)::int n from audit_log where action = 'contact.do_not_call' and resource_id = $1`,
      [contactId],
    )
  ).rows[0]?.n;

/**
 * Runs `work` while another connection holds the row `lock` selects for update, and cancels `work`'s statement as soon
 * as it waits on that row: a database failure in the middle of a write. Says how `work` ended.
 */
async function cancelledWhileLocked(
  lock: string,
  values: unknown[],
  work: () => Promise<unknown>,
): Promise<string> {
  const holder = await admin.connect();
  try {
    await holder.query("begin");
    await holder.query(lock, values);
    const { pid } = (
      await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
    ).rows[0] ?? { pid: 0 };
    const ended = work().then(
      () => "finished",
      (err: Error) => `failed: ${err.message}`,
    );
    let waiting: number[] = [];
    for (let i = 0; i < 200 && !waiting.length; i++) {
      await Bun.sleep(50);
      waiting = (
        await admin.query<{ pid: number }>(
          `select pid from pg_stat_activity where $1 = any (pg_blocking_pids(pid))`,
          [pid],
        )
      ).rows.map((r) => r.pid);
    }
    expect(waiting).toHaveLength(1);
    await admin.query("select pg_cancel_backend($1)", [waiting[0]]);
    return await ended;
  } finally {
    await holder.query("rollback");
    holder.release();
  }
}

const CALL_WF = {
  entry: "c",
  steps: {
    c: { kind: "call", agent: "closer", on: { completed: "end" } },
    end: { kind: "end" },
  },
};
// Written as JSON text: its step's `then` is the sequence's own field, which as an object key lint takes for a promise's.
const WA_WF: unknown = JSON.parse(
  '{"entry": "w", "steps": {"w": {"kind": "whatsapp", "template": "hello", "then": "end"}, "end": {"kind": "end"}}}',
);

async function runIn(definition: unknown, contactId: string, step: string) {
  const wf = await admin.query<{ id: string }>(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [orgId, `dnc-${randomUUID()}`, JSON.stringify(definition)],
  );
  const run = await admin.query<{ id: string }>(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state, wake_at)
     values ($1, $2, $3, 'waiting', $4, $5::jsonb, now()) returning id`,
    [orgId, wf.rows[0]?.id, contactId, step, JSON.stringify({ contactId })],
  );
  return run.rows[0]?.id ?? "";
}

/**
 * The lead's next WhatsApp message and next call, each in a sequence of its own, as the worker's send_wa and
 * place_call jobs make them: what reached the (fake) provider, and the conversations the sends left.
 */
async function nextSends(contactId: string) {
  const sent = { whatsapp: 0, calls: 0 };
  const waRun = await runIn(WA_WF, contactId, "w");
  const callRun = await runIn(CALL_WF, contactId, "c");
  await handleSendWa(
    {
      pool: appPool,
      guard,
      sender: {
        send: async () => {
          sent.whatsapp += 1;
          return { providerRef: `wamid-${randomUUID()}` };
        },
      },
    },
    {
      orgId,
      runId: waRun,
      step: "w",
      idx: 0,
      action: { kind: "send_wa", contactId, template: "hello", vars: {} },
    },
  );
  await handlePlaceCall(
    {
      pool: appPool,
      guard,
      sender: {
        place: async () => {
          sent.calls += 1;
          return { providerRef: `call-${randomUUID()}` };
        },
      },
      provider: {
        complete: async () => ({ text: "Namaste.", usage: { in: 1, out: 1 } }),
      },
      registry: new ToolRegistry(),
      outcome: async () => "completed",
    },
    {
      orgId,
      runId: callRun,
      action: { kind: "place_call", contactId, agentKey: "closer" },
    },
  );
  const left = await admin.query(
    `select count(*)::int n from conversations where org_id = $1 and workflow_run_id = any($2::uuid[])`,
    [orgId, [waRun, callRun]],
  );
  return { ...sent, conversations: left.rows[0]?.n };
}

const REFUSED = { whatsapp: 0, calls: 0, conversations: 0 };
const SENT = { whatsapp: 1, calls: 1, conversations: 2 };

beforeAll(async () => {
  owner = await testUser(admin, "dnc-owner", { operator: true });
  stranger = await testUser(admin, "dnc-stranger", { operator: true });
  operator = await testUser(admin, "dnc-operator");
  viewer = await testUser(admin, "dnc-viewer");
  orgId = await createOrg(owner, "Do-not-call");
  orgB = await createOrg(stranger, "Do-not-call other");
  await invite(operator.userId, "operator");
  await invite(viewer.userId, "viewer");
  await admin.query(
    `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed)
     values ($1, 'closer', 1, 'active', 'claude-sonnet-4-6', 'You call leads.', '{}')`,
    [orgId],
  );
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await appPool.end();
  await admin.end();
});

describe("a lead nobody blocked", () => {
  // behaviour already on main: a lead nobody blocked is sent to on main too; this is the control that makes each refusal below the block's doing
  it("gets their next WhatsApp message and call, so each refusal below is the block's doing", async () => {
    expect(await nextSends(await newLead())).toEqual(SENT);
  });
});

describe("a person in the console", () => {
  const mark = (contactId: string, token: string | null, org = orgId) =>
    api(`/orgs/${org}/contacts/${contactId}/do-not-call`, token, {
      method: "POST",
    });

  it("an operator marks a lead do-not-call, and that lead's next WhatsApp message and call are refused in every sequence", async () => {
    const lead = await newLead();
    const res = await mark(lead, operator.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ do_not_call: true });
    expect(await nextSends(lead)).toEqual(REFUSED);
    const list = await api(`/orgs/${orgId}/contacts`, viewer.token);
    const { contacts } = (await list.json()) as {
      contacts: { id: string; do_not_call: boolean }[];
    };
    expect(contacts.find((c) => c.id === lead)?.do_not_call).toBe(true);
  });

  it("marking a lead already blocked answers the same and records it once", async () => {
    const lead = await newLead();
    expect((await mark(lead, owner.token)).status).toBe(200);
    const again = await mark(lead, operator.token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ do_not_call: true });
    const rows = await admin.query(
      `select actor_id from audit_log where org_id = $1 and action = 'contact.do_not_call' and resource_id = $2`,
      [orgId, lead],
    );
    expect(rows.rows).toEqual([{ actor_id: owner.userId }]);
  });

  it("a viewer, another company's admin and no sign-in are refused, and the lead stays open", async () => {
    const lead = await newLead();
    expect((await mark(lead, viewer.token)).status).toBe(403);
    expect((await mark(lead, stranger.token)).status).toBe(403);
    expect((await mark(lead, null)).status).toBe(401);
    expect(await isBlocked(lead)).toBe(false);
  });

  it("another company's lead and a lead that doesn't exist are not found, and a malformed id is refused", async () => {
    const theirs = await newLead(orgB);
    const res = await mark(theirs, owner.token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await isBlocked(theirs)).toBe(false);
    expect((await mark(randomUUID(), owner.token)).status).toBe(404);
    expect((await mark("not-a-lead", owner.token)).status).toBe(400);
  });

  it("a save the database cuts off leaves the lead open with no audit row, and marking again blocks them", async () => {
    const lead = await newLead();
    const ended = await cancelledWhileLocked(
      "select 1 from contacts where id = $1 for update",
      [lead],
      async () => {
        const res = await mark(lead, operator.token);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      },
    );
    expect(ended).toBe("failed: HTTP 500");
    expect(await isBlocked(lead)).toBe(false);
    expect(await audits(lead)).toBe(0);
    expect((await mark(lead, operator.token)).status).toBe(200);
    expect(await isBlocked(lead)).toBe(true);
    expect(await audits(lead)).toBe(1);
  });

  it("a person finds any lead to block by name or number, beyond the latest 100, and none of another company's", async () => {
    const number = phone();
    const old = await newLead(orgId, number);
    await admin.query(
      `update contacts set first_name = 'Zubin', last_name = 'Oldlead', created_at = now() - interval '1 day' where id = $1`,
      [old],
    );
    const theirs = await newLead(orgB);
    await admin.query(
      `update contacts set first_name = 'Zubin', last_name = 'Oldlead' where id = $1`,
      [theirs],
    );
    await admin.query(
      `insert into contacts (org_id, first_name) select $1, 'Newer ' || g from generate_series(1, 101) g`,
      [orgId],
    );
    const found = async (q?: string) => {
      const res = await api(
        `/orgs/${orgId}/contacts${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`,
        viewer.token,
      );
      expect(res.status).toBe(200);
      const { contacts } = (await res.json()) as { contacts: { id: string }[] };
      return contacts.map((c) => c.id);
    };
    expect(await found()).not.toContain(old);
    expect(await found("zubin OLDLEAD")).toEqual([old]);
    expect(await found(number.slice(-6))).toEqual([old]);
    expect(await found("%")).toEqual([]);
    expect(await found("_")).toEqual([]);
    expect(await found("980")).toEqual([]); // every number here holds 980, but under four digits searches no number
    expect((await mark(old, operator.token)).status).toBe(200);
    expect(await isBlocked(old)).toBe(true);
    const long = await api(
      `/orgs/${orgId}/contacts?q=${"a".repeat(101)}`,
      viewer.token,
    );
    expect(long.status).toBe(400);
  });
});

describe("an imported list", () => {
  const importCsv = (csv: string) =>
    api(`/orgs/${orgId}/contacts/import`, operator.token, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csv,
    });

  // behaviour already on main: the list now also opts its leads in to WhatsApp, so each refusal stays the block's doing
  it("a lead the list marks do-not-call is blocked, whether new or already the company's, and their next send is refused", async () => {
    const [fresh, known, open] = [phone(), phone(), phone()];
    const existing = await newLead(orgId, known);
    const res = await importCsv(
      `first_name,phone,Do Not Call,WhatsApp opt-in\nRavi,${fresh},yes,yes\nMeera,${known},Y,\nAsha,${open},no,yes\n`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 2, merged: 1, invalid: 0 });
    const blocked = await leadByPhone(fresh);
    expect(await nextSends(blocked)).toEqual(REFUSED);
    expect(await nextSends(existing)).toEqual(REFUSED);
    expect(await isBlocked(await leadByPhone(open))).toBe(false);
    const audited = await admin.query(
      `select actor_id, meta from audit_log where org_id = $1 and action = 'contact.do_not_call' and resource_id = $2`,
      [orgId, blocked],
    );
    expect(audited.rows).toEqual([
      { actor_id: operator.userId, meta: { from: "import" } },
    ]);
  });

  it("reads the column by any of its usual names, and keeps it out of the lead's other details", async () => {
    const headers = [
      "dnc",
      "DND",
      "do_not_contact",
      "do-not-call",
      "DoNotCall",
      '"Do Not Call?"',
      '"DNC (Y/N)"',
      "Do Not Disturb",
    ];
    const numbers = headers.map(() => phone());
    for (const [i, header] of headers.entries())
      expect(
        (await importCsv(`phone,${header}\n${numbers[i]},true\n`)).status,
      ).toBe(200);
    for (const n of numbers) {
      const lead = await leadByPhone(n);
      expect(await isBlocked(lead)).toBe(true);
      const attrs = await admin.query(
        `select attributes from contacts where id = $1`,
        [lead],
      );
      expect(attrs.rows[0]?.attributes).toEqual({});
    }
  });

  it("a value it can't read blocks the lead, as do-not-call blocks when in doubt; an empty one or a no leaves them open", async () => {
    const [odd, blank, no] = [phone(), phone(), phone()];
    await importCsv(`phone,dnd\n${odd},maybe\n${blank},\n${no}, N \n`);
    expect(await isBlocked(await leadByPhone(odd))).toBe(true);
    expect(await isBlocked(await leadByPhone(blank))).toBe(false);
    expect(await isBlocked(await leadByPhone(no))).toBe(false);
  });

  it("a later list that says no, or leaves the column out, never lifts a block", async () => {
    const number = phone();
    await importCsv(`phone,do_not_call\n${number},1\n`);
    const lead = await leadByPhone(number);
    expect((await importCsv(`phone,do_not_call\n${number},no\n`)).status).toBe(
      200,
    );
    expect((await importCsv(`phone,first_name\n${number},Ravi\n`)).status).toBe(
      200,
    );
    expect(await isBlocked(lead)).toBe(true);
    expect(await nextSends(lead)).toEqual(REFUSED);
  });

  it("a list blocks only its own company's leads: company B's list leaves company A's lead with the same number open", async () => {
    const number = phone();
    const ours = await newLead(orgId, number);
    const theirs = await newLead(orgB, number);
    const res = await api(`/orgs/${orgB}/contacts/import`, stranger.token, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: `phone,do_not_call\n${number},yes\n`,
    });
    expect(await res.json()).toEqual({ created: 0, merged: 1, invalid: 0 });
    expect(await isBlocked(theirs)).toBe(true);
    expect(await isBlocked(ours)).toBe(false);
    expect(await audits(ours)).toBe(0);
    expect(await nextSends(ours)).toEqual(SENT);
  });

  it("a list the database cuts off leaves nothing half-done, and importing it again blocks its leads once", async () => {
    const [fresh, known] = [phone(), phone()];
    const existing = await newLead(orgId, known);
    const csv = `phone,do_not_call\n${fresh},yes\n${known},yes\n`;
    // The fresh row is filed and blocked first; the known row's merge then waits on the lead's lock and is cut off.
    const ended = await cancelledWhileLocked(
      "select 1 from contacts where id = $1 for update",
      [existing],
      async () => {
        const res = await importCsv(csv);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      },
    );
    expect(ended).toBe("failed: HTTP 500");
    expect(await leadByPhone(fresh)).toBe("");
    expect(await isBlocked(existing)).toBe(false);
    expect(await audits(existing)).toBe(0);

    const again = await importCsv(csv);
    expect(await again.json()).toEqual({ created: 1, merged: 1, invalid: 0 });
    const created = await leadByPhone(fresh);
    for (const lead of [created, existing]) {
      expect(await isBlocked(lead)).toBe(true);
      expect(await audits(lead)).toBe(1);
    }
  });

  it("the same list imported twice blocks its lead once, with one audit row", async () => {
    const number = phone();
    const csv = `first_name,phone,dnc\nTara,${number},yes\n`;
    expect(await (await importCsv(csv)).json()).toEqual({
      created: 1,
      merged: 0,
      invalid: 0,
    });
    expect(await (await importCsv(csv)).json()).toEqual({
      created: 0,
      merged: 1,
      invalid: 0,
    });
    const lead = await leadByPhone(number);
    expect(await isBlocked(lead)).toBe(true);
    expect(await audits(lead)).toBe(1);
  });
});

describe("a call", () => {
  /** A call to `contactId` (null: a call linked to no lead), its id as the provider gives it. */
  async function call(contactId: string | null): Promise<string> {
    const callId = `call-dnc-${randomUUID()}`;
    await admin.query(
      `insert into conversations (org_id, contact_id, channel, direction, status, provider, provider_ref)
       values ($1, $2, 'voice', 'outbound', 'active', 'vapi', $3)`,
      [orgId, contactId, callId],
    );
    return callId;
  }

  /**
   * The call's end-of-call report, with the AI's reading of the call, received and filed as the worker does it.
   * `extra` adds to the report what Vapi sends beside it (its time as epoch milliseconds, the caller's number).
   */
  async function endOfCall(
    callId: string,
    structuredData: unknown,
    extra: Record<string, unknown> = {},
  ) {
    await report(callId, structuredData, extra);
    await processVapiEvents(pool, orgId);
    expect(await events(callId)).toEqual([{ status: "processed" }]);
  }

  /** The report received and stored, as the provider sends it, but not yet filed. */
  async function report(
    callId: string,
    structuredData: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const res = await api(`/webhooks/vapi/${orgId}`, null, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-secret": SECRET },
      body: JSON.stringify({
        message: {
          type: "end-of-call-report",
          id: `eoc-${randomUUID()}`,
          timestamp: new Date().toISOString(),
          call: { id: callId },
          summary: "The lead asked us to stop calling.",
          analysis: { summary: "Asked not to be contacted.", structuredData },
          ...extra,
        },
      }),
    });
    expect(res.status).toBe(202);
  }

  const events = async (callId: string) =>
    (
      await admin.query(
        `select status from webhook_events where org_id = $1 and payload -> 'message' -> 'call' ->> 'id' = $2`,
        [orgId, callId],
      )
    ).rows;

  it("the AI's reading that the lead asked not to be contacted blocks the call's lead, and their next send is refused", async () => {
    const lead = await newLead();
    const callId = await call(lead);
    await endOfCall(callId, { doNotCall: true });
    expect(await isBlocked(lead)).toBe(true);
    expect(await nextSends(lead)).toEqual(REFUSED);
    const audited = await admin.query(
      `select a.actor_type, a.meta ->> 'from' as source
         from audit_log a join conversations c
           on c.org_id = a.org_id and c.id::text = a.meta ->> 'conversation_id'
        where a.org_id = $1 and a.action = 'contact.do_not_call' and a.resource_id = $2 and c.provider_ref = $3`,
      [orgId, lead, callId],
    );
    expect(audited.rows).toEqual([
      { actor_type: "integration", source: "call" },
    ]);
  });

  it("a reading may never lift a block or grant consent, whatever it says", async () => {
    const lead = await newLead();
    await endOfCall(await call(lead), { doNotCall: true });
    await endOfCall(await call(lead), {
      doNotCall: false,
      whatsappOptIn: true,
      consent: { dnc: false, whatsapp_optin: true },
    });
    const after = await admin.query(
      `select consent from contacts where id = $1`,
      [lead],
    );
    expect(after.rows[0]?.consent).toEqual({
      dnc: true,
      whatsapp_optin: null,
      recording_consent: null,
    });
    expect(await nextSends(lead)).toEqual(REFUSED);
  });

  // behaviour already on main: main never blocks a lead from a call's reading at all; this pins that only an explicit doNotCall: true blocks
  it("a reading that doesn't say the lead asked to stop leaves them open", async () => {
    const lead = await newLead();
    await endOfCall(await call(lead), { doNotCall: false });
    await endOfCall(await call(lead), { doNotCall: "maybe" });
    await endOfCall(await call(lead), null);
    expect(await isBlocked(lead)).toBe(false);
    expect(await nextSends(lead)).toEqual(SENT);
  });

  // behaviour already on main: main blocks nobody from any call; this pins that a reading on a call with no lead still blocks nobody and is filed
  it("a call linked to no lead blocks nobody, and its report is still filed", async () => {
    const blocks = async () =>
      (
        await admin.query(
          `select count(*)::int n from audit_log where org_id = $1 and action = 'contact.do_not_call'`,
          [orgId],
        )
      ).rows[0]?.n;
    const before = await blocks();
    await endOfCall(await call(null), { doNotCall: true });
    expect(await blocks()).toBe(before);
  });

  it("a report as Vapi sends it, its time in epoch milliseconds, is received and filed, and its reading blocks the lead", async () => {
    const lead = await newLead();
    const callId = await call(lead);
    const at = Date.parse("2026-10-18T09:30:00Z");
    await endOfCall(callId, { doNotCall: true }, { timestamp: at });
    expect(await isBlocked(lead)).toBe(true);
    const ended = await admin.query(
      `select ended_at from conversations where org_id = $1 and provider_ref = $2`,
      [orgId, callId],
    );
    expect(ended.rows[0]?.ended_at.toISOString()).toBe(
      "2026-10-18T09:30:00.000Z",
    );
  });

  it("a reading that asked not to be contacted blocks the lead even when the rest of its report can't be filed, which is marked failed", async () => {
    // An end time Postgres can't read, and one too large for a date.
    for (const timestamp of ["1970-13-45T99:99:99Z", 9e15]) {
      const lead = await newLead();
      const callId = await call(lead);
      await report(callId, { doNotCall: true }, { timestamp });
      await processVapiEvents(pool, orgId);
      expect(await events(callId)).toEqual([{ status: "failed" }]);
      expect(await isBlocked(lead)).toBe(true);
      expect(await audits(lead)).toBe(1);
      expect(await nextSends(lead)).toEqual(REFUSED);
    }
  });

  // behaviour already on main: main marks a report it can't file failed and files the company's other events; this pins that recording a block first keeps both
  it("a report with a reading to block whose call the database can't file at all (its id too long for the key) is marked failed, and the company's next report is still filed", async () => {
    // Random, so the database can't compress it to fit the key.
    const tooLong = `call-${Array.from({ length: 400 }, () => randomUUID()).join("")}`;
    await report(
      tooLong,
      { doNotCall: true },
      { timestamp: "2026-10-18T09:00:00Z" },
    );
    const next = await call(await newLead());
    await report(next, null, { timestamp: "2026-10-18T09:01:00Z" });
    await processVapiEvents(pool, orgId);
    expect(await events(tooLong)).toEqual([{ status: "failed" }]);
    expect(await events(next)).toEqual([{ status: "processed" }]);
  });

  it("a known lead who calls in is blocked by the number they call from, and their next send is refused", async () => {
    const number = phone();
    const lead = await newLead(orgId, number);
    const theirs = await newLead(orgB, number); // the same number, another company's lead
    await endOfCall(
      `call-in-${randomUUID()}`,
      { doNotCall: true },
      { customer: { number } },
    );
    expect(await isBlocked(lead)).toBe(true);
    expect(await nextSends(lead)).toEqual(REFUSED);
    expect(await isBlocked(theirs)).toBe(false);
  });

  it("a caller is matched by their WhatsApp number too, and by the number on the report's call", async () => {
    const number = phone();
    const c = await admin.query<{ id: string }>(
      `insert into contacts (org_id, first_name) values ($1, 'Kabir') returning id`,
      [orgId],
    );
    const lead = c.rows[0]?.id ?? "";
    await admin.query(
      `insert into contact_identities (org_id, contact_id, kind, value) values ($1, $2, 'whatsapp', $3)`,
      [orgId, lead, number],
    );
    const callId = `call-in-${randomUUID()}`;
    await endOfCall(
      callId,
      { doNotCall: true },
      {
        call: { id: callId, customer: { number: number.replace("+91", "0") } },
      },
    );
    expect(await isBlocked(lead)).toBe(true);
  });

  // behaviour already on main: main blocks nobody from any call; this pins that a caller no lead has blocks nobody
  it("a caller whose number no lead of the company has blocks nobody", async () => {
    const blocks = async () =>
      (
        await admin.query(
          `select count(*)::int n from audit_log where org_id = $1 and action = 'contact.do_not_call'`,
          [orgId],
        )
      ).rows[0]?.n;
    const before = await blocks();
    await endOfCall(
      `call-in-${randomUUID()}`,
      { doNotCall: true },
      { customer: { number: phone() } },
    );
    expect(await blocks()).toBe(before);
  });

  it("a call's block that the database cuts off is kept for the next run, which blocks the lead once", async () => {
    const lead = await newLead();
    const callId = await call(lead);
    await report(callId, { doNotCall: true });
    const ended = await cancelledWhileLocked(
      "select 1 from conversations where org_id = $1 and provider_ref = $2 for update",
      [orgId, callId],
      () => processVapiEvents(pool, orgId),
    );
    expect(ended).toStartWith("failed: ");
    expect(await events(callId)).toEqual([{ status: "received" }]);
    expect(await isBlocked(lead)).toBe(false);
    await processVapiEvents(pool, orgId);
    expect(await events(callId)).toEqual([{ status: "processed" }]);
    expect(await isBlocked(lead)).toBe(true);
    expect(await audits(lead)).toBe(1);
  });
});
