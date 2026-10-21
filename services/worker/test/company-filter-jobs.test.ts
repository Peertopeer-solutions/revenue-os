// The worker's jobs filter every query by the company the job is for, the second fence AGENTS.md asks for on top of
// the database's own per-company rules. These tests take those rules out of the way: the pool logs in as the local
// `postgres` user, which bypasses them, so a query that leaves out org_id reaches company B's rows from a job for
// company A. Shared template agents and sequences (org_id null) stay readable to every company. The guard and the
// senders are spies, so no stray guardrail setting decides a result, and no scenario queues a job: this login can't
// write pg-boss's queue.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { withOrg } from "@revenue-os/db";
import { type LlmProvider, ToolRegistry } from "@revenue-os/harness";
import pg from "pg";
import { putLive } from "../../../tests/live-version";
import { testCompanies } from "../../../tests/test-companies";
import { handleAgentTurn } from "../src/handlers/agent-turn";
import {
  handlePlaceCall,
  type PlaceCallDeps,
} from "../src/handlers/place-call";
import { handleSendWa, type SendWaDeps } from "../src/handlers/send-wa";
import { startRun } from "../src/runs";
import { tick } from "../src/scheduler";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});
const companies = testCompanies(admin);
const templates: { agents: string[]; workflows: string[] } = {
  agents: [],
  workflows: [],
};
const phone = () => `+9198${String(Math.random()).slice(2, 10)}`;
const [phoneA, phoneB] = [phone(), phone()];
const keyB = `only-b-${randomUUID()}`; // an active agent key only company B holds
/** The key prefix of every shared template this file makes, so a later run can find the ones a killed run left. */
const TEMPLATE = "test-template-";
const keyTemplate = `${TEMPLATE}${randomUUID()}`; // a key only a shared template agent holds
let [a, b, leadA, leadB, agentB, templateAgent] = ["", "", "", "", "", ""];
let [callB, callTemplate, endTemplate, sequenceB] = ["", "", "", ""];

const id = async (sql: string, values: unknown[]) =>
  String((await admin.query<{ id: string }>(sql, values)).rows[0]?.id);

const callSequence = (agent: string) => ({
  entry: "c",
  steps: {
    c: { kind: "call", agent, on: { completed: "end" } },
    end: { kind: "end" },
  },
});

async function lead(org: string, number: string): Promise<string> {
  const contact = await id(
    `insert into contacts (org_id, first_name) values ($1, 'Asha') returning id`,
    [org],
  );
  await admin.query(
    `insert into contact_identities (org_id, contact_id, kind, value, is_primary)
     values ($1, $2, 'whatsapp', $3, true)`,
    [org, contact, number],
  );
  return contact;
}

// A live version: a shared template's run belongs to company A, whose clean-up deletes it.
const agent = (org: string | null, key: string) =>
  putLive(admin, org, { key, systemPrompt: "You book site visits." }, org ?? a);

const sequence = (org: string | null, definition: unknown) =>
  id(
    `insert into workflows (org_id, key, version, status, definition)
     values ($1, $2, 1, 'active', $3::jsonb) returning id`,
    [
      org,
      `${org ? "wf-" : TEMPLATE}${randomUUID()}`,
      JSON.stringify(definition),
    ],
  );

/** A waiting run, due at `wakeAt` (never, by default, so no scheduler picks it up). A lead can be in the same
 *  sequence only once at a time (migration 025), so an earlier test's open run of this lead and sequence ends first. */
const run = async (
  org: string,
  workflow: string,
  contact: string,
  step: string,
  wakeAt: Date | null = null,
) => {
  await admin.query(
    `update workflow_runs set status = 'canceled'
      where org_id = $1 and workflow_id = $2 and contact_id = $3 and status in ('pending', 'running', 'waiting')`,
    [org, workflow, contact],
  );
  return id(
    `insert into workflow_runs (org_id, workflow_id, contact_id, status, current_step, state, wake_at)
     values ($1, $2, $3, 'waiting', $4, $5::jsonb, $6) returning id`,
    [
      org,
      workflow,
      contact,
      step,
      JSON.stringify({ contactId: contact }),
      wakeAt,
    ],
  );
};

/** A conversation whose lead's last message is still unanswered. */
async function conversation(org: string, contact: string, agentId: string) {
  const convo = await id(
    `insert into conversations (org_id, contact_id, agent_id, channel, direction, status)
     values ($1, $2, $3, 'whatsapp', 'inbound', 'active') returning id`,
    [org, contact, agentId],
  );
  await admin.query(
    `insert into messages (org_id, conversation_id, seq, role, content)
     values ($1, $2, 1, 'contact', 'Is Sunday free for a visit?')`,
    [org, convo],
  );
  return convo;
}

