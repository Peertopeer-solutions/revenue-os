// A role version's shape (packages/shared/src/role.ts) and the platform's model list (models.ts): what a version may
// name, read from its agents row. The engine refuses any row these refuse, so a role can't run on a model off the list
// or with rules nothing checks.
import { describe, expect, it } from "bun:test";
import {
  MODELS,
  ModelRefSchema,
  modelOf,
  RoleRulesSchema,
  RoleVersionSchema,
} from "../src";

const row = {
  id: "11111111-1111-1111-1111-111111111111",
  org_id: "22222222-2222-2222-2222-222222222222",
  key: "sales",
  version: 3,
  status: "active",
  engine: "v1",
  model: "anthropic:claude-sonnet-5-5",
  system_prompt: "You help buyers.",
  goal: "Every enquiry gets a booked meeting or a clear no.",
  rules: {
    actions: ["message", "call", "hand_over"],
    limits: [
      { action: "call", max: 3, withinHours: 72 },
      { action: "message", max: 2, withoutReply: true },
    ],
    askAPerson: ["the lead asks for a figure the facts don't hold"],
    handOver: ["the lead asks for a manager"],
    approval: { send_confirmation: "approval" },
    outcomes: ["meeting_booked"],
    booking: { kind: "meeting", outcome: "meeting_booked" },
  },
  tools_allowed: ["book_appointment", "send_confirmation"],
  facts_sections: ["projects", "calendar"],
  test_set: ["after_diwali", "stop_contacting_me"],
};

describe("the platform's model list", () => {
  it("names each model as provider:model-id with its provider's id, context size and price", () => {
    expect(modelOf("anthropic:claude-sonnet-5-5")).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-5-5",
      contextTokens: 1_000_000,
      pricePerMillionTokens: { currency: "USD", input: 2, output: 10 },
    });
    for (const [ref, m] of Object.entries(MODELS))
      expect(ref).toBe(`${m.provider}:${m.id}`);
    expect(ModelRefSchema.safeParse("anthropic:claude-opus-5-5").success).toBe(
      true,
    );
  });

  it("names none for a tier name, a bare id, another provider or a name inherited from Object", () => {
    for (const ref of [
      "realtime-tier",
      "claude-sonnet-5-5",
      "openai:gpt-5",
      "toString",
      "",
    ]) {
      expect(modelOf(ref)).toBeUndefined();
      expect(ModelRefSchema.safeParse(ref).success).toBe(false);
    }
  });
});

describe("a role version, read from its row", () => {
  it("reads every part of the role: model, prompt, goal, rules, tools, facts sections and test set", () => {
    expect(RoleVersionSchema.parse(row)).toEqual({
      id: row.id,
      orgId: row.org_id,
      key: "sales",
      version: 3,
      status: "active",
      engine: "v1",
      model: "anthropic:claude-sonnet-5-5",
      prompt: "You help buyers.",
      goal: row.goal,
      rules: row.rules,
      tools: row.tools_allowed,
      factsSections: row.facts_sections,
      testSet: row.test_set,
    });
  });

  it("fills an empty rules object with rules that allow nothing", () => {
    expect(RoleRulesSchema.parse({})).toEqual({
      actions: [],
      limits: [],
      askAPerson: [],
      handOver: [],
      approval: {},
      outcomes: [],
    });
  });

  it("refuses a model off the list, a status or engine it doesn't know, and a tool name that isn't a word", () => {
    for (const bad of [
      { model: "realtime-tier" },
      { model: "claude-opus-4-8" },
      { status: "live" },
      { engine: "v2" },
      { tools_allowed: ["Book Appointment"] },
      { facts_sections: [""] },
      { test_set: [""] },
    ])
      expect(RoleVersionSchema.safeParse({ ...row, ...bad }).success).toBe(
        false,
      );
  });

  it("refuses rules that would loosen a setting, name an unknown field, or don't agree with themselves", () => {
    const rules = row.rules;
    for (const bad of [
      { ...rules, approval: { book_appointment: "auto" } }, // an approval rule only tightens
      { ...rules, sendsAnything: true },
      { ...rules, actions: ["message", "dance"] },
      { ...rules, booking: { kind: "meeting", outcome: "deal_won" } }, // not one of its outcomes
      { ...rules, limits: [{ action: "stop", max: 1, withinHours: 1 }] }, // a step it may not take
      { ...rules, limits: [{ action: "call", max: 0, withinHours: 1 }] },
      {
        ...rules,
        limits: [{ action: "call", max: 1, withinHours: 1, withoutReply: true }],
      },
      { ...rules, handOver: ["  "] },
      { ...rules, holdingMessage: "x".repeat(321) },
    ])
      expect(RoleRulesSchema.safeParse(bad).success).toBe(false);
  });
});
