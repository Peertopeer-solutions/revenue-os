// Guardrail ACTIVATION, hook half: what dnc/quiet-hours do when the contact
// identity behind a send cannot be resolved, and what a degenerate quiet-hours window means.
// (The loop half — channel + contactId reaching guard() at all — is loop-guard-wiring.test.ts.)
// Guardrails-as-config gate the outbound send pipeline. A guard that evaluates
// against a GUESSED timezone, or that sends to an identity it cannot check, is not a guard.
//
// ENV-FREE: fake OrgScopedDb returning canned rows; clock injected via ctx.now (the clock seam, OrgCtx.now) AND the
// host clock pinned with setSystemTime, so an implementation that ignores ctx.now cannot make a
// "→ null" assertion pass by accident. The DB-backed path is CI-owned (test/loop.test.ts).
//
// THE THREE POSTURES PINNED HERE (reviewed line-by-line before any GREEN):
//   • quietHoursHook, tz:'contact', NO resolvable contact ⇒ FAIL OPEN (null) + an OBSERVABLE
//     decision. Today it silently falls back to Asia/Kolkata (quietHoursHook, policies/calling-hours.ts) — a wrong-tz
//     guess that blocks at hours nobody configured. A courtesy gate may not guess.
//   • dncHook, channel-bearing action with NO contact identity ⇒ FAIL CLOSED (block). TESTER
//     POSITION, flagged for ruling: the do-not-call contract already fails CLOSED on a read ERROR;
//     "no identity at all" is strictly less knowledge than a failed read, so it cannot be less
//     safe. You may not send to someone whose consent you cannot look up.
//   • quiet_hours start === end ⇒ NO-OP window, never blocks (today: unpinned, incidentally
//     correct — these are regression pins, and they are GREEN on arrival by design).
//
// OBSERVABILITY SEAM: `ctx.onGuardEvent?(e)` — an OPTIONAL sink shaped exactly like the existing
// `ctx.now` seam (types.ts:13-26). The fake ctx below is UNANNOTATED on purpose: its inferred
// type carries the extra field, so this file compiles BEFORE the worker widens OrgCtx, and the
// RED comes from the assertion (the sink never being called), never from a type error.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import * as callingHours from "../src/policies/calling-hours";
import * as doNotCall from "../src/policies/do-not-call";
import * as pipeline from "../src/policies/pipeline";
import { isWithinQuietHours } from "../src/quiet-hours";
import type { GuardedAction, OrgScopedDb } from "../src/types";

// The checks under test, each from its own file, read through one namespace as above.
const policies = { ...callingHours, ...doNotCall, ...pipeline };

type QueryLog = { text: string; values?: unknown[] };
type GuardEvent = { hook?: string; decision?: string; reason?: string };

