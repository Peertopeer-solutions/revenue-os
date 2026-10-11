---
name: worker-webhook
description: Use BEFORE touching services/worker — webhook receivers or processors, Hono routes, pg-boss jobs, channel sends, scheduler work. Routes to the S6 webhook doctrine, the org-resolution rule, the write-ownership map, and the worker patterns.
---

# worker-webhook — thin router (AGENTS.md is the rulebook; docs/ is reference)

## Read first, in this order
1. `docs/security.md` S6 — all five controls (webhooks are "the doors that open themselves") + S5.1 (Zod on every boundary) + S5.8 (error hygiene).
2. `docs/db-design.md` §8 — `webhook_events` + the **org-resolution rule**: resolve `org_id` BEFORE insert (a row can't be stored without one).
3. `AGENTS.md` Gotchas — webhooks arrive out of order, the pgboss schema has no RLS (by design), the scheduler index is sacred; the keys behind them are in `supabase/migrations/`.
4. `docs/patterns/zod-boundary.md` (excerpts of real code) · `docs/patterns/hono-route.md` and `docs/patterns/pgboss-worker.md` (no example yet: what a route and a job must still do by hand, and the roadmap lines that bring the real code).
5. `AGENTS.md` Conventions — write ownership: the worker's write set vs the console's; they never cross.
6. `docs/tech-stack.md` T26.4/T26.5 if touching jobs (design intent — check `STATE.md → What works today` for what is real): idempotency as the handler's first lines, the 800ms p95 mid-call tool budget.

## Review-blocking
- Receiver shape. **Do not copy `services/worker/src/vapi/receive.ts`**: it reads the whole request body before it checks the `x-vapi-secret` header, so a caller without the secret can still make it read a body of any size; and it files each event under the company id in the web address, with one secret shared by every company, so whoever holds that secret can file a call result under any company. Slice 2 · "Incoming WhatsApp webhook…" builds the first receiver in the safe shape, and its code becomes this skill's receiver example; Slice 6 · "Before go-live, every control in docs/security.md is ticked…" moves the Vapi secret check before the body is read; Slice 4 · "Voice agent set up from our own agent settings and pushed to Vapi…" gives each company its own Vapi secret and files a call result under the company that owns its assistant. The safe shape: check a header secret (timing-safe) before reading the body, or, for a provider that signs the body (Meta), read it with a size limit and check the signature before parsing it → take the company from what the verified request says, never from the web address alone: the company a per-company secret belongs to, or, when one secret signs for every company (Meta's app secret), the company that owns the business number the verified message was sent to → Zod envelope (its schema in packages/shared) → `webhook_events` insert with a `dedupe_key` under a unique constraint → 202 fast. **Zero side effects in receivers** (AGENTS.md hard rail 6) — processors do the work.
- Unknown event types: stored + skipped, never guessed (docs/security.md S6.5).
- Every write via `withOrg()`; channel sends only through the `packages/channels` doorways, which run `guard()` first (AGENTS.md hard rail 5) — no code path around them.
- Completed conversations require a disposition; outcomes are append-only rows with attribution.

## Commands
`bun run local bun test services/worker` (`bun run local <cmd>` runs a command with the running local stack's settings) · every check: `bun run gate`.

## Learned since this router was written (dynamic — run it, don't skip)
`grep -inE 'webhook|vapi|pg-?boss|worker|hono|cors|dedupe' lessons.md` and read `STATE.md → Decisions in force`.
AGENTS.md, then STATE.md → Decisions in force, decide; a lesson that contradicts this file means this skill needs a refresh.

## Before you finish
AGENTS.md → Definition of done. Contract tests must cover out-of-order + duplicate delivery. Synthetic fixtures are interim — real recorded payloads replace them once a real call or message has flowed (ROADMAP Slices 2 and 4). Production send seams are stubs today: check `STATE.md → What works today`. Browser-shaped surfaces need one browser-shaped verification before "done" (lessons.md 2026-07-11).
