// Quiet-hours guardrail hook (guardrails-as-config gate the
// outbound send pipeline; the Verdict union already reserves reason 'quiet_hours'). Env-free:
// the pure predicate takes an injected `now`; the hook's DB reads are mocked via a fake
// OrgScopedDb, and its wall-clock `new Date()` is pinned with bun:test's setSystemTime. The real
// DB reads are CI-owned (the loop integration suite). Ground truth: guardrail_policies key
// 'quiet_hours' config {"start":"21:00","end":"09:00","tz":"contact"}; contacts.timezone (text,
// default 'Asia/Kolkata'). Boundary semantics under test: START inclusive, END exclusive.
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { autonomyHook } from "../src/policies/autonomy";
import { quietHoursHook } from "../src/policies/calling-hours";
import { defaultPipeline, guard } from "../src/policies/pipeline";
import { isWithinQuietHours } from "../src/quiet-hours";
import type { GuardedAction, OrgCtx, OrgScopedDb } from "../src/types";

// A fake org-scoped db: routes on table name, records every query so tests can assert which
// reads happened (AC3: a literal tz must NOT trigger a contacts lookup). throwOn lets the
// security-edge tests simulate a failing policy read.
type QueryLog = { text: string; values?: unknown[] };
function makeCtx(opts: {
  policyRows?: Record<string, unknown>[];
  contactRows?: Record<string, unknown>[];
  throwOn?: RegExp;
}): { ctx: OrgCtx; queries: QueryLog[] } {
  const queries: QueryLog[] = [];
  const db: OrgScopedDb = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (opts.throwOn?.test(text)) throw new Error("simulated db failure");
      if (/guardrail_policies/i.test(text)) {
        const rows = opts.policyRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (/contacts/i.test(text)) {
        const rows = opts.contactRows ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { ctx: { orgId: "org-1", db }, queries };
}

const at = (isoUtc: string) => new Date(isoUtc);
const IST = "Asia/Kolkata";
const activePolicy = (config: unknown) => ({
  key: "quiet_hours",
  config,
  active: true,
});
const CONTACT_TZ = { start: "21:00", end: "09:00", tz: "contact" };
const contact = (timezone: unknown) => ({ id: "c1", timezone });
const send = (over: Partial<GuardedAction> = {}): GuardedAction => ({
  kind: "tool",
  toolName: "send_whatsapp",
  autonomy: "auto",
  contactId: "c1",
  channel: "whatsapp",
  ...over,
});
const nonSend = (over: Partial<GuardedAction> = {}): GuardedAction => ({
  kind: "tool",
  toolName: "update_contact",
  autonomy: "auto",
  contactId: "c1",
  ...over,
});

// Reset the pinned clock after every test so nothing leaks into the DB-backed loop suite.
afterEach(() => setSystemTime());

describe("AC1 isWithinQuietHours — midnight-wrapping window 21:00–09:00 (tz Asia/Kolkata)", () => {
  it("22:00 IST is inside the quiet window → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T16:30:00Z"), "21:00", "09:00", IST),
    ).toBe(true);
  });
  it("00:00 IST (midnight, inside the wrap) → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T18:30:00Z"), "21:00", "09:00", IST),
    ).toBe(true);
  });
  it("03:00 IST is inside → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-15T21:30:00Z"), "21:00", "09:00", IST),
    ).toBe(true);
  });
  it("08:59 IST is inside → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T03:29:00Z"), "21:00", "09:00", IST),
    ).toBe(true);
  });
  it("09:00 IST is NOT inside — END is exclusive → false", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T03:30:00Z"), "21:00", "09:00", IST),
    ).toBe(false);
  });
  it("21:00 IST IS inside — START is inclusive → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T15:30:00Z"), "21:00", "09:00", IST),
    ).toBe(true);
  });
  it("12:00 IST is outside → false", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T06:30:00Z"), "21:00", "09:00", IST),
    ).toBe(false);
  });
});
describe("AC1 isWithinQuietHours — non-wrapping window 12:00–13:00 (tz Asia/Kolkata)", () => {
  it("12:00 IST IS inside — START is inclusive → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T06:30:00Z"), "12:00", "13:00", IST),
    ).toBe(true);
  });
  it("12:30 IST is inside → true", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T07:00:00Z"), "12:00", "13:00", IST),
    ).toBe(true);
  });
  it("11:59 IST is outside → false", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T06:29:00Z"), "12:00", "13:00", IST),
    ).toBe(false);
  });
  it("13:00 IST is NOT inside — END is exclusive → false", () => {
    expect(
      isWithinQuietHours(at("2026-07-16T07:30:00Z"), "12:00", "13:00", IST),
    ).toBe(false);
  });
});

