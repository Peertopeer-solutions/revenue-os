// T2 RED — guardrail hooks (dnc, attempt_cap) + the clock seam, extending guard()'s pipeline.
// Moat invariant #4: guardrails-as-config gate the outbound send pipeline; no code path routes
// around guard(). This suite pins the two NEW hooks and the failure postures that make them safe.
//
// ENV-FREE: every ctx is a fake OrgScopedDb that returns canned rows (or throws, to model a DB
// outage); the wall clock is pinned with bun:test's setSystemTime for hermeticity, and the hooks'
// time reasoning is driven through an INJECTED `ctx.now`. The real DB-backed path is CI-owned
// (the loop integration suite, test/loop.test.ts — not runnable in an env-free worktree).
//
// NEW hooks are reached via a NAMESPACE import (`policies.dncHook`): a *named* import of a
// not-yet-exported symbol is a link-time SyntaxError in Bun that fails the WHOLE file to load
// (a spurious import-error RED). A namespace member is simply `undefined` until implemented, so
// the file loads and each test REDs on its own assertion.
//
// FAILURE POSTURES UNDER TEST (the crown jewels — reviewed line-by-line before any GREEN):
//   • dncHook is FAIL-CLOSED  — a thrown DB read ⇒ BLOCK {ok:false, reason:'dnc'} (hard safety).
//   • quietHoursHook is FAIL-OPEN — a thrown DB read ⇒ PASS (null) (courtesy gate; never silence
//     every send on a transient hiccup). #2 and #3 face the SAME total outage to contrast them.
//
// DNC SOURCE (grounded): contacts.consent->>'dnc' — the per-contact consent flag that ships in the
// default row `{"dnc": false, ...}` (003_crm.sql:32). The action carries contactId, so the natural
// "do-not-contact THIS person" signal is the contact's own flag (not the org-level 'dnc' policy
// list). WORKER MUST read this source for the GREEN to match these canned rows.
//
// ATTEMPT-CAP SHAPES:
//   workflow_runs.attempts (006_harness.sql:62, read via runs_contact index :71) — TESTER-DEFINED,
//   no code pins it yet (WORKER MUST MATCH, flagged in report). Per-channel ARRAY of ISO timestamps
//   (timestamps, not a bare counter — a rolling window needs them):
//       { "<channel>": ["<iso8601>", ...] }
//   guardrail_policies['attempt_caps'].config — key GROUNDED in the real seed (real_estate.sql:46 &
//   b2b_wholesale.sql:41): `per_hours`, NOT `window_hours`. A cap that reads a missing key ⇒ no cap
//   ⇒ over-contacting, so the canned config MUST match the seed to force the worker to read it:
//       { "voice": {"max":3,"per_hours":72}, "whatsapp": {"max":2,"per_hours":24} }
//   count-in-window(ch) = |{ t in attempts[ch] : t >= now - per_hours }|; block when >= max.
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import * as attemptCap from "../src/policies/attempt-cap";
import * as autonomy from "../src/policies/autonomy";
import * as callingHours from "../src/policies/calling-hours";
import * as doNotCall from "../src/policies/do-not-call";
import * as pipeline from "../src/policies/pipeline";
import type { GuardedAction, OrgCtx, OrgScopedDb } from "../src/types";

// Every check, each from its own file, read through one namespace as above.
const policies = {
  ...attemptCap,
  ...autonomy,
  ...callingHours,
  ...doNotCall,
  ...pipeline,
};

