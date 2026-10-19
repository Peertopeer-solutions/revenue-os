// The one way each conversation operation is written (openConversation, addMessage, finishConversation), against the
// real local database as app_service through withOrg, the worker's own login. Fixtures are made as postgres (row-level
// security doesn't apply to it). Covers: a lead's open thread reused, a call's conversation filled in by whichever
// writer comes second, two writers adding messages at once, an outcome that is this company's own, and migration 022's
// rule of one open thread per lead and channel.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { testCompanies } from "../../../tests/test-companies";
import {
  addMessage,
  createPool,
  finishConversation,
  openConversation,
  withOrg,
} from "../src";

const admin = new Pool({
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
let [orgA, orgB, runA] = ["", "", ""];

const lead = async (org = orgA) =>
  String(
    (
      await admin.query(
        "insert into contacts (org_id, first_name) values ($1, 'Asha') returning id",
        [org],
      )
    ).rows[0]?.id,
  );
const row = async (id: string) =>
  (
    await admin.query(
      `select contact_id, workflow_run_id, agent_id, direction, status, started_at, ended_at, summary,
              (select key from dispositions d where d.id = c.disposition_id) as outcome
         from conversations c where id = $1`,
      [id],
    )
  ).rows[0];
const lines = async (id: string) =>
  (
    await admin.query(
      "select seq, role, content, tool_call, ts from messages where conversation_id = $1 order by seq",
      [id],
    )
  ).rows;

beforeAll(async () => {
  orgA = (await companies.add("Convo Ops A")).id;
  orgB = (await companies.add("Convo Ops B")).id;
  await admin.query(
    `insert into dispositions (org_id, key, label, category) values ($1, 'interested', 'Interested', 'qualified')`,
    [orgA],
  );
  await admin.query(
    `insert into dispositions (org_id, key, label, category) values ($1, 'callback', 'Call back', 'callback')`,
    [orgB],
  );
  const wf = await admin.query(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', '{}'::jsonb) returning id`,
    [orgA, `wf-${randomUUID()}`],
  );
  const contact = await lead();
  runA = String(
    (
      await admin.query(
        `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step)
         values ($1, $2, $3, 'waiting', 'c') returning id`,
        [orgA, wf.rows[0]?.id, contact],
      )
    ).rows[0]?.id,
  );
}, 30_000);

afterAll(async () => {
  await companies.cleanup();
  await app.end();
  await admin.end();
});

const open = (c: Parameters<typeof openConversation>[2], org = orgA) =>
  withOrg(app, org, (tx) => openConversation(tx, org, c));

describe("openConversation", () => {
  it("reuses a lead's open thread on a channel, which follows the newest run; another channel or a finished thread gets its own", async () => {
    const contactId = await lead();
    const first = await open({
      channel: "whatsapp",
      direction: "inbound",
      contactId,
    });
    expect((await row(first)).started_at).toBeInstanceOf(Date); // start time set
    const again = await open({
      channel: "whatsapp",
      direction: "outbound",
      contactId,
      workflowRunId: runA,
      provider: "meta_wa",
    });
    expect(again).toBe(first);
    expect(await row(first)).toMatchObject({
      workflow_run_id: runA,
      direction: "inbound", // the thread keeps how it began
    });
    const sms = await open({
      channel: "sms",
      direction: "outbound",
      contactId,
    });
    expect(sms).not.toBe(first);
    await withOrg(app, orgA, (tx) =>
      finishConversation(tx, orgA, first, { status: "completed" }),
    );
    const next = await open({
      channel: "whatsapp",
      direction: "outbound",
      contactId,
    });
    expect(next).not.toBe(first);
  });

  it("opens one conversation per call id, and a second open only fills in what is missing, keeping the earliest start", async () => {
    const contactId = await lead();
    const agentId = String(
      (
        await admin.query(
          `insert into agents (org_id, key, version, status, model, system_prompt) values ($1, $2, 1, 'active', 'm', 'p') returning id`,
          [orgA, `a-${randomUUID()}`],
        )
      ).rows[0]?.id,
    );
    const call = { channel: "voice", provider: "vapi" } as const;
    const ref = `call-${randomUUID()}`;
    const placed = await open({
      ...call,
      providerRef: ref,
      direction: "outbound",
      contactId,
      workflowRunId: runA,
      agentId,
    });
    const heard = await open({
      ...call,
      providerRef: ref,
      direction: "inbound",
      startedAt: "2026-10-19T09:00:00Z",
    });
    expect(heard).toBe(placed);
    expect(await row(placed)).toMatchObject({
      contact_id: contactId,
      workflow_run_id: runA,
      agent_id: agentId,
      direction: "outbound",
      started_at: new Date("2026-10-19T09:00:00Z"),
    });
    // the same call id at another company is that company's own call
    const other = await open(
      { ...call, providerRef: ref, direction: "inbound" },
      orgB,
    );
    expect(other).not.toBe(placed);
    // a call is never a lead's thread: a second call for the lead is its own
    const second = await open({
      ...call,
      providerRef: `call-${randomUUID()}`,
      direction: "outbound",
      contactId,
    });
    expect(second).not.toBe(placed);
  });

  it("gives a caller nobody knows a new conversation each time", async () => {
    const a = await open({ channel: "voice", direction: "inbound" });
    const b = await open({ channel: "voice", direction: "inbound" });
    expect(a).not.toBe(b);
    expect((await row(a)).contact_id).toBeNull();
  });
});

describe("addMessage", () => {
  it("adds lines in order with the event's own time, a tool's call as data, and refuses another company's conversation", async () => {
    const id = await open({ channel: "voice", direction: "inbound" });
    const seqs = await withOrg(app, orgA, async (tx) => [
      await addMessage(tx, orgA, id, {
        role: "contact",
        content: "Hello",
        at: "2026-10-19T09:00:05Z",
      }),
      await addMessage(tx, orgA, id, {
        role: "tool",
        toolCall: { name: "lookup", result: { ok: true } },
      }),
    ]);
    expect(seqs).toEqual([1, 2]);
    expect(await lines(id)).toMatchObject([
      {
        seq: 1,
        role: "contact",
        content: "Hello",
        tool_call: null,
        ts: new Date("2026-10-19T09:00:05Z"),
      },
      {
        seq: 2,
        role: "tool",
        content: null,
        tool_call: { name: "lookup", result: { ok: true } },
      },
    ]);
    await expect(
      withOrg(app, orgB, (tx) =>
        addMessage(tx, orgB, id, { role: "agent", content: "x" }),
      ),
    ).rejects.toThrow(`conversation ${id} is not one of this company's`);
    expect(await lines(id)).toHaveLength(2);
  });

  it("keeps two writers at once in order: the second waits for the first and takes the next seq, and no line is lost", async () => {
    const id = await open({ channel: "voice", direction: "inbound" });
    let releaseFirst = () => {};
    const held = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let firstAdded = () => {};
    const added = new Promise<void>((r) => {
      firstAdded = r;
    });
    const first = withOrg(app, orgA, async (tx) => {
      const seq = await addMessage(tx, orgA, id, {
        role: "contact",
        content: "first",
      });
      firstAdded();
      await held; // the first writer's transaction stays open
      return seq;
    });
    await added;
    let secondDone = false;
    const second = withOrg(app, orgA, (tx) =>
      addMessage(tx, orgA, id, { role: "agent", content: "second" }),
    ).then((seq) => {
      secondDone = true;
      return seq;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(secondDone).toBe(false); // it waits on the conversation's row
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect((await lines(id)).map((l) => l.content)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("finishConversation", () => {
  it("finishes with its status, end time, summary and this company's outcome, once; later finishes only fill what is missing", async () => {
    const contactId = await lead();
    const id = await open({
      channel: "whatsapp",
      direction: "inbound",
      contactId,
    });
    const finished = await withOrg(app, orgA, (tx) =>
      finishConversation(tx, orgA, id, {
        status: "no_answer",
        endedAt: "2026-10-19T09:05:00Z",
      }),
    );
    expect(finished).toEqual({ contactId });
    await withOrg(app, orgA, (tx) =>
      finishConversation(tx, orgA, id, {
        status: "completed",
        endedAt: "2026-10-19T10:00:00Z",
        summary: "Wants a 2BHK.",
        outcome: "interested",
      }),
    );
    expect(await row(id)).toMatchObject({
      status: "no_answer",
      ended_at: new Date("2026-10-19T09:05:00Z"),
      summary: "Wants a 2BHK.",
      outcome: "interested",
    });
    const nobody = await open({ channel: "voice", direction: "inbound" });
    expect(
      await withOrg(app, orgA, (tx) =>
        finishConversation(tx, orgA, nobody, { status: "completed" }),
      ),
    ).toEqual({ contactId: null });
    expect((await row(nobody)).ended_at).toBeInstanceOf(Date);
  });

  it("refuses an outcome the company doesn't have, even one another company has, and another company's conversation", async () => {
    const id = await open({ channel: "voice", direction: "inbound" });
    for (const outcome of ["callback", "maybe"])
      await expect(
        withOrg(app, orgA, (tx) =>
          finishConversation(tx, orgA, id, { status: "completed", outcome }),
        ),
      ).rejects.toThrow(`"${outcome}" is not one of this company's outcomes`);
    await expect(
      withOrg(app, orgB, (tx) =>
        finishConversation(tx, orgB, id, { status: "completed" }),
      ),
    ).rejects.toThrow(`conversation ${id} is not one of this company's`);
    expect(await row(id)).toMatchObject({
      status: "active",
      ended_at: null,
      outcome: null,
    });
  });
});

describe("migration 022: one open thread per lead and channel", () => {
  it("refuses a second open thread for a lead, and allows a call, another channel and a finished thread beside it", async () => {
    const contactId = await lead();
    const insert = (channel: string, status: string, ref: string | null) =>
      admin.query(
        `insert into conversations (org_id, contact_id, channel, direction, status, provider, provider_ref)
         values ($1, $2, $3, 'outbound', $4, $5, $6)`,
        [orgA, contactId, channel, status, ref ? "vapi" : null, ref],
      );
    await insert("whatsapp", "active", null);
    await expect(insert("whatsapp", "queued", null)).rejects.toThrow(
      "convo_open_thread_uq",
    );
    await insert("whatsapp", "completed", null);
    await insert("sms", "active", null);
    await insert("voice", "active", `call-${randomUUID()}`);
    await insert("voice", "active", `call-${randomUUID()}`);
    const active = await admin.query(
      "select count(*)::int n from conversations where org_id = $1 and contact_id = $2 and status = 'active'",
      [orgA, contactId],
    );
    expect(active.rows[0]?.n).toBe(4);
    // openConversation finds that one open WhatsApp thread through the index
    const thread = await admin.query(
      `select id from conversations where org_id = $1 and contact_id = $2 and channel = 'whatsapp' and status = 'active'`,
      [orgA, contactId],
    );
    expect(
      await open({ channel: "whatsapp", direction: "outbound", contactId }),
    ).toBe(thread.rows[0]?.id);
  });
});
