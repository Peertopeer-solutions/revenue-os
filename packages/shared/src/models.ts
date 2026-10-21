// The platform's model list: the AI models a role version may name, each as `provider:model-id` (agents.model, migration
// 026). A version naming any other is refused when the engine reads it (RoleVersionSchema, ./role.ts), and the model
// client sends only the id of a model listed here (packages/harness/src/llm/anthropic.ts). Seeded roles name Claude
// Sonnet 5.5 (docs/decisions-in-force/2026-10-21-the-seeded-roles-default-to-claude-sonnet-5-5.md); a role moves to
// another model only as a new version.
// Prices are Anthropic's first-party rates per million tokens, read from the claude-api reference (cached 2026-10-06);
// Haiku 5.5's are for prompts up to 100,000 tokens ($0.50 / $2.50 beyond). Money is metered from them in Slice 6.
// G1: runtime-agnostic.
import { z } from "zod";

export type Model = {
  provider: "anthropic";
  id: string; // the provider's own name for it, as its API takes it
  contextTokens: number;
  pricePerMillionTokens: { currency: "USD"; input: number; output: number };
};

export const MODELS = {
  "anthropic:claude-opus-5-5": {
    provider: "anthropic",
    id: "claude-opus-5-5",
    contextTokens: 1_000_000,
    pricePerMillionTokens: { currency: "USD", input: 4, output: 20 },
  },
  "anthropic:claude-sonnet-5-5": {
    provider: "anthropic",
    id: "claude-sonnet-5-5",
    contextTokens: 1_000_000,
    pricePerMillionTokens: { currency: "USD", input: 2, output: 10 },
  },
  "anthropic:claude-haiku-5-5": {
    provider: "anthropic",
    id: "claude-haiku-5-5",
    contextTokens: 1_000_000,
    pricePerMillionTokens: { currency: "USD", input: 0.1, output: 0.5 },
  },
} as const satisfies Record<string, Model>;

export type ModelRef = keyof typeof MODELS;

/** A model a version may name: one on the list, written `provider:model-id`. */
export const ModelRefSchema = z.enum(Object.keys(MODELS) as [ModelRef]);

/** The listed model `ref` names, or undefined when it names none. */
export const modelOf = (ref: string): Model | undefined =>
  Object.hasOwn(MODELS, ref) ? MODELS[ref as ModelRef] : undefined;