function makeCtx(opts: {
  policyRows?: Record<string, unknown>[]; // guardrail_policies rows
  contacts?: Record<string, Record<string, unknown>>; // contacts, KEYED BY ID
  now?: () => Date;
}) {
  const queries: QueryLog[] = [];
  const events: GuardEvent[] = [];
  const db: OrgScopedDb = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (/guardrail_policies/i.test(text)) {
        const rows = opts.policyRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (/contacts/i.test(text)) {
        // Models `where id = $1` faithfully: an absent, unknown, or CROSS-TENANT id (RLS filters
        // it) returns ZERO rows — the case the hooks have to have an answer for.
        const id = values?.[0];
        const row = typeof id === "string" ? opts.contacts?.[id] : undefined;
        const rows = row ? [row] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const ctx = {
    orgId: "org-1",
    db,
    now: opts.now,
    onGuardEvent: (e: GuardEvent) => {
      events.push(e);
    },
  };
  return { ctx, queries, events };
}

const at = (isoUtc: string) => new Date(isoUtc);
const IST = "Asia/Kolkata";
const activePolicy = (config: unknown) => ({
  key: "quiet_hours",
  config,
  active: true,
});
const CONTACT_TZ = { start: "21:00", end: "09:00", tz: "contact" };
const LITERAL_IST = { start: "21:00", end: "09:00", tz: IST };

// 16:30Z = 22:00 IST (INSIDE the 21:00–09:00 window) but 12:30 EDT / 16:30 UTC (outside). Under
// today's silent Asia/Kolkata fallback an unresolvable contact BLOCKS at this instant — that is
// precisely the wrong-tz guess these tests outlaw.
const INSIDE_IST = "2026-07-16T16:30:00Z";
const KNOWN_CONTACT = "c1";
const UNKNOWN_CONTACT = "c-does-not-exist"; // deleted, hallucinated, or another tenant's

// A send carries a channel; a plain tool does not (loop.ts builds channel-less tool actions).
const send = (over: Partial<GuardedAction> = {}): GuardedAction => ({
  kind: "tool",
  toolName: "send_confirmation",
  autonomy: "auto",
  channel: "whatsapp",
  ...over, // contactId is deliberately ABSENT unless a test supplies it
});

beforeEach(() => setSystemTime(at(INSIDE_IST))); // host clock INSIDE: null can only mean fail-open
afterEach(() => setSystemTime());

describe("task-56 AC2 quietHoursHook — tz:'contact' with NO resolvable contact FAILS OPEN (never a guessed tz)", () => {
  it("channel-bearing action with NO contactId → null (pass), not an Asia/Kolkata evaluation", async () => {
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contacts: { [KNOWN_CONTACT]: { id: KNOWN_CONTACT, timezone: IST } },
      now: () => at(INSIDE_IST),
    });
    expect(await policies.quietHoursHook(ctx, send())).toBeNull();
  });

  it("contactId that resolves to ZERO rows (deleted, hallucinated, or another tenant under RLS) → null (pass)", async () => {
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contacts: { [KNOWN_CONTACT]: { id: KNOWN_CONTACT, timezone: IST } },
      now: () => at(INSIDE_IST),
    });
    expect(
      await policies.quietHoursHook(ctx, send({ contactId: UNKNOWN_CONTACT })),
    ).toBeNull();
  });

  it("the skip is OBSERVABLE: ctx.onGuardEvent records {hook:'quiet_hours', reason:'unresolved_contact_tz'} — never a silent guess", async () => {
    const { ctx, events } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      now: () => at(INSIDE_IST),
    });
    const verdict = await policies.quietHoursHook(ctx, send());
    expect(events).toContainEqual(
      expect.objectContaining({
        hook: "quiet_hours",
        reason: "unresolved_contact_tz",
      }),
    );
    expect(verdict).toBeNull();
  });

  it("a LITERAL IANA tz still blocks with no contactId — fail-open is scoped to tz:'contact', not to every missing id", async () => {
    const { ctx, queries } = makeCtx({
      policyRows: [activePolicy(LITERAL_IST)],
      now: () => at(INSIDE_IST),
    });
    expect(await policies.quietHoursHook(ctx, send())).toEqual({
      ok: false,
      reason: "quiet_hours",
    });
    expect(queries.some((q) => /contacts/i.test(q.text))).toBe(false);
  });

  it("tz:'contact' WITH a resolvable contact is unchanged: evaluated in the contact's own tz → blocks", async () => {
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      contacts: { [KNOWN_CONTACT]: { id: KNOWN_CONTACT, timezone: IST } },
      now: () => at(INSIDE_IST),
    });
    expect(
      await policies.quietHoursHook(ctx, send({ contactId: KNOWN_CONTACT })),
    ).toEqual({ ok: false, reason: "quiet_hours" });
  });
});

