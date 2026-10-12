---
name: harness-agent
description: Use BEFORE touching packages/harness — the turn loop, tools, guard() hooks, LLM adapters, context/retrieval, metering, or agent/workflow config. Routes to the harness design (tech-stack T26, reference), the moat rules in AGENTS.md, and the harness patterns.
---

# harness-agent — thin router (AGENTS.md is the rulebook; docs/ is reference)

## Read first, in this order (only the § your task touches)
0. `STATE.md → What works today` — T26 describes a design that is only partly built; the code is the truth.
1. `docs/tech-stack.md` T26.1 — module map: file → responsibility → exact interface. `OrgScopedDb` (`packages/harness/src/types.ts`) is the ONLY door to data; shared contract types are in src/types.ts, a module's own types sit next to it (src/workflow/schema.ts).
2. The T26 § that owns your change: T26.2 workflow JSON (frozen: see below) · T26.3 agent-config anatomy · T26.4 jobs/durability (closed job-type set; idempotency first lines) · T26.5 the turn loop · T26.6 retrieval + token budgets (system ≤1.5k · KB ≤2k · memories ≤800 · tail ≤3k · tools ≤600) · T26.7 vertical = config rows, never harness code · **T26.8 non-goals — read before adding anything**.
3. `docs/tech-stack.md` T19 (LLM adapters: raw fetch, model tiers) · T11/`docs/patterns/zod-boundary.md` (args validated BEFORE anything runs) · `docs/patterns/pgboss-worker.md` if jobs.
4. Existing code is the spec made real: `packages/harness/src/loop.ts` (the T26.5 order: context → complete → meter → parse → guard → execute → audit → append rows) and `test/loop.test.ts`.

## Review-blocking (AGENTS.md moat rules and harness conventions)
- **guard() before ANY side effect; no code path around it.** Approval-gated ⇒ a `tasks` row, never a silent drop. Hooks tighten, never loosen, a tool's default autonomy.
- Stateless loop: every effect is a row; a crash mid-turn loses nothing. No in-memory conversation state, no queues outside pg-boss.
- Zod-parse tool args before `execute()` (hallucination seatbelt); unknown/unallowed tool ⇒ recorded error row.
- Every priced action ⇒ `usage_events`; every executed side effect ⇒ `audit_log`.
- Agents/workflows are versioned — mutating an active version is a bug; eval gate before activation.
- G1: no `bun:*`/`Bun.` in packages/** (lint-enforced). All DB access through the injected `OrgScopedDb` (withOrg tx upstream), with the company filter in every query (AGENTS.md → Conventions → Database access).
- The fixed step map in `packages/harness/src/workflow/` is frozen until Slice 3 deletes it: no new step kinds and no new logic that branches on the call's one-word result (moving where that result arrives is allowed; STATE.md → Decisions in force holds the decision). The verifier rules FAIL on either.

## Commands
every check `bun run gate` · one scripted lead driven through the real engine, in a throwaway company of its own, `bun run demo` · the eval suite `bun run evals` (it can't find a company today: see STATE.md → What works today).

## Learned since this router was written (dynamic — run it, don't skip)
`grep -inE 'harness|guard|tool|T26|LLM|turn|autonomy' lessons.md` and read `STATE.md → Decisions in force`.
AGENTS.md, then STATE.md → Decisions in force, decide; a lesson that contradicts this file means this skill needs a refresh.
