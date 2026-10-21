// A turn plays its role from the version row alone (ROADMAP.md: "A role is rows, never code"): the live version read
// by liveVersion and handed to runTurn through versionDeps sets the model asked, the prompt and goal it reads, what
// its booking tool books and records, and which of its tools need a person's approval. Two roles that differ only in
// rows behave differently with no change to the engine. Against the real local database (app_service, withOrg).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  addMessage,
  createPool,
  liveVersion,
  openConversation,
  withOrg,
} from "@revenue-os/db";
import pg from "pg";
import { putLive } from "../../../tests/live-version";
import { testCompanies } from "../../../tests/test-companies";
import { runTurn, versionDeps } from "../src/loop";
import { buildCatalog } from "../src/tools";
import type { LlmProvider, LlmTurn } from "../src/types";

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
let org = "";

beforeAll(async () => {
  org = (await companies.add("Role turn")).id;
});
afterAll(async () => {
  await companies.cleanup();
  await app.end();
  await admin.end();
});

/** A lead with one message, on a conversation of its own; the lead's and the conversation's ids. */
async function leadSaying(text: string) {
  const lead = (
    await admin.query<{ id: string }>(
      `insert into contacts (org_id, first_name) values ($1, 'Nisha') returning id`,
      [org],
    )
  ).rows[0]?.id as string;
  const conversation = await withOrg(app, org, async (tx) => {
    const id = await openConversation(tx, org, {
      channel: "whatsapp",
      direction: "inbound",
      contactId: lead,
    });
    await addMessage(tx, org, id, { role: "contact", content: text });
    return id;
  });
  return { lead, conversation };
}

/** A model that books on its first round, then closes; it records what each round was asked with. */
function booking(lead: string) {
  const asked: { model: string; system: string }[] = [];
  const turns: LlmTurn[] = [
    {
      toolCalls: [
        {
          name: "book_appointment",
          args: {
            contactId: lead,
            startsAt: "2030-01-05T10:00:00.000Z",
            endsAt: "2030-01-05T11:00:00.000Z",
            timezone: "Asia/Kolkata",
          },
        },
      ],
      usage: { in: 10, out: 4 },
    },
    { text: "Booked.", usage: { in: 12, out: 2 } },
  ];
  const provider: LlmProvider = {
    complete: async (req) => {
      asked.push({ model: req.model, system: req.system });
      return turns[Math.min(asked.length - 1, 1)] as LlmTurn;
    },
  };
  return { asked, provider };
}

async function playLive(
  key: string,
  conversation: string,
  provider: LlmProvider,
) {
  const version = await withOrg(app, org, (tx) => liveVersion(tx, org, key));
  if (!version) throw new Error(`no live version of ${key}`);
  await runTurn(
    {
      provider,
      registry: buildCatalog({ send: async () => ({ ok: true }) }),
      ...versionDeps(version),
    },
    {
      orgId: org,
      inTransaction: (work) =>
        withOrg(app, org, (tx) => work({ orgId: org, db: tx })),
    },
    conversation,
  );
  return version.id;
}

describe("a turn plays its role from the version row", () => {
  it("asks the version's model with its prompt and goal, books its kind under its outcome, and names the version on its usage rows", async () => {
    const id = await putLive(admin, org, {
      key: "visits",
      model: "anthropic:claude-opus-5-5",
      systemPrompt: "You book showroom visits.",
      goal: "Every interested buyer books a visit.",
      toolsAllowed: ["book_appointment"],
      rules: {
        outcomes: ["showroom_visit_booked"],
        booking: { kind: "showroom_visit", outcome: "showroom_visit_booked" },
      },
    });
    const { lead, conversation } = await leadSaying("Can I come on Saturday?");
    const { asked, provider } = booking(lead);
    await playLive("visits", conversation, provider);
    expect(asked.map((a) => a.model)).toEqual([
      "anthropic:claude-opus-5-5",
      "anthropic:claude-opus-5-5",
    ]);
    expect(asked[0]?.system).toStartWith(
      "You book showroom visits.\n\nYour goal: Every interested buyer books a visit.",
    );
    const booked = await admin.query(
      `select a.kind as appointment, o.kind as outcome from appointments a join outcomes o on o.appointment_id = a.id
        where a.org_id = $1 and a.contact_id = $2`,
      [org, lead],
    );
    expect(booked.rows).toEqual([
      { appointment: "showroom_visit", outcome: "showroom_visit_booked" },
    ]);
    const usage = await admin.query(
      `select distinct meta ->> 'version' as version from usage_events where org_id = $1 and conversation_id = $2`,
      [org, conversation],
    );
    expect(usage.rows).toEqual([{ version: id }]);
  });

  it("makes the same tool call a task for a person when the role's rules say it needs approval, booking nothing", async () => {
    await putLive(admin, org, {
      key: "careful",
      toolsAllowed: ["book_appointment"],
      rules: {
        approval: { book_appointment: "approval" },
        outcomes: ["meeting_booked"],
        booking: { kind: "meeting", outcome: "meeting_booked" },
      },
    });
    const { lead, conversation } = await leadSaying("Book me in, please.");
    await playLive("careful", conversation, booking(lead).provider);
    const tasks = await admin.query(
      `select kind, title from tasks where org_id = $1 and contact_id = $2`,
      [org, lead],
    );
    expect(tasks.rows).toEqual([
      { kind: "approval", title: "Approve: book_appointment" },
    ]);
    const booked = await admin.query(
      `select 1 from appointments where org_id = $1 and contact_id = $2`,
      [org, lead],
    );
    expect(booked.rowCount).toBe(0);
  });

  it("refuses the booking tool, writing nothing, for a role whose rules name no booking", async () => {
    await putLive(admin, org, {
      key: "talker",
      toolsAllowed: ["book_appointment"],
    });
    const { lead, conversation } = await leadSaying("Book me in.");
    await playLive("talker", conversation, booking(lead).provider);
    const call = await admin.query(
      `select tool_call -> 'result' as result from messages
        where org_id = $1 and conversation_id = $2 and role = 'tool'`,
      [org, conversation],
    );
    expect(call.rows).toEqual([
      { result: { ok: false, error: "no_booking_rule" } },
    ]);
    const booked = await admin.query(
      `select 1 from appointments where org_id = $1 and contact_id = $2`,
      [org, lead],
    );
    expect(booked.rowCount).toBe(0);
  });
});
