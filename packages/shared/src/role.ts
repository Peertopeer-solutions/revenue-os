// A role version as the engine reads it from its agents row (migration 026; docs/brain.md, part 2): the one schema for
// a version's rules and for the version itself. Everything that makes one role differ from another is here, as data, so
// a new role needs rows, never a change to the engine. A row that fails it is refused, never half-read
// (packages/db/src/agents.ts, liveVersion).
// G1: runtime-agnostic.
import { z } from "zod";
import { ModelRefSchema } from "./models";

// A tool, an outcome, an appointment kind or a facts section: lower-case words joined by underscores.
const Name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// A situation, in plain words, that the role is told to watch for.
const Situation = z.string().trim().min(1).max(500);

/** The next steps a role may take (docs/brain.md, part 8): a message, a call, a time to look again, a hand-over, a stop. */
export const ROLE_ACTIONS = [
  "message",
  "call",
  "check_back",
  "hand_over",
  "stop",
] as const;
const Action = z.enum(ROLE_ACTIONS);
const Max = z.number().int().positive();

/**
 * A role's rules. They can only tighten what the company's settings and the law already allow: an approval rule asks
 * for a person's approval or forbids a tool, and never lets one act on its own.
 */
export const RoleRulesSchema = z
  .strictObject({
    actions: z.array(Action).default([]), // the next steps it may take
    // how often: at most `max` of an action within so many hours, or until the lead replies
    limits: z
      .array(
        z.union([
          z.strictObject({
            action: Action,
            max: Max,
            withinHours: z.number().positive(),
          }),
          z.strictObject({
            action: Action,
            max: Max,
            withoutReply: z.literal(true),
          }),
        ]),
      )
      .default([]),
    askAPerson: z.array(Situation).default([]), // when it asks a person a question and keeps the lead
    handOver: z.array(Situation).default([]), // when it hands the lead to a person
    approval: z.record(Name, z.enum(["approval", "forbidden"])).default({}), // tool name → what it needs
    outcomes: z.array(Name).default([]), // the outcome names it may record
    booking: z.strictObject({ kind: Name, outcome: Name }).optional(), // the appointment kind it books, and its outcome
    holdingMessage: z.string().trim().min(1).max(320).optional(), // its short reply when no model can answer
  })
  .refine((r) => !r.booking || r.outcomes.includes(r.booking.outcome), {
    message: "the outcome a booking records is one of the role's outcome names",
    path: ["booking", "outcome"],
  })
  .refine((r) => r.limits.every((l) => r.actions.includes(l.action)), {
    message: "a limit is on a step the role may take",
    path: ["limits"],
  });
export type RoleRules = z.output<typeof RoleRulesSchema>;

export const ROLE_STATUSES = ["draft", "tested", "active", "archived"] as const;

/** A version's agents row, as read; `active` is live. */
export const RoleVersionSchema = z
  .object({
    id: z.guid(),
    org_id: z.guid().nullable(),
    key: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(ROLE_STATUSES),
    engine: z.enum(["v1", "brain"]),
    model: ModelRefSchema,
    system_prompt: z.string(),
    goal: z.string(),
    rules: RoleRulesSchema,
    tools_allowed: z.array(Name),
    facts_sections: z.array(Name),
    test_set: z.array(z.string().min(1)),
  })
  .transform((r) => ({
    id: r.id,
    orgId: r.org_id,
    key: r.key,
    version: r.version,
    status: r.status,
    engine: r.engine,
    model: r.model,
    prompt: r.system_prompt,
    goal: r.goal,
    rules: r.rules,
    tools: r.tools_allowed,
    factsSections: r.facts_sections,
    testSet: r.test_set,
  }));
export type RoleVersion = z.output<typeof RoleVersionSchema>;

/** Which role works a lead (agent_assignments): working it, paused, handed to a person, or ended. */
export const ASSIGNMENT_STATUSES = [
  "active",
  "paused",
  "with_person",
  "ended",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** A person setting which role works a lead, and why (PUT /orgs/:orgId/contacts/:contactId/assignment). */
export const AssignmentInputSchema = z.strictObject({
  roleKey: z.string().trim().min(1).max(100),
  status: z.enum(ASSIGNMENT_STATUSES),
  why: z.string().trim().min(1).max(500),
});
