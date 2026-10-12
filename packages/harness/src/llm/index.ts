// The model client's sub-barrel: the Anthropic adapter, raw fetch with no SDK (docs/tech-stack.md T19). The live
// worker builds its client from it in services/worker/src/jobs.ts (makeProvider) and hands it to each job handler;
// tests use a scripted fake behind the same LlmProvider interface (src/types.ts).
// G1: runtime-agnostic.
export { createAnthropicProvider } from "./anthropic";