// Fake org-scoped db: routes on table name, records every query (so a test can assert the DNC
// source was consulted), and `throwOn` lets the security-edge tests simulate a failing read.
type QueryLog = { text: string; values?: unknown[] };
function makeCtx(opts: {
  policyRows?: Record<string, unknown>[]; // guardrail_policies (quiet_hours | attempt_caps)
  contactRows?: Record<string, unknown>[]; // contacts (consent.dnc, timezone)
  runRows?: Record<string, unknown>[]; // workflow_runs (attempts jsonb)
  throwOn?: RegExp;
  now?: () => Date;
}): { ctx: OrgCtx; queries: QueryLog[] } {
  const queries: QueryLog[] = [];
  const db: OrgScopedDb = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (opts.throwOn?.test(text)) throw new Error("simulated db failure");
      if (/workflow_runs/i.test(text)) {
        const rows = opts.runRows ?? [];
        return { rows, rowCount: rows.length };
      }
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
  return { ctx: { orgId: "org-1", db, now: opts.now }, queries };
}

const at = (isoUtc: string) => new Date(isoUtc);
const IST = "Asia/Kolkata";

// Quiet-hours fixtures (window 21:00–09:00 IST). QUIET_WALL is OUTSIDE, QUIET_NOW is INSIDE.
const CONTACT_TZ = { start: "21:00", end: "09:00", tz: "contact" };
const activePolicy = (config: unknown) => ({ key: "x", config, active: true });
const contact = (timezone: unknown) => ({ id: "c1", timezone });
const QUIET_WALL = "2026-07-16T06:30:00Z"; // 12:00 IST — outside quiet hours
const QUIET_NOW = "2026-07-16T16:30:00Z"; // 22:00 IST — inside quiet hours

// Attempt-cap fixtures. Three prior VOICE attempts clustered Jul-16 10:00–12:00Z.
const ATTEMPT_CAPS = {
  voice: { max: 3, per_hours: 72 },
  whatsapp: { max: 2, per_hours: 24 },
};
const VOICE_ATTEMPTS_2 = ["2026-07-16T10:00:00Z", "2026-07-16T11:00:00Z"];
const VOICE_ATTEMPTS_3 = [
  "2026-07-16T10:00:00Z",
  "2026-07-16T11:00:00Z",
  "2026-07-16T12:00:00Z",
];
const NOW_IN_WINDOW = "2026-07-16T13:00:00Z"; // 1–3h after the priors → all within 72h
const NOW_PAST_WINDOW = "2026-07-20T13:00:00Z"; // ~97–99h after → all outside 72h

// A send carries a channel; a plain tool does not (loop.ts:113 builds channel-less tool actions).
const send = (over: Partial<GuardedAction> = {}): GuardedAction => ({
  kind: "tool",
  toolName: "send_message",
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
  ...over, // deliberately no channel
});

// Reset the pinned clock after every test so nothing leaks into the DB-backed loop suite.
afterEach(() => setSystemTime());

describe("T2-AC1 dncHook — blocks sends to a DNC-listed contact (contacts.consent->>'dnc', 003_crm.sql:32)", () => {
  it("channel:'voice' to a DNC-listed contact (consent.dnc=true) → BLOCK {ok:false, reason:'dnc'}", async () => {
    const { ctx, queries } = makeCtx({
      contactRows: [{ id: "c1", consent: { dnc: true } }],
      now: () => at(NOW_IN_WINDOW),
    });
    expect(typeof policies.dncHook).toBe("function"); // RED until the worker exports dncHook
    expect(await policies.dncHook(ctx, send({ channel: "voice" }))).toEqual({
      ok: false,
      reason: "dnc",
    });
    expect(queries.some((q) => /contacts/i.test(q.text))).toBe(true); // consulted the contact flag
  });
  it("channel:'voice' to a NOT-listed contact (consent.dnc=false) → null — the block is the flag, not the channel", async () => {
    const { ctx } = makeCtx({
      contactRows: [{ id: "c1", consent: { dnc: false } }],
      now: () => at(NOW_IN_WINDOW),
    });
    expect(typeof policies.dncHook).toBe("function");
    expect(await policies.dncHook(ctx, send({ channel: "voice" }))).toBeNull();
  });
});