const roles = async (conversationId: string) =>
  (
    await admin.query<{ role: string }>(
      `select role from messages where conversation_id = $1 order by seq`,
      [conversationId],
    )
  ).rows.map((r) => r.role);

const runRow = async (runId: string) =>
  (
    await admin.query(
      `select org_id, status, current_step, state from workflow_runs where id = $1`,
      [runId],
    )
  ).rows[0];

/** A model that answers with one line of text and counts how often it was asked. */
function model() {
  const calls = { n: 0 };
  const provider: LlmProvider = {
    complete: async () => {
      calls.n += 1;
      return { text: "Sunday works.", usage: { in: 1, out: 1 } };
    },
  };
  return { calls, provider };
}

const callDeps = (sent: string[]): PlaceCallDeps => ({
  pool: admin,
  guard: async () => ({ ok: true }),
  sender: {
    place: async ({ to }) => {
      sent.push(to);
      return { providerRef: `call-${randomUUID()}` };
    },
  },
  provider: model().provider,
  registry: new ToolRegistry(),
  outcome: async () => "completed",
});

const waDeps = (sent: string[]): SendWaDeps => ({
  pool: admin,
  guard: async () => ({ ok: true }),
  sender: {
    send: async ({ to }) => {
      sent.push(to);
      return { providerRef: `wamid-${randomUUID()}` };
    },
  },
});

beforeAll(async () => {
  // A killed run never reaches afterAll and leaves its shared templates where every company sees them: delete this
  // file's own that are over an hour old (a run going on now made its own minutes ago). One that a leaked company's
  // rows still use can't be deleted and stays.
  for (const table of ["agents", "workflows"]) {
    const stale = await admin.query<{ id: string }>(
      `select id from ${table} where org_id is null and key like $1 and created_at < now() - interval '1 hour'`,
      [`${TEMPLATE}%`],
    );
    for (const row of stale.rows)
      await admin
        .query(`delete from ${table} where id = $1`, [row.id])
        .catch((e: { code?: string }) => {
          if (e.code !== "23503") throw e; // 23503: a row still points at it, so it stays
        });
  }
  a = (await companies.add("Fence A")).id;
  b = (await companies.add("Fence B")).id;
  [leadA, leadB] = [await lead(a, phoneA), await lead(b, phoneB)];
  agentB = await agent(b, keyB);
  templateAgent = await agent(null, keyTemplate);
  templates.agents.push(templateAgent);
  callB = await sequence(null, callSequence(keyB));
  callTemplate = await sequence(null, callSequence(keyTemplate));
  endTemplate = await sequence(null, {
    entry: "end",
    steps: { end: { kind: "end" } },
  });
  templates.workflows.push(callB, callTemplate, endTemplate);
  sequenceB = await sequence(b, callSequence(keyB));
  // With the rules really off, company A's session sees company B's rows; without that, every test here would pass
  // for the wrong reason.
  const seen = await withOrg(admin, a, async (tx) => {
    const r = await tx.query<{ n: number }>(
      `select count(*)::int as n from contacts where org_id = $1`,
      [b],
    );
    return r.rows[0]?.n ?? 0;
  });
  if (seen < 1)
    throw new Error(
      "the postgres login no longer bypasses the per-company rules, so these tests would prove nothing",
    );
}, 30_000);

afterAll(async () => {
  try {
    await companies.cleanup();
    await admin.query(`delete from agents where id = any($1::uuid[])`, [
      templates.agents,
    ]);
    await admin.query(`delete from workflows where id = any($1::uuid[])`, [
      templates.workflows,
    ]);
  } finally {
    await admin.end();
  }
});