describe("AC1 isWithinQuietHours — wall-clock computed in the given tz, not the host tz", () => {
  it("one UTC instant: inside in Asia/Kolkata (22:00) yet outside in UTC (16:30)", () => {
    const instant = at("2026-07-16T16:30:00Z");
    expect(isWithinQuietHours(instant, "21:00", "09:00", "Asia/Kolkata")).toBe(
      true,
    );
    expect(isWithinQuietHours(instant, "21:00", "09:00", "UTC")).toBe(false);
  });
});

describe("AC2 quietHoursHook — gates outbound sends inside quiet hours", () => {
  it("send channel + inside quiet hours → blocks {ok:false, reason:'quiet_hours'}", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z")); // 22:00 IST
    const { ctx, queries } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(IST)],
    });
    expect(await quietHoursHook(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
    expect(queries.some((q) => /guardrail_policies/i.test(q.text))).toBe(true);
  });
  it("send channel + outside quiet hours → null (pass to next hook)", async () => {
    setSystemTime(at("2026-07-16T06:30:00Z")); // 12:00 IST
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(IST)],
    });
    expect(await quietHoursHook(ctx, send())).toBeNull();
  });
  it("no channel (non-send tool) → null even inside quiet hours (gates SENDS only)", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z")); // 22:00 IST — would block a send
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(IST)],
    });
    expect(await quietHoursHook(ctx, nonSend())).toBeNull();
  });
  it("no active quiet_hours policy row → null (unconfigured = no restriction)", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z")); // 22:00 IST — would block if configured
    const { ctx } = makeCtx({ policyRows: [], contactRows: [contact(IST)] });
    expect(await quietHoursHook(ctx, send())).toBeNull();
  });
});
describe("AC3 quietHoursHook — timezone resolution", () => {
  it("tz='contact' resolves to the contact's own timezone (America/New_York, not the default)", async () => {
    // 10:00Z = 06:00 EDT (inside 21:00–09:00) but 15:30 IST (outside). A block proves the
    // contact's NY tz was used, not the Asia/Kolkata default.
    setSystemTime(at("2026-07-16T10:00:00Z"));
    const { ctx, queries } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact("America/New_York")],
    });
    expect(await quietHoursHook(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
    expect(queries.some((q) => /contacts/i.test(q.text))).toBe(true);
  });
  it("tz='contact' with a null contact timezone falls back to 'Asia/Kolkata'", async () => {
    // 16:30Z = 22:00 IST (inside) but 16:30 UTC (outside). A block proves the fallback is IST.
    setSystemTime(at("2026-07-16T16:30:00Z"));
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(null)],
    });
    expect(await quietHoursHook(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
  });
  it("a literal IANA tz in config is used directly — NO contacts lookup", async () => {
    setSystemTime(at("2026-07-16T10:00:00Z")); // 06:00 EDT — inside
    const { ctx, queries } = makeCtx({
      policyRows: [
        activePolicy({ start: "21:00", end: "09:00", tz: "America/New_York" }),
      ],
      contactRows: [],
    });
    expect(await quietHoursHook(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
    expect(queries.some((q) => /contacts/i.test(q.text))).toBe(false);
  });
});

describe("SECURITY EDGE quietHoursHook — FAIL-OPEN (courtesy guard, not a hard-safety like DNC)", () => {
  it("policy read THROWS → null (never rejects; a DB hiccup must not break every send)", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z")); // would block if the read had worked
    const { ctx } = makeCtx({
      throwOn: /guardrail_policies/i,
      contactRows: [contact(IST)],
    });
    expect(await quietHoursHook(ctx, send())).toBeNull();
  });
  it("malformed config (missing start/end) → null (fail-open)", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z"));
    const { ctx } = makeCtx({
      policyRows: [activePolicy({ foo: "bar" })],
      contactRows: [contact(IST)],
    });
    expect(await quietHoursHook(ctx, send())).toBeNull();
  });
  it("malformed config (non-time strings) → null (fail-open)", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z"));
    const { ctx } = makeCtx({
      policyRows: [
        activePolicy({ start: "nonsense", end: "foo", tz: "contact" }),
      ],
      contactRows: [contact(IST)],
    });
    expect(await quietHoursHook(ctx, send())).toBeNull();
  });
});

describe("AC4 guard pipeline wiring", () => {
  it("defaultPipeline includes quietHoursHook, ordered AFTER autonomyHook", () => {
    expect(defaultPipeline).toContain(quietHoursHook);
    expect(defaultPipeline.indexOf(quietHoursHook)).toBeGreaterThan(
      defaultPipeline.indexOf(autonomyHook),
    );
  });
  it("guard() via defaultPipeline enforces quiet hours for an auto send", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z")); // 22:00 IST
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(IST)],
    });
    expect(await guard(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
  });
  it("autonomy precedes quiet hours: a forbidden send returns 'forbidden', not 'quiet_hours'", async () => {
    setSystemTime(at("2026-07-16T16:30:00Z")); // inside quiet hours too
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(IST)],
    });
    expect(await guard(ctx, send({ autonomy: "forbidden" }))).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });
});
