// Call events through the Vapi webhook (the receiver, then the processor the job runs) when two companies' events
// share an event id or a call id, and when one event can't be filed (ROADMAP.md, Slice 1): each company's events
// are its own, so neither is dropped as the other's duplicate nor filed on the other's conversation, and a bad event
// is marked failed with its reason while the company's other events are filed. A failure of the database itself (a
// lost connection, a cancelled statement) is no event's fault: the whole job fails and the next run files every event.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { pool } from "../src/db";
import app from "../src/index";
import { processVapiEvents } from "../src/vapi/process";

const SECRET = process.env.VAPI_WEBHOOK_SECRET || "local-test-secret";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const companies = testCompanies(admin);
let a = "";
let b = "";

beforeAll(async () => {
  a = (await companies.add("Vapi A")).id;
  b = (await companies.add("Vapi B")).id;
});

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

async function post(org: string, message: Record<string, unknown>) {
  const res = await app.fetch(
    new Request(`http://localhost/webhooks/vapi/${org}`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-vapi-secret": SECRET,
      }),
      body: JSON.stringify({ message }),
    }),
  );
  expect(res.status).toBe(202);
}

const said = (callId: string, id: string, transcript: string) => ({
  type: "transcript",
  id,
  call: { id: callId },
  timestamp: "2026-10-11T10:00:01Z",
  role: "user",
  transcript,
});

/** The company's events for the call, and what its conversation for that call holds. */
async function filed(org: string, callId: string) {
  const events = await admin.query<{ status: string; error: string | null }>(
    `select status, error from webhook_events
      where org_id = $1 and payload -> 'message' -> 'call' ->> 'id' = $2 order by id`,
    [org, callId],
  );
  const convo = await admin.query<{ status: string; lines: string[] }>(
    `select c.status, array_agg(m.content order by m.seq) filter (where m.id is not null) as lines
       from conversations c left join messages m on m.conversation_id = c.id
      where c.org_id = $1 and c.provider = 'vapi' and c.provider_ref = $2 group by c.id`,
    [org, callId],
  );
  return { events: events.rows, conversations: convo.rows };
}

describe("two companies' call events", () => {
  it("with the same event id are each stored and filed in their own company", async () => {
    const callId = `call-${randomUUID()}`;
    await post(a, said(callId, `${callId}-t1`, "Haan, Whitefield chahiye"));
    await post(b, said(callId, `${callId}-t1`, "Yes, near the tech park"));
    await processVapiEvents(pool, a);
    await processVapiEvents(pool, b);
    expect(await filed(a, callId)).toEqual({
      events: [{ status: "processed", error: null }],
      conversations: [
        { status: "active", lines: ["Haan, Whitefield chahiye"] },
      ],
    });
    expect(await filed(b, callId)).toEqual({
      events: [{ status: "processed", error: null }],
      conversations: [{ status: "active", lines: ["Yes, near the tech park"] }],
    });
  });

  it("with the same call id get a conversation each, and the second company's events are filed", async () => {
    const callId = `call-${randomUUID()}`;
    await post(a, said(callId, `${callId}-a1`, "Budget is 90 lakhs"));
    await processVapiEvents(pool, a);
    await post(b, said(callId, `${callId}-b1`, "Call me after Diwali"));
    await processVapiEvents(pool, b);
    expect((await filed(a, callId)).conversations).toEqual([
      { status: "active", lines: ["Budget is 90 lakhs"] },
    ]);
    expect(await filed(b, callId)).toEqual({
      events: [{ status: "processed", error: null }],
      conversations: [{ status: "active", lines: ["Call me after Diwali"] }],
    });
  });
});

describe("one call event that can't be filed", () => {
  it("is marked failed with its reason, and the company's other events are filed", async () => {
    const callId = `call-${randomUUID()}`;
    // Its timestamp names no real time, and sorts first, so it is filed before the others.
    await post(a, {
      type: "status-update",
      id: `${callId}-bad`,
      call: { id: callId },
      timestamp: "1970-13-45T99:99:99Z",
    });
    await post(a, said(callId, `${callId}-t1`, "Sunday evening works"));
    await post(a, {
      type: "end-of-call-report",
      id: `${callId}-end`,
      call: { id: callId },
      timestamp: "2026-10-11T10:05:00Z",
      summary: "Wants a site visit on Sunday evening.",
    });
    await processVapiEvents(pool, a);
    const { events, conversations } = await filed(a, callId);
    expect(events.map((e) => e.status)).toEqual([
      "failed",
      "processed",
      "processed",
    ]);
    expect(events[0]?.error).toContain("1970-13-45T99:99:99Z");
    expect(conversations).toEqual([
      { status: "completed", lines: ["Sunday evening works"] },
    ]);
  });
});

/**
 * Files a company's second line of a call while the database fails under it: another session holds the call's
 * conversation, so the run waits on it inside the event, and then `stop` (pg_terminate_backend ends the run's
 * connection, pg_cancel_backend cancels its statement) is called on the waiting run. The whole job must fail,
 * mark nothing failed, and leave the line to the next run, which files it.
 */
async function databaseFailsMidEvent(
  stop: "pg_terminate_backend" | "pg_cancel_backend",
) {
  const callId = `call-${randomUUID()}`;
  await post(a, said(callId, `${callId}-t1`, "Haan ji"));
  await processVapiEvents(pool, a);
  await post(a, said(callId, `${callId}-t2`, "Saturday at 11"));
  const holder = await admin.connect();
  try {
    await holder.query("begin");
    await holder.query(
      `select 1 from conversations where org_id = $1 and provider_ref = $2 for update`,
      [a, callId],
    );
    const { pid } = (
      await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
    ).rows[0] ?? { pid: 0 };
    const run = processVapiEvents(pool, a).then(
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
    await admin.query(`select ${stop}($1)`, [waiting[0]]);
    expect(await run).toStartWith("failed: ");
  } finally {
    await holder.query("rollback");
    holder.release();
  }
  expect((await filed(a, callId)).events.map((e) => e.status)).toEqual([
    "processed",
    "received",
  ]);
  await processVapiEvents(pool, a);
  expect(await filed(a, callId)).toEqual({
    events: [
      { status: "processed", error: null },
      { status: "processed", error: null },
    ],
    conversations: [{ status: "active", lines: ["Haan ji", "Saturday at 11"] }],
  });
}

describe("a database failure while an event is filed, which is no event's fault", () => {
  // behaviour already on main: a lost connection always failed the whole job; this shows filing each event on its own keeps that
  it("a lost connection fails the whole job, marks nothing failed, and the next run files every event", async () => {
    await databaseFailsMidEvent("pg_terminate_backend");
  });

  // behaviour already on main: main's one transaction failed the whole job on any error; this shows filing each event on its own still leaves a database failure to the next run
  it("a cancelled statement fails the whole job, marks nothing failed, and the next run files every event", async () => {
    await databaseFailsMidEvent("pg_cancel_backend");
  });
});