describe("the worker's jobs with the per-company rules off", () => {
  it("agent turn: a job for company A naming company B's conversation does nothing; A's conversation on a shared template agent still gets its turn", async () => {
    const theirs = await conversation(b, leadB, agentB);
    const ours = await conversation(a, leadA, templateAgent);
    const { calls, provider } = model();
    const deps = { pool: admin, provider, registry: new ToolRegistry() };
    const job = (conversationId: string) => ({
      orgId: a,
      runId: randomUUID(),
      action: { kind: "run_agent_turn" as const, conversationId },
    });

    await expect(handleAgentTurn(deps, job(theirs))).resolves.toBeUndefined();
    expect(calls.n).toBe(0);
    expect(await roles(theirs)).toEqual(["contact"]);

    await handleAgentTurn(deps, job(ours));
    expect(calls.n).toBe(1);
    expect(await roles(ours)).toEqual(["contact", "agent"]);
  });

  it("place call: a job for company A naming company B's run places no call and leaves the run as it was", async () => {
    // B's run sits on the shared template sequence and the job names the template agent, both of which company A may
    // read, so the run's own company filter is the only thing that stops this job.
    const theirs = await run(b, callTemplate, leadB, "c");
    const sent: string[] = [];
    await expect(
      handlePlaceCall(callDeps(sent), {
        orgId: a,
        runId: theirs,
        action: { kind: "place_call", contactId: leadB, agentKey: keyTemplate },
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(await runRow(theirs)).toMatchObject({
      org_id: b,
      status: "waiting",
      state: { contactId: leadB },
    });
  });

  it("place call: an agent key only company B holds places no call for company A; a shared template agent's key places one", async () => {
    const onBKey = await run(a, callB, leadA, "c");
    const onTemplateKey = await run(a, callTemplate, leadA, "c");
    const sent: string[] = [];
    const deps = callDeps(sent);
    await expect(
      handlePlaceCall(deps, {
        orgId: a,
        runId: onBKey,
        action: { kind: "place_call", contactId: leadA, agentKey: keyB },
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);

    await handlePlaceCall(deps, {
      orgId: a,
      runId: onTemplateKey,
      action: { kind: "place_call", contactId: leadA, agentKey: keyTemplate },
    });
    expect(sent).toEqual([phoneA]);
    const calls = await admin.query(
      `select org_id, agent_id from conversations where workflow_run_id = $1`,
      [onTemplateKey],
    );
    expect(calls.rows).toEqual([{ org_id: a, agent_id: templateAgent }]);
    expect(await runRow(onTemplateKey)).toMatchObject({
      status: "waiting",
      state: { lastDisposition: "completed" },
    });
  });

  it("send WhatsApp: a job for company A naming company B's run sends nothing", async () => {
    const theirs = await run(b, sequenceB, leadB, "end");
    const sent: string[] = [];
    await expect(
      handleSendWa(waDeps(sent), {
        orgId: a,
        runId: theirs,
        step: "w",
        idx: 0,
        action: {
          kind: "send_wa",
          contactId: leadB,
          template: "visit_reminder",
          vars: {},
        },
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("place call and send WhatsApp: company B's lead's number never reaches the sender of a job for company A; A's own lead's does", async () => {
    const ours = await run(a, callTemplate, leadA, "c");
    const sent: string[] = [];
    const message = (contactId: string, idx: number) =>
      handleSendWa(waDeps(sent), {
        orgId: a,
        runId: ours,
        step: "w",
        idx,
        action: {
          kind: "send_wa",
          contactId,
          template: "visit_reminder",
          vars: {},
        },
      });
    // Company A can't record a conversation with B's lead, so both of these jobs fail after the send; what matters
    // here is which number the sender was handed.
    await handlePlaceCall(callDeps(sent), {
      orgId: a,
      runId: ours,
      action: { kind: "place_call", contactId: leadB, agentKey: keyTemplate },
    }).catch(() => undefined);
    await message(leadB, 0).catch(() => undefined);
    expect(sent).not.toContain(phoneB);

    await message(leadA, 1);
    expect(sent.at(-1)).toBe(phoneA);
  });

  it("scheduler tick: company A's due run on a shared template sequence completes; company B's due run is not touched", async () => {
    // 1900 is before every run but this test's own, so even a scan that leaves out the company reaches only these.
    const due = new Date("1899-12-31T00:00:00Z");
    const ours = await run(a, endTemplate, leadA, "end", due);
    const theirs = await run(b, sequenceB, leadB, "end", due);
    expect(
      await tick(admin, a, { now: new Date("1900-01-01T00:00:00Z") }),
    ).toEqual({ processed: 1 });
    expect((await runRow(ours)).status).toBe("completed");
    expect((await runRow(theirs)).status).toBe("waiting");
  });

  it("enrolment: company A starts a run on a shared template sequence, but not on company B's sequence", async () => {
    const started = await startRun(admin, a, {
      workflowId: endTemplate,
      contactId: leadA,
    });
    expect(await runRow(started)).toMatchObject({
      org_id: a,
      status: "pending",
      current_step: "end",
    });
    await expect(
      startRun(admin, a, { workflowId: sequenceB, contactId: leadA }),
    ).rejects.toThrow(/workflow not found/);
  });
});
