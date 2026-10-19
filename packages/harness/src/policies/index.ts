// The guard() pipeline: config-driven checks that run before ANY side effect (docs/security.md S8.2; AGENTS.md:
// guardrails run before every send, with no code path around them). Hooks are ordered; first failing verdict wins.
// One check per file: approval (autonomy.ts), do-not-call (do-not-call.ts), WhatsApp opt-in (whatsapp-opt-in.ts),
// calling hours (calling-hours.ts) and the attempt limit (attempt-cap.ts); all but the first read only the company's
// own guardrail_policies rows, contacts and runs. pipeline.ts orders them and runs them. A spending limit does not
// exist yet. The product calls guard() alone; tests import each check from its own file.
// G1: runtime-agnostic.
export { guard } from "./pipeline";