describe("T2-SECURITY EDGE — SAME total DB outage, OPPOSITE postures: dnc FAILS CLOSED vs quiet FAILS OPEN", () => {
  it("dnc FAILS CLOSED: the consent read throws → BLOCK {ok:false, reason:'dnc'} (block on uncertainty)", async () => {
    setSystemTime(at(QUIET_NOW)); // clock irrelevant here — pinned only for hermeticity
    const { ctx } = makeCtx({ throwOn: /./, now: () => at(QUIET_NOW) }); // EVERY query throws
    expect(typeof policies.dncHook).toBe("function"); // RED until implemented
    // FAIL-CLOSED contract: a DNC read error must NEVER fall open to a send.
    expect(await policies.dncHook(ctx, send({ channel: "voice" }))).toEqual({
      ok: false,
      reason: "dnc",
    });
  });
  it("quiet_hours FAILS OPEN: the SAME total DB outage → PASS (null) — a courtesy gate must not silence sends", async () => {
    setSystemTime(at(QUIET_NOW));
    const { ctx } = makeCtx({ throwOn: /./, now: () => at(QUIET_NOW) }); // EVERY query throws
    // quietHoursHook already exists; this pins its fail-OPEN posture across the clock-seam refactor.
    expect(
      await policies.quietHoursHook(ctx, send({ channel: "voice" })),
    ).toBeNull();
  });
});

describe("T2-AC4/5 attemptCapHook — per-channel windowed caps (workflow_runs.attempts 006:62; caps guardrail_policies['attempt_caps'])", () => {
  it("allows the 3rd voice attempt: 2 priors in the 72h window (2 < cap 3) → null", async () => {
    setSystemTime(at(NOW_IN_WINDOW));
    const { ctx } = makeCtx({
      policyRows: [activePolicy(ATTEMPT_CAPS)],
      runRows: [{ attempts: { voice: VOICE_ATTEMPTS_2 } }],
      now: () => at(NOW_IN_WINDOW),
    });
    expect(typeof policies.attemptCapHook).toBe("function"); // RED until implemented
    expect(
      await policies.attemptCapHook(ctx, send({ channel: "voice" })),
    ).toBeNull();
  });
  it("blocks the 4th voice attempt: 3 priors in the 72h window (3 >= cap 3) → {ok:false, reason:'attempt_cap'}", async () => {
    setSystemTime(at(NOW_IN_WINDOW));
    const { ctx } = makeCtx({
      policyRows: [activePolicy(ATTEMPT_CAPS)],
      runRows: [{ attempts: { voice: VOICE_ATTEMPTS_3 } }],
      now: () => at(NOW_IN_WINDOW),
    });
    expect(typeof policies.attemptCapHook).toBe("function");
    expect(
      await policies.attemptCapHook(ctx, send({ channel: "voice" })),
    ).toEqual({
      ok: false,
      reason: "attempt_cap",
    });
  });
  it("window respects ctx.now: clock advanced PAST 72h drops the 3 priors out of window → null (reset). Host clock (setSystemTime) stays IN-window to prove ctx.now — not host time — is used", async () => {
    setSystemTime(at(NOW_IN_WINDOW)); // host: priors 1–3h old (in window) → a naive new Date() BLOCKS
    const { ctx } = makeCtx({
      policyRows: [activePolicy(ATTEMPT_CAPS)],
      runRows: [{ attempts: { voice: VOICE_ATTEMPTS_3 } }],
      now: () => at(NOW_PAST_WINDOW), // ctx: priors ~97h old (out of window) → ALLOW
    });
    expect(typeof policies.attemptCapHook).toBe("function");
    expect(
      await policies.attemptCapHook(ctx, send({ channel: "voice" })),
    ).toBeNull();
  });
  it("per-channel isolation: 3 voice priors do NOT count against the whatsapp cap → whatsapp send allowed (null)", async () => {
    setSystemTime(at(NOW_IN_WINDOW));
    const { ctx } = makeCtx({
      policyRows: [activePolicy(ATTEMPT_CAPS)],
      runRows: [{ attempts: { voice: VOICE_ATTEMPTS_3 } }], // no whatsapp attempts recorded
      now: () => at(NOW_IN_WINDOW),
    });
    expect(typeof policies.attemptCapHook).toBe("function");
    expect(
      await policies.attemptCapHook(ctx, send({ channel: "whatsapp" })),
    ).toBeNull();
  });
});

