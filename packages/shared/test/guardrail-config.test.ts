// task-52 RED — guardrail-policy config is the SAFETY BOUNDARY. The harness quiet_hours hook
// reads guardrail_policies.config FAIL-OPEN (quietHoursHook, policies/calling-hours.ts): a malformed config silently
// disables quiet hours for every send. The PUT's strict Zod validation is what stops a bad
// config reaching the row, so this suite pins the per-key accept/reject matrix directly at the
// schema. The union MUST live in packages/shared/src/schemas.ts (boundary truth — never declared
// locally in the route). Grounded in supabase/seeds/real_estate.sql:44-49 + packages/harness/src/
// policies/calling-hours.ts (HH:MM regex /^([01]\d|2[0-3]):[0-5]\d$/).
//
// bun:test is allowed in packages/**/test/** (biome.json override line 29). We reach the export
// through a loose namespace bag so this file TYPECHECKS before the schema exists, yet every case
// still fails at runtime via `expect(schema).toBeDefined()` (a clean missing-feature assertion,
// never a thrown import error).
import { describe, expect, it } from "bun:test";
import * as shared from "../src";

interface ZodLike {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

// The single body schema the PUT route parses: discriminatedUnion("key", …) over { key, config,
// active? } with active defaulting true. Named GuardrailPolicyInputSchema (contract judgment —
// see report). Loose-cast so a missing export is `undefined`, asserted below, not a link error.
const bag = shared as unknown as Record<string, unknown>;
function union(): ZodLike | undefined {
  const s = bag.GuardrailPolicyInputSchema as ZodLike | undefined;
  expect(s).toBeDefined();
  return s;
}

// Canonical valid configs mirror the seed rows (real_estate.sql:45-48).
const validQuiet = {
  key: "quiet_hours",
  config: { start: "21:00", end: "09:00", tz: "contact" },
};
const validQuietIana = {
  key: "quiet_hours",
  config: { start: "08:30", end: "22:15", tz: "Asia/Kolkata" },
};
const validCaps = {
  key: "attempt_caps",
  config: {
    voice: { max: 3, per_hours: 72 },
    whatsapp: { max: 2, per_hours: 24 },
  },
};
const validAutonomy = {
  key: "autonomy",
  config: {
    book_appointment: "auto",
    send_quote: "approval",
    update_contact: "forbidden",
  },
};

const accepts: Array<[string, unknown]> = [
  ["quiet_hours with tz 'contact'", validQuiet],
  ["quiet_hours with a literal IANA-ish tz", validQuietIana],
  ["attempt_caps with both channels", validCaps],
  ["dnc hard_stop true", { key: "dnc", config: { hard_stop: true } }],
  ["dnc hard_stop false", { key: "dnc", config: { hard_stop: false } }],
  ["autonomy tool→tier map", validAutonomy],
];

const rejects: Array<[string, unknown]> = [
  // Unknown discriminant key.
  ["an unknown key", { key: "spend_caps", config: {} }],
  // quiet_hours — the fail-open surface, pinned hardest.
  [
    "quiet_hours start '25:00' (fails the HH:MM regex)",
    {
      key: "quiet_hours",
      config: { start: "25:00", end: "09:00", tz: "contact" },
    },
  ],
  [
    "quiet_hours missing end",
    { key: "quiet_hours", config: { start: "21:00", tz: "contact" } },
  ],
  [
    "quiet_hours tz '' (empty)",
    { key: "quiet_hours", config: { start: "21:00", end: "09:00", tz: "" } },
  ],
  [
    "quiet_hours with an extra unknown field (strict)",
    {
      key: "quiet_hours",
      config: { start: "21:00", end: "09:00", tz: "contact", nights: true },
    },
  ],
  // attempt_caps — record keyed by channel.
  [
    "attempt_caps with an unknown channel key",
    {
      key: "attempt_caps",
      config: {
        voice: { max: 3, per_hours: 72 },
        whatsapp: { max: 2, per_hours: 24 },
        sms: { max: 1, per_hours: 1 },
      },
    },
  ],
  [
    "attempt_caps max not a positive int (0)",
    {
      key: "attempt_caps",
      config: {
        voice: { max: 0, per_hours: 72 },
        whatsapp: { max: 2, per_hours: 24 },
      },
    },
  ],
  [
    "attempt_caps per_hours not positive (-1)",
    {
      key: "attempt_caps",
      config: {
        voice: { max: 3, per_hours: -1 },
        whatsapp: { max: 2, per_hours: 24 },
      },
    },
  ],
  [
    "attempt_caps inner extra field (strict)",
    {
      key: "attempt_caps",
      config: {
        voice: { max: 3, per_hours: 72, burst: 5 },
        whatsapp: { max: 2, per_hours: 24 },
      },
    },
  ],
  // dnc — strict boolean.
  ["dnc missing hard_stop", { key: "dnc", config: {} }],
  ["dnc hard_stop non-boolean", { key: "dnc", config: { hard_stop: "yes" } }],
  [
    "dnc extra field (strict)",
    { key: "dnc", config: { hard_stop: true, escalate: true } },
  ],
  // autonomy — tier enum + non-empty tool name.
  [
    "autonomy tier not in enum",
    { key: "autonomy", config: { book_appointment: "maybe" } },
  ],
  ["autonomy empty tool-name key", { key: "autonomy", config: { "": "auto" } }],
];

describe("GuardrailPolicyInputSchema — accepts every valid per-key config", () => {
  for (const [name, input] of accepts) {
    it(`accepts ${name}`, () => {
      const s = union();
      if (!s) return; // toBeDefined already failed — avoid a throw, keep the assertion clean
      expect(s.safeParse(input).success).toBe(true);
    });
  }
});

describe("GuardrailPolicyInputSchema — rejects every malformed config (400 at the route)", () => {
  for (const [name, input] of rejects) {
    it(`rejects ${name}`, () => {
      const s = union();
      if (!s) return;
      expect(s.safeParse(input).success).toBe(false);
    });
  }
});

describe("GuardrailPolicyInputSchema — active defaults true, honored when given", () => {
  it("defaults active to true when omitted", () => {
    const s = union();
    if (!s) return;
    const r = s.safeParse({ key: "dnc", config: { hard_stop: true } });
    expect(r.success).toBe(true);
    expect((r.data as { active?: boolean }).active).toBe(true);
  });

  it("honors active:false", () => {
    const s = union();
    if (!s) return;
    const r = s.safeParse({
      key: "dnc",
      config: { hard_stop: true },
      active: false,
    });
    expect(r.success).toBe(true);
    expect((r.data as { active?: boolean }).active).toBe(false);
  });
});
