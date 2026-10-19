// The WhatsApp opt-in check (whatsappOptInHook, src/policies/whatsapp-opt-in.ts) on its own and in guard()'s pipeline:
// a WhatsApp send goes only to a lead whose recorded opt-in says opted_in and names where it came from; a missing,
// withdrawn, malformed or unreadable opt-in, or a lead it can't find, refuses it. Calls and plain tools are not WhatsApp
// messages, so it lets them through without reading anything. The database here is a fake that answers the contacts
// query; services/worker/test/whatsapp-opt-in.test.ts shows the same refusal on the real local database.
import { describe, expect, it } from "bun:test";
import * as policies from "../src/policies";
import type { GuardedAction, OrgCtx } from "../src/types";

const OPTED_IN = {
  status: "opted_in",
  source: "website form",
  at: "2026-10-18T10:00:00Z",
};
const REFUSED = { ok: false, reason: "no_whatsapp_optin" };

/** A company whose database answers the contacts query with `rows` (or throws), recording what was asked. */
function company(rows: Record<string, unknown>[], fails = false) {
  const asked: { text: string; values?: unknown[] }[] = [];
  const ctx: OrgCtx = {
    orgId: "org-1",
    db: {
      query: async (text, values) => {
        asked.push({ text, values });
        if (fails) throw new Error("connection lost");
        return /from contacts/.test(text)
          ? { rows, rowCount: rows.length }
          : { rows: [], rowCount: 0 };
      },
    },
  };
  return { ctx, asked };
}

const lead = (whatsapp_optin: unknown, dnc = false) => [
  { consent: { dnc, whatsapp_optin } },
];

const send = (over: Partial<GuardedAction> = {}): GuardedAction => ({
  kind: "tool",
  toolName: "send_wa",
  autonomy: "auto",
  contactId: "c1",
  channel: "whatsapp",
  ...over,
});

describe("the WhatsApp opt-in check", () => {
  it("lets a WhatsApp message through to the company's lead whose opt-in is recorded, with where it came from", async () => {
    const { ctx, asked } = company(lead(OPTED_IN));
    expect(await policies.whatsappOptInHook(ctx, send())).toBeNull();
    expect(asked).toEqual([
      {
        text: "select consent from contacts where id = $1 and org_id = $2 limit 1",
        values: ["c1", "org-1"],
      },
    ]);
  });

  it("refuses a WhatsApp message to a lead with no opt-in recorded, whether the field is empty or missing", async () => {
    for (const rows of [lead(null), [{ consent: { dnc: false } }], [{}]])
      expect(
        await policies.whatsappOptInHook(company(rows).ctx, send()),
      ).toEqual(REFUSED);
  });

  it("refuses a WhatsApp message to a lead who withdrew their opt-in", async () => {
    const withdrawn = { ...OPTED_IN, status: "withdrawn" };
    expect(
      await policies.whatsappOptInHook(company(lead(withdrawn)).ctx, send()),
    ).toEqual(REFUSED);
  });

  it("refuses a WhatsApp message when the opt-in is malformed: no source, an empty source, another status, or not a record", async () => {
    const malformed = [
      { status: "opted_in", at: OPTED_IN.at },
      { ...OPTED_IN, source: "" },
      { ...OPTED_IN, source: 42 },
      { ...OPTED_IN, status: "yes" },
      "opted_in",
      true,
    ];
    for (const optIn of malformed)
      expect(
        await policies.whatsappOptInHook(company(lead(optIn)).ctx, send()),
      ).toEqual(REFUSED);
  });

  it("refuses a WhatsApp message to a lead it can't find, or when the send names no lead at all", async () => {
    expect(await policies.whatsappOptInHook(company([]).ctx, send())).toEqual(
      REFUSED,
    );
    const { ctx, asked } = company(lead(OPTED_IN));
    expect(
      await policies.whatsappOptInHook(ctx, send({ contactId: undefined })),
    ).toEqual(REFUSED);
    expect(asked).toEqual([]);
  });

  it("refuses a WhatsApp message when the lead's opt-in can't be read", async () => {
    expect(
      await policies.whatsappOptInHook(
        company(lead(OPTED_IN), true).ctx,
        send(),
      ),
    ).toEqual(REFUSED);
  });

  it("lets a call and a plain tool through without reading anything, as neither is a WhatsApp message", async () => {
    const { ctx, asked } = company(lead(null), true);
    expect(
      await policies.whatsappOptInHook(ctx, send({ channel: "voice" })),
    ).toBeNull();
    expect(
      await policies.whatsappOptInHook(ctx, send({ channel: undefined })),
    ).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("guard() with the WhatsApp opt-in check", () => {
  it("runs it after do-not-call and before calling hours", () => {
    const at = (hook: unknown) =>
      policies.defaultPipeline.indexOf(hook as never);
    expect(at(policies.whatsappOptInHook)).toBeGreaterThan(
      at(policies.dncHook),
    );
    expect(at(policies.whatsappOptInHook)).toBeLessThan(
      at(policies.quietHoursHook),
    );
  });

  it("refuses a WhatsApp message to a lead with no opt-in, sends to one who opted in, and still calls a lead with none", async () => {
    expect(await policies.guard(company(lead(null)).ctx, send())).toEqual(
      REFUSED,
    );
    expect(await policies.guard(company(lead(OPTED_IN)).ctx, send())).toEqual({
      ok: true,
    });
    expect(
      await policies.guard(company(lead(null)).ctx, send({ channel: "voice" })),
    ).toEqual({ ok: true });
  });

  it("names do-not-call, not the opt-in, when a lead is blocked and opted in to nothing", async () => {
    expect(await policies.guard(company(lead(null, true)).ctx, send())).toEqual(
      { ok: false, reason: "dnc" },
    );
  });
});