// TESTER POSITION (flagged for the orchestrator's ruling). dncHook already fails CLOSED when the
// consent read THROWS (dncHook in policies/do-not-call.ts). A channel-bearing action with no
// resolvable contact is the same epistemic state reached one step earlier — the consent value is
// unknown — so the verdict must be the same: BLOCK. The alternative (pass) means the one input an
// LLM controls, "which contact id do I put in the args", is also the switch that turns DNC off:
// omit the id, or name a contact in another tenant (RLS returns zero rows), and the hard-safety
// gate evaporates. A missed send is a courtesy failure; a send to a DNC-listed person is a legal
// one. The channel-LESS path is untouched — plain tools are never dnc-gated (policies.test.ts pins it).
describe("task-56 AC4 dncHook — a channel-bearing action with NO contact identity FAILS CLOSED", () => {
  it("channel + NO contactId → BLOCK {ok:false, reason:'dnc'} (consent unknowable ⇒ no send)", async () => {
    const { ctx } = makeCtx({
      contacts: {
        [KNOWN_CONTACT]: { id: KNOWN_CONTACT, consent: { dnc: false } },
      },
      now: () => at(INSIDE_IST),
    });
    expect(await policies.dncHook(ctx, send())).toEqual({
      ok: false,
      reason: "dnc",
    });
  });

  it("channel + a contactId that resolves to ZERO rows (hallucinated id, or another tenant's under RLS) → BLOCK", async () => {
    const { ctx } = makeCtx({
      contacts: {
        [KNOWN_CONTACT]: { id: KNOWN_CONTACT, consent: { dnc: false } },
      },
      now: () => at(INSIDE_IST),
    });
    expect(
      await policies.dncHook(ctx, send({ contactId: UNKNOWN_CONTACT })),
    ).toEqual({
      ok: false,
      reason: "dnc",
    });
  });

  it("channel-LESS action with no contactId → null: the plain-tool path is never dnc-gated (T2-AC6 preserved)", async () => {
    const { ctx, queries } = makeCtx({ now: () => at(INSIDE_IST) });
    expect(
      await policies.dncHook(ctx, {
        kind: "tool",
        toolName: "update_contact",
        autonomy: "auto",
      }),
    ).toBeNull();
    expect(queries.some((q) => /contacts/i.test(q.text))).toBe(false);
  });

  it("guard(): an identity-less send is refused as 'dnc' — the hard-safety gate answers first, before quiet_hours", async () => {
    // Today this returns 'quiet_hours' (dnc passes on zero rows, then the tz guess blocks). The
    // reason string is the contract: operators triage 'dnc' and 'quiet_hours' differently.
    const { ctx } = makeCtx({
      policyRows: [activePolicy(CONTACT_TZ)],
      now: () => at(INSIDE_IST),
    });
    expect(await policies.guard(ctx, send())).toEqual({
      ok: false,
      reason: "dnc",
    });
  });
});

describe("task-56 AC3 quiet_hours start === end — a DEGENERATE window is a NO-OP, never an all-day block", () => {
  const NOOP_WINDOW = { start: "09:00", end: "09:00" };
  const AT_START = "2026-07-16T03:30:00Z"; // exactly 09:00 IST — the boundary instant
  const AN_HOUR_LATER = "2026-07-16T04:30:00Z"; // 10:00 IST

  it("predicate: start===end is false AT the boundary, an hour later, and twelve hours later (zero-width, not 24h)", () => {
    expect(isWithinQuietHours(at(AT_START), "09:00", "09:00", IST)).toBe(false);
    expect(isWithinQuietHours(at(AN_HOUR_LATER), "09:00", "09:00", IST)).toBe(
      false,
    );
    expect(isWithinQuietHours(at(INSIDE_IST), "09:00", "09:00", IST)).toBe(
      false,
    );
  });

  it("hook, literal IANA tz: a start===end window never blocks — not even at exactly 09:00 IST", async () => {
    const { ctx } = makeCtx({
      policyRows: [activePolicy({ ...NOOP_WINDOW, tz: IST })],
      now: () => at(AT_START),
    });
    expect(await policies.quietHoursHook(ctx, send())).toBeNull();
  });

  it("hook, tz:'contact' with a resolvable contact: a start===end window never blocks", async () => {
    const { ctx } = makeCtx({
      policyRows: [activePolicy({ ...NOOP_WINDOW, tz: "contact" })],
      contacts: { [KNOWN_CONTACT]: { id: KNOWN_CONTACT, timezone: IST } },
      now: () => at(AT_START),
    });
    expect(
      await policies.quietHoursHook(ctx, send({ contactId: KNOWN_CONTACT })),
    ).toBeNull();
  });
});