describe("T2-AC6 non-send tool (no channel) — never dnc'd / quieted / capped (loop.ts:113 plain-tool path)", () => {
  it("a channel-less tool passes dnc, quiet_hours AND attempt_cap untouched even when all three WOULD fire on a send", async () => {
    setSystemTime(at(QUIET_NOW)); // inside quiet hours…
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)], // …a send would hit quiet hours,
      contactRows: [{ id: "c1", consent: { dnc: true }, timezone: IST }], // …a send would hit dnc,
      runRows: [{ attempts: { voice: VOICE_ATTEMPTS_3 } }], // …a voice send would hit the cap.
      now: () => at(QUIET_NOW),
    });
    expect(typeof policies.dncHook).toBe("function"); // RED until implemented
    expect(typeof policies.attemptCapHook).toBe("function");
    expect(await policies.dncHook(ctx, nonSend())).toBeNull();
    expect(await policies.quietHoursHook(ctx, nonSend())).toBeNull();
    expect(await policies.attemptCapHook(ctx, nonSend())).toBeNull();
  });
  it("a channel-less tool is NOT dnc-blocked under a total DB outage (channel guard precedes the fail-closed read)", async () => {
    const { ctx } = makeCtx({ throwOn: /./, now: () => at(QUIET_NOW) }); // every query throws
    expect(typeof policies.dncHook).toBe("function");
    // guard-critical: a DB hiccup must not turn the plain-tool path into a DNC block.
    expect(await policies.dncHook(ctx, nonSend())).toBeNull();
  });
});

describe("T2-AC7 defaultPipeline — order [autonomy → dnc → quiet_hours → attempt_cap] & autonomy short-circuit", () => {
  it("order: autonomy is first; the two new send hooks sit after the autonomy gatekeeper", () => {
    const p = policies.defaultPipeline;
    const idx = (h: unknown) => p.indexOf(h as never);
    expect(idx(policies.autonomyHook)).toBe(0);
    expect(idx(policies.dncHook)).toBeGreaterThan(idx(policies.autonomyHook)); // RED: -1 > 0 is false
    expect(idx(policies.quietHoursHook)).toBeGreaterThan(idx(policies.dncHook));
    expect(idx(policies.attemptCapHook)).toBeGreaterThan(
      idx(policies.quietHoursHook),
    );
  });
  it("autonomy runs FIRST: a forbidden send returns 'forbidden', never reaching a send-hook reason", async () => {
    setSystemTime(at(QUIET_NOW)); // inside quiet hours, dnc-listed, over cap — autonomy still wins
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [{ id: "c1", consent: { dnc: true }, timezone: IST }],
      runRows: [{ attempts: { voice: VOICE_ATTEMPTS_3 } }],
      now: () => at(QUIET_NOW),
    });
    expect(
      await policies.guard(
        ctx,
        send({ channel: "voice", autonomy: "forbidden" }),
      ),
    ).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("T2 clock seam — quietHoursHook reads ctx.now, not the host wall clock", () => {
  it("ctx.now inside quiet hours while the host clock is outside → BLOCK (proves ctx.now wins over new Date())", async () => {
    setSystemTime(at(QUIET_WALL)); // 12:00 IST — outside; a bare new Date() would return null
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contactRows: [contact(IST)],
      now: () => at(QUIET_NOW), // 22:00 IST — inside
    });
    expect(await policies.quietHoursHook(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
  });
});
