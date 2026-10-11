// Call events through the Vapi webhook (the receiver, then the processor the job runs) when two companies' events
// share an event id or a call id, and when one event can't be filed (ROADMAP.md, Slice 1): each company's events
// are its own, so neither is dropped as the other's duplicate nor filed on the other's conversation, and a bad event
// is marked failed with its reason while the company's other events are filed.
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
  max: 1,
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
