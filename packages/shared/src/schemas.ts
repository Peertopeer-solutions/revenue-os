// Boundary truth (AGENTS.md → Conventions: Zod at every boundary): every boundary parses with these — never
// re-declare shapes locally.
import { z } from "zod";

export const OrgIdSchema = z.string().uuid();
export const ConversationIdSchema = z.string().uuid();
export const ContactIdSchema = z.string().uuid();
// What the console's contacts list is searched by: a lead's name, or digits of their number.
export const ContactSearchSchema = z.string().max(100).optional();
// Where a lead gave (or withdrew) their WhatsApp opt-in, as a person records it: the event, form or list, in words.
export const WhatsAppOptInSchema = z.strictObject({
  source: z.string().trim().min(1).max(200),
});

export const OrgRoleSchema = z.enum(["admin", "operator", "viewer"]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

export const CreateOrgSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    vertical: z.string().min(1).max(40).default("generic"),
  })
  .strict();
export type CreateOrg = z.infer<typeof CreateOrgSchema>;

export const AddMemberSchema = z
  .object({
    userId: z.string().uuid(),
    role: OrgRoleSchema,
  })
  .strict();
export type AddMember = z.infer<typeof AddMemberSchema>;

export const UpdateOrgSchema = z
  .object({
    name: z.string().min(1).max(120),
  })
  .strict();
export type UpdateOrg = z.infer<typeof UpdateOrgSchema>;

// Guardrail-policy config is the SAFETY BOUNDARY. The harness quiet_hours hook reads
// guardrail_policies.config FAIL-OPEN (packages/harness/src/policies/calling-hours.ts): a malformed config
// silently disables the gate for every send. This strict discriminated union is what stops a bad
// config reaching the row — the PUT route parses it before any write. One union export is the whole
// boundary (never re-declared in the route or the console). HH:MM regex is verbatim from the harness.
const GUARDRAIL_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const AttemptCap = z.strictObject({
  max: z.number().int().positive(),
  per_hours: z.number().positive(),
});
export const GuardrailPolicyInputSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("quiet_hours"),
      config: z.strictObject({
        start: z.string().regex(GUARDRAIL_HHMM),
        end: z.string().regex(GUARDRAIL_HHMM),
        tz: z.string().min(1),
      }),
      active: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      // Partial channel maps allowed: an org may cap voice only. strict rejects unknown channels;
      // the harness treats a missing channel as no-cap by design.
      key: z.literal("attempt_caps"),
      config: z.strictObject({
        voice: AttemptCap.optional(),
        whatsapp: AttemptCap.optional(),
      }),
      active: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      key: z.literal("dnc"),
      config: z.strictObject({ hard_stop: z.boolean() }),
      active: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      key: z.literal("autonomy"),
      config: z.record(
        z.string().min(1),
        z.enum(["auto", "approval", "forbidden"]),
      ),
      active: z.boolean().default(true),
    })
    .strict(),
]);
export type GuardrailPolicyInput = z.infer<typeof GuardrailPolicyInputSchema>;

// Vapi webhook envelope — only the fields we consume; everything else passes through
// untouched (payloads stay untrusted even after the secret check).
export const VapiWebhookSchema = z
  .object({
    message: z
      .object({
        type: z.string(),
        id: z.string().optional(),
        // Vapi sends epoch milliseconds (its API reference types it a double); a string is taken as Postgres reads it.
        timestamp: z.union([z.number(), z.string()]).optional(),
        call: z.object({ id: z.string() }).passthrough().optional(),
        role: z.enum(["assistant", "user"]).optional(),
        transcript: z.string().optional(),
        summary: z.string().optional(),
        endedReason: z.string().optional(),
        // An end-of-call report's own start and end of the call, as ISO times.
        startedAt: z.string().optional(),
        endedAt: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type VapiWebhook = z.infer<typeof VapiWebhookSchema>;
// The AI's reading of a call, in its end-of-call report: the analysis' structured data, which the assistant's analysis
// plan asks for. Only an explicit `doNotCall: true` counts, and it may only add a do-not-call block, never lift one
// or grant consent (docs/decisions-in-force/2026-09-29-a-do-not-call-block-may-come-from-the-ai-s-reading-of-a.md).
export const VapiReadingSaysDoNotCallSchema = z.object({
  analysis: z.object({
    structuredData: z.object({ doNotCall: z.literal(true) }),
  }),
});
// The number a call's lead called from or was called on: the message's customer, or its call's (Vapi's
// CreateCustomerDTO). Read on its own, so a report with another shape there is still filed.
export const VapiCustomerSchema = z.object({
  customer: z.object({ number: z.string() }),
});

// ── Eval scenarios — the three JSONB columns of eval_scenarios. A row that fails ANY
//    of these is a malformed scenario: the eval runner records it and fails ONLY that scenario,
//    never the whole run. Extra keys pass through (.passthrough) so assertions can carry future
//    v2 checks the mechanical engine does not yet read.
export const ScenarioPersonaSchema = z
  .object({
    name: z.string().min(1),
    traits: z.array(z.string()).optional(),
    language: z.string().optional(),
  })
  .passthrough();
export type ScenarioPersona = z.infer<typeof ScenarioPersonaSchema>;

export const ScenarioScriptSchema = z.object({ turns: z.array(z.string()) });
export type ScenarioScript = z.infer<typeof ScenarioScriptSchema>;

export const ScenarioAssertionsSchema = z
  .object({
    must_capture: z.array(z.string()).optional(),
    expect_outcome: z.string().optional(),
  })
  .passthrough();
export type ScenarioAssertions = z.infer<typeof ScenarioAssertionsSchema>;
