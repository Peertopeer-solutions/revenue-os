// Every query the AI engine runs also filters by company (ROADMAP.md, Slice 1): the second fence on top of the
// database's own per-company rules. Most cases run the real code on the local `postgres` login, which skips those
// rules, so a query that leaves out the company filter reaches company B's rows from company A's turn. The last two
// run on the product's own login (app_service).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPool, withOrg } from "@revenue-os/db";
import pg from "pg";
import { z } from "zod";
import { testCompanies } from "../../../tests/test-companies";
import { assembleContext, runTurn, ToolRegistry } from "../src";
import { attemptCapHook } from "../src/policies/attempt-cap";
import { quietHoursHook } from "../src/policies/calling-hours";
import { dncHook } from "../src/policies/do-not-call";
import { updateContact } from "../src/tools/update-contact";
import type { GuardedAction, LlmTurn, OrgCtx, PolicyHook } from "../src/types";

const admin = new pg.Pool({
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
let a = "";
let b = "";
let ourLead = "";
let theirLead = "";
let ourConversation = "";
let theirConversation = "";

/** 12:00 in Asia/Kolkata, the time zone of both leads. */
const NOW = new Date("2026-01-01T06:30:00Z");
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60_000).toISOString();

const one = async (sql: string, values: unknown[]) =>
  String((await admin.query<{ id: string }>(sql, values)).rows[0]?.id);
const nameOf = async (contactId: string) =>
  (
    await admin.query<{ first_name: string }>(
      `select first_name from contacts where id = $1`,
      [contactId],
    )
  ).rows[0]?.first_name;

/** A lead with a conversation holding one message from them, and a run whose WhatsApp sends are `sent`. */
async function lead(org: string, name: string, sent: string[]) {
  const id = await one(
    `insert into contacts (org_id, first_name, timezone) values ($1, $2, 'Asia/Kolkata') returning id`,
    [org, name],
  );
  const conversation = await one(
    `insert into conversations (org_id, contact_id, channel, direction, status)
     values ($1, $2, 'whatsapp', 'inbound', 'active') returning id`,
    [org, id],
  );
  await admin.query(
    `insert into messages (org_id, conversation_id, seq, role, content) values ($1, $2, 1, 'contact', $3)`,
    [org, conversation, `Hi, this is ${name}`],
  );
  const workflow = await one(
    `insert into workflows (org_id, key, status, definition) values ($1, 'wf', 'active', '{}') returning id`,
    [org],
  );
  await admin.query(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status, attempts)
     values ($1, $2, $3, 'completed', $4)`,
    [org, workflow, id, JSON.stringify({ whatsapp: sent })],
  );
  return { id, conversation };
}

beforeAll(async () => {
  a = (await companies.add("Engine filter A")).id;
  b = (await companies.add("Engine filter B")).id;
  // A's lead was sent one WhatsApp message an hour ago; B's lead ten in the last five minutes.
  ({ id: ourLead, conversation: ourConversation } = await lead(a, "Asha", [
    minutesAgo(60),
  ]));
  ({ id: theirLead, conversation: theirConversation } = await lead(
    b,
    "Rohan",
    Array(10).fill(minutesAgo(5)),
  ));
  await admin.query(
    `insert into contact_memories (org_id, contact_id, kind, content) values ($1, $2, 'summary', 'Wants a 3BHK near the metro')`,
    [b, theirLead],
  );
  // A's own rules: quiet all day in the lead's time zone, one WhatsApp message a day.
  await admin.query(
    `insert into guardrail_policies (org_id, key, config) values ($1, 'quiet_hours', $2), ($1, 'attempt_caps', $3)`,
    [
      a,
      JSON.stringify({ start: "00:00", end: "23:59", tz: "contact" }),
      JSON.stringify({ whatsapp: { max: 1, per_hours: 24 } }),
    ],
  );
  const seen = await withOrg(admin, a, (tx) =>
    tx.query(`select count(*)::int as n from contacts where org_id = $1`, [b]),
  );
  if (seen.rows[0]?.n !== 1)
    throw new Error(
      "the postgres login no longer skips the per-company rules, so these tests would prove nothing",
    );
});

afterAll(async () => {
  await companies.cleanup();
  await Promise.all([admin.end(), appService.end()]);
});

describe("the guard checks, run for company A, read only company A's rows", () => {
  const send = (contactId: string): GuardedAction => ({
    kind: "tool",
    toolName: "send_confirmation",
    autonomy: "auto",
    channel: "whatsapp",
    contactId,
  });
  const check = (
    hook: PolicyHook,
    contactId: string,
    onGuardEvent?: OrgCtx["onGuardEvent"],
  ) =>
    withOrg(admin, a, (tx) =>
      hook({ orgId: a, db: tx, now: () => NOW, onGuardEvent }, send(contactId)),
    );

  it("do-not-call refuses another company's lead, whose consent it cannot see, and lets its own lead through", async () => {
    expect(await check(dncHook, theirLead)).toEqual({
      ok: false,
      reason: "dnc",
    });
    expect(await check(dncHook, ourLead)).toBeNull();
  });

  it("calling hours hold its own lead under its own rule, and find no time zone for another company's lead", async () => {
    expect(await check(quietHoursHook, ourLead)).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
    const events: unknown[] = [];
    expect(
      await check(quietHoursHook, theirLead, (e) => events.push(e)),
    ).toBeNull();
    expect(events).toEqual([
      { hook: "quiet_hours", reason: "unresolved_contact_tz" },
    ]);
  });

  it("the attempt limit counts its own lead's sends under its own rule, never another company's lead's", async () => {
    expect(await check(attemptCapHook, ourLead)).toEqual({
      ok: false,
      reason: "attempt_cap",
    });
    expect(await check(attemptCapHook, theirLead)).toBeNull();
  });
});

describe("the AI's prompt", () => {
  it("built for company A from another company's conversation holds none of its messages or memories", async () => {
    const prompt = (org: string) =>
      withOrg(admin, org, (tx) =>
        assembleContext({ orgId: org, db: tx }, theirConversation, "base"),
      );
    const theirs = await prompt(b);
    expect(theirs.messages).toEqual([
      { role: "contact", content: "Hi, this is Rohan" },
    ]);
    expect(theirs.system).toContain("Wants a 3BHK near the metro");
    expect(await prompt(a)).toEqual({ system: "base", messages: [] });
  });
});

describe("the AI's update_contact tool", () => {
  const rename = (pool: pg.Pool, contactId: string, firstName: string) =>
    withOrg(pool, a, (tx) =>
      updateContact.execute({ orgId: a, db: tx }, { contactId, firstName }),
    );

  it("renames only its own company's lead, and reports another company's lead as not found", async () => {
    expect(await rename(admin, theirLead, "Hacked")).toEqual({
      ok: false,
      error: "contact_not_found",
    });
    expect(await nameOf(theirLead)).toBe("Rohan");
    // Setting the same name again still matches the lead, so it still counts as done.
    for (let i = 0; i < 2; i++)
      expect(await rename(admin, ourLead, "Asha Rao")).toEqual({
        ok: true,
        data: null,
      });
    expect(await nameOf(ourLead)).toBe("Asha Rao");
  });

  it("on the product's own login, reports an id that names no lead as not found", async () => {
    expect(await rename(appService, randomUUID(), "Ghost")).toEqual({
      ok: false,
      error: "contact_not_found",
    });
  });

  // behaviour already on main: main's update never wrote a name the AI left out either; this holds the new fixed statement's coalesce to that
  it("on the product's own login, keeps the name the AI leaves out", async () => {
    const id = await one(
      `insert into contacts (org_id, first_name, last_name) values ($1, 'Meera', 'Shah') returning id`,
      [a],
    );
    const update = (names: { firstName?: string; lastName?: string }) =>
      withOrg(appService, a, (tx) =>
        updateContact.execute(
          { orgId: a, db: tx },
          { contactId: id, ...names },
        ),
      );
    const names = async () =>
      (
        await admin.query(
          `select first_name, last_name from contacts where id = $1`,
          [id],
        )
      ).rows[0];
    expect(await update({ firstName: "Mira" })).toEqual({
      ok: true,
      data: null,
    });
    expect(await names()).toEqual({ first_name: "Mira", last_name: "Shah" });
    expect(await update({ lastName: "Rao" })).toEqual({ ok: true, data: null });
    expect(await names()).toEqual({ first_name: "Mira", last_name: "Rao" });
  });
});

describe("the AI's turn", () => {
  // behaviour already on main: the conversation's own lead was found before the filter too; this is the only real-database test that runs conversationContactId, so removing either of its new lines fails a test
  it("hands the guard its conversation's own lead when a send names no lead", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "nudge",
      description: "Send the lead a WhatsApp nudge.",
      schema: z.object({ channel: z.literal("whatsapp") }).strict(),
      autonomy: "auto",
      execute: async () => ({ ok: true, data: null }),
    });
    const turns: LlmTurn[] = [
      {
        toolCalls: [{ name: "nudge", args: { channel: "whatsapp" } }],
        usage: { in: 1, out: 1 },
      },
      { text: "Sent.", usage: { in: 1, out: 1 } },
    ];
    const seen: GuardedAction[] = [];
    await withOrg(appService, a, (tx) =>
      runTurn(
        {
          provider: {
            complete: async () => turns.shift() ?? { usage: { in: 0, out: 0 } },
          },
          registry,
          toolsAllowed: ["nudge"],
          systemPrompt: "t",
          pipeline: [
            async (_ctx, action) => {
              seen.push(action);
              return null;
            },
          ],
        },
        { orgId: a, db: tx },
        ourConversation,
      ),
    );
    expect(seen.map((action) => action.contactId)).toEqual([ourLead]);
  });
});
