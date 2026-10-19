# Tech Stack & SDLC Decisions — v2

> **Reference, not rules.** Why each part of the stack was chosen. Much of Part I·b (T26, the agent harness) describes a design that is only partly built — check `STATE.md → What works today` before relying on any of it. Rules live in `AGENTS.md`; what exists today is in `STATE.md`; the plan is `ROADMAP.md`. Where this file and the code disagree, the code is right.
> **Companions:** `docs/db-design.md` (schema intent), `docs/security.md` (security controls — S-ids). The old ID registry lives in `docs/archive/project-spec.md` §0.
> **ID prefix:** T = tech decision (historical; no new prefixes are added — see `AGENTS.md → Docs`).
> **Numbering policy:** ids are append-only citations — assigned in creation order, never renumbered or reused, even when the document is reorganized (the RFC/CVE/ADR discipline: stable identity beats pretty sequence). Sections are placed thematically, ascending within each part. **Index:** Part I core = T1–T11 · Part I·b harness = T26 · Part II data = T16–T19 · Part III delivery = T12–T15 + T20–T25.

---

## 0. Principles

1. **Boring beats clever** — unless the new thing deletes whole categories of work.
2. **Reversible beats optimal** — every decision states its escape hatch.
3. **Solo + AI velocity counts** — pick what Claude Code writes best; where a library is newer, we control fluency via `docs/patterns/` (T5).
4. **Stateless may self-host; state may not.**
5. **Fewest moving parts that still enforce the invariants** — RLS, guardrails, metering, evals are never simplified away.
6. **Taste is allowed** — genuine-taste calls are labeled as such, picked once, and closed.
7. **Platform before packages** — prefer `fetch`, `crypto`, `Intl`, `URL` over dependencies (see T24 BOM).

---

# Part I — Core platform

## T1 · Runtime & toolchain — **Bun** (final, contradiction resolved)

**Decision (two distinct commitments):**
- **Bun as toolchain — unconditional.** Package manager, test runner (`bun test`), script runner, dev loop (`bun --watch`), native `.env` loading, native TS. No fallback exists or is needed; this also deletes pnpm, Vitest, tsx, nodemon, and dotenv from the BOM.
- **Bun as production runtime — with one escape hatch.** The worker/API container runs Bun. The fallback is the Docker base image (`oven/bun` → `node:22`), a one-line change.

**Guardrails (revised — the old "Node CI test lane" was incoherent because `bun:test` files can't run on Node; Devesh caught it):**
- **G1 — runtime-agnostic packages, lint-enforced.** No `bun:*` imports and no `Bun.` globals in `packages/*` (Bun-specific code lives only in app entrypoints). Enforced by Biome's restricted-imports rule — or a 20-line CI grep script if the rule tier shifts. This is what keeps the base-image fallback a one-day job instead of a rewrite.
- **G2 — version pinning.** Exact Bun version in `package.json` `engines`, CI, and Dockerfile. Upgrades are deliberate PRs, never automatic.
- **G3 — the fallback is documented, not yet rehearsed.** `docs/archive/runbooks/node-fallback.md`: swap base image, replace `Bun.serve` entrypoint with the Hono Node adapter, redeploy. The planned rehearsal never happened.

**Straight answer to "can we afford it / only benefits?":** We can afford it. Nothing "only benefits"; Bun's net is strongly positive for this team (single toolchain, faster loop, fewer deps), and its one material risk is the `pg` driver under sustained pg-boss load — settled by the P2 load test, insured by G1+G3.

## T2 · Language — **TypeScript strict** (non-negotiable)

With AI writing most code, the type system is reviewer #1: shape mistakes become compile errors, monorepo refactors become mechanical. Zod (T11) supplies runtime validation at boundaries from the same definitions.

## T3 · Console app — **Vite + React SPA**

Four live screens (streaming transcript, task queue with claim/complete, org switcher, disposition tagging) behind a login: zero SEO, zero SSR need. React because live UI = UI as a function of state; Vite because it's the boring fast default. No meta-framework, no state library beyond TanStack Query (T24), no mandated UI kit.
**The vanilla/jQuery objection (answered in v1, kept):** these screens are manual-DOM-sync bug farms without a reactive model; Claude Code's React output is far more reliable than large jQuery apps; components reuse across screens.
**"But we need an SEO landing page" → that's T15**, a separate app. The console never needed SEO; the company does.

## T4 · Styling — **Tailwind + ~10 hand-rolled components** *(taste, closed)*

Tailwind deletes CSS's two hard problems at scale — naming and consistency — and compiles to plain CSS with no runtime (v4, no PostCSS config). shadcn components may be copied in individually when one saves real time; never as a framework. Fallback if utilities grate by week 5: CSS Modules.

## T5 · API framework — **Hono on Bun**

Tiny, Web-standards-based (`Request`/`Response`), first-class Bun support, runtime-portable (Node/Bun/Workers — keeps G3 and D22 doors open). Serves console BFF + webhook receivers **in the same process as the worker** at V1.
**"Is Claude fluent in Hono?"** Yes — heavily used by 2026, and its surface is mostly Web standards the model knows cold. Belt-and-braces convention regardless: **`docs/patterns/` holds the examples to copy**, each an excerpt of real code or marked "do not copy" with the roadmap line that brings the real code (AGENTS.md → Docs; `bun run guards` checks every excerpt against its file); AGENTS.md directs agents to imitate local patterns over global memory. AI agents copy the repo more reliably than the internet; the repo is ours.

## T6 · DB access — **parameterised SQL on the `pg` driver + raw SQL migrations**

Every query is parameterised SQL through `tx.query` inside `withOrg` (`packages/db/src/client.ts`; `docs/patterns/drizzle-query.md` shows one). Drizzle was planned for typed queries, but no query uses it. All DDL lives in `supabase/migrations/`, each change a new migration written for it, never copied from db-design.md.
**Driver unification:** pg-boss requires `pg` (node-postgres), and the queries use it too, so the stack has **exactly one Postgres driver**. One pool, one config, one compat surface to watch on Bun.

## T7 · Jobs & durability — **pg-boss (muscle) + `workflow_runs` (memory)**

Unchanged decision; now with the mental model spelled out — **read Appendix A** for the crash course Devesh requested. Summary: pg-boss executes single reliable *steps* (claim via `SKIP LOCKED`, retry with backoff, schedule future jobs) on the Postgres we already run; `workflow_runs` remembers *where each contact is in a multi-week sequence* (`current_step`, `wake_at`, `attempts`). Durability = the plan lives in rows, not RAM; crashes lose nothing. Temporal remains the documented swap-in behind the same table (db-design §11).

## T8 · Hosting & regions — **Mumbai-anchored; stateless self-hosted**

**What runs where (the box Devesh asked for):**

| Component | Contains | Runs on |
|---|---|---|
| **Worker+API process** (the "worker" = **the agentic harness**) | agent loop, prioritization scheduler, pg-boss consumers, Hono BFF, Vapi/Meta webhook receivers, pino | One VPS, Docker + Caddy, GH Actions SSH deploy |
| Console | static SPA files | Cloudflare Pages |
| Marketing site (T15) | static Astro files | Cloudflare Pages |
| State | Postgres, auth, storage, realtime | Supabase |

**Regions (India-first — revised from v1's Hetzner default, which has no India location):**
- **Supabase project: Mumbai (`ap-south-1`).** Data locality for Indian tenants (DPDP-friendly), low latency for console + tool-call queries.
- **VPS: DigitalOcean Bangalore (BLR1) or Vultr Mumbai**, ~$6–12/mo. Cloudflare's Indian POPs serve Pages/edge locally.
- **Voice latency truth:** the VPS is **not in the audio path** — live audio runs caller ↔ telephony ↔ Vapi's media/ASR/LLM/TTS stack. The VPS *is* in the path for mid-call **tool calls** (Vapi → our server → response), which is one reason it sits in India and why the task-8 spike measures full round trips on real Indian mobile calls. See T10 VQG.
- Origin lockdown (only Cloudflare can reach the VPS, SSH hardening, etc.): **`security.md` S3.**

**State never self-hosts at this stage** (D13). Railway/Fly remain the sanctioned lazy path — same Docker image.

## T9 · Auth — **Supabase Auth + `jose` for server-side JWT verification**

Console: `@supabase/supabase-js` (PKCE flow). Worker/API: verify JWTs with `jose` (issuer/audience/exp checks) — no heavyweight SDK needed server-side. Machines: hashed `api_keys` (db-design §4). Enterprise SAML later via WorkOS *alongside*, on demand.

## T10 · Voice & channels — **Vapi + Meta WhatsApp Cloud API, gated by VQG**

Decision unchanged (owned interface in `packages/channels`; Vapi is an implementation behind it; Indian SIP spike = task 8, week 3). **New: the Voice Quality Gate (VQG)** — Devesh's requirement formalized with honest physics:

- **Metric definition:** voice-to-voice latency = end of caller speech → first agent audio, measured on **real Indian mobile-network calls**, logged per turn into `conversations.qa`.
- **Initial targets (calibrate after the task-8 spike):** p50 ≤ **800ms**, p90 ≤ **1200ms**, p99 ≤ **1800ms**. Sub-800ms **p99** with an LLM in the loop over Indian carriers is beyond today's state of the art industry-wide — leading stacks land ~700–900ms *median*; the gate is set where excellent is achievable and measurable, and tightens as the stack improves.
- **Language bar:** Hinglish/Hindi eval-persona suite scores ≥ threshold (comprehension, code-switch handling, forbidden-claims = 0) before activation — same eval gate machinery as everything else.
- **Latency levers, in order of payoff:** fast realtime model tier; streaming at every hop; endpointing/silence tuning; Indic-optimized TTS (Sarvam-class) per language; **sub-300ms acknowledgment sounds/backchannels** (perceived latency collapses even when compute latency can't); prompt slimming; tool-call parallelism and speculative work.
- **The gate rule (matches "POC first, flawless before clients"):** VQG **gates M3** — no client-workflow integration until it passes. M1 (talking demo) and M2 (lifecycle demo) proceed as proving grounds.

## T11 · Validation — **Zod at every boundary**

Webhook payloads, API requests, tool-call arguments (the seatbelt between a hallucinated argument and the database), JSONB writes against `field_definitions`. Schemas in `packages/shared` are the single source of shape truth for API and console.

---

# Part I·b — The agentic harness (the crown of the system)

## T26 · Harness architecture — the complete specification (zero guesswork edition)

**What it IS:** a TypeScript package. Not a framework, not magic — a set of modules with explicit interfaces over the tables in db-design.md. A "framework" is someone else's TS files with opinions you can't change; this is ours, and this section pins every opinion so no future session invents one.

### T26.1 Module map (file → responsibility → exact interface)

```
packages/harness/src/
├─ types.ts        # every shared type below lives here, nowhere else
├─ registry.ts     # tool registration + lookup
├─ loop.ts         # the async turn loop
├─ context.ts      # prompt assembly
├─ policies/       # guard() pipeline, one file per check
├─ retrieval.ts    # KB + memory retrieval
├─ memory.ts       # post-call memory writes
├─ llm/            # provider adapters (anthropic.ts, openai.ts) behind one interface
├─ workflow/
│  ├─ schema.ts    # WorkflowDefinition zod schema (the JSON format, below)
│  └─ interpret.ts # pure interpreter: (definition, runState, event) → Transition
├─ scoring/
│  ├─ heuristic.ts # v1 scorer
│  └─ features.ts  # feature extraction (snapshot into contact_scores.features)
├─ audit.ts        # emit(audit_log) — called by every side effect
└─ meter.ts        # emit(usage_events) — called by every priced action
```

```ts
// ---- types.ts (the contracts everything else obeys) ----
type OrgCtx = { orgId: string; db: OrgScopedDb };            // from packages/db.withOrg — the ONLY door

interface Tool<I> {
  name: string; description: string;
  schema: z.ZodType<I>;                                       // args validated BEFORE anything runs
  autonomy: "auto" | "approval" | "forbidden";                // default; org guardrail_policies may tighten
  execute(ctx: OrgCtx, args: I): Promise<ToolResult>;
}
type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

interface LlmProvider {                                       // llm/ — selected by config string, e.g. "anthropic:fast"
  complete(req: { system: string; messages: Msg[]; tools?: ToolSpec[];
                  maxTokens: number; timeoutMs: number }): Promise<LlmTurn>;
}
type LlmTurn = { text?: string; toolCalls?: { name: string; args: unknown }[];
                 usage: { in: number; out: number } };

type Verdict = { ok: true } | { ok: false; reason: "dnc"|"quiet_hours"|"attempt_cap"|"approval_required"|"spend_cap" };

type Transition = { actions: Action[]; nextStep: string | null; wakeAt: Date | null; runStatus: RunStatus };
type Action =
  | { kind: "place_call";  contactId: string; agentKey: string }
  | { kind: "send_wa";     contactId: string; template: string; vars: Record<string,string> }
  | { kind: "run_agent_turn"; conversationId: string }
  | { kind: "create_task"; task: TaskDraft }
  | { kind: "write_outcome"; outcome: OutcomeDraft };
```

### T26.2 Workflow definition format — the JSON, explicitly

Stored in `workflows.definition`, validated by `workflow/schema.ts`. Step kinds are a **closed set**; adding one is a code change + ADR, never ad-hoc JSON.

```jsonc
{ "entry": "call_1",
  "steps": {
    "call_1":  { "kind": "call",   "agent": "qualifier",
                 "on": { "completed": "route", "no_answer": "wa_1", "busy": "wa_1", "failed": "wa_1" } },
    "wa_1":    { "kind": "wait",   "for": "PT2H", "then": "wa_send" },
    "wa_send": { "kind": "whatsapp", "template": "followup_1", "then": "call_2_wait" },
    "call_2_wait": { "kind": "wait_until", "localTime": "11:00", "then": "call_2" },
    "call_2":  { "kind": "call",   "agent": "qualifier",
                 "on": { "completed": "route", "no_answer": "give_up" } },
    "route":   { "kind": "branch", "onDisposition": { "qualified": "task_human",
                 "callback": "task_human", "dnc": "end", "*": "end" } },
    "task_human": { "kind": "tool", "tool": "create_task",
                 "args": { "kind": "callback" }, "then": "end" },
    "give_up": { "kind": "tool", "tool": "create_task", "args": { "kind": "review" }, "then": "end" },
    "end":     { "kind": "end" } } }
```

**Interpreter semantics (`interpret.ts`): a pure function.** `(definition, run.state, event) → Transition`. No I/O inside — which makes it trivially unit-testable and means durability lives entirely in the tables, never in the interpreter. Guardrail checks are NOT here (they're per-action in the executor) so a policy change never requires re-interpreting.

### T26.3 Agent config anatomy (`agents` row → runtime meaning)

| Column | Consumed by | Effect |
|---|---|---|
| `model` (e.g. "anthropic:fast") | llm/ adapter selection · Vapi assistant sync | which brain, per surface |
| `system_prompt` | context.ts (async) · Vapi assistant (realtime) | the personality + rules evals test |
| `tools_allowed[]` | registry lookup = registry ∩ this list | capability allow-list — S8.1 boundary |
| `voice_config` | packages/channels/vapi assistant sync job | per-language ASR/TTS map, first message |
| `language_config` | channels + context | detection policy, supported langs |
| `key`+`version`, `status` | everywhere via FK | immutability + "which prompt produced this call?" |

A `sync_vapi_assistant` job pushes active agent versions to Vapi via API; the Vapi assistant id is stored in `agents` metadata — **config flows one way: our rows → provider, never hand-edited in Vapi's dashboard.**

### T26.4 Jobs & durability — the exact wiring

**pg-boss job types (closed set, `services/worker` registers all handlers):**

| Job | Payload | Handler does |
|---|---|---|
| `scheduler.tick` (cron 30s, singleton) | — | query due runs → interpret → enqueue actions → update runs |
| `run.place_call` | runId, contactId, agentId | guard("voice") → channels.voice.place → run: waiting on provider_ref |
| `run.send_wa` | runId, template, vars | guard("whatsapp") → channels.wa.send → advance run |
| `agent.turn` | conversationId | async loop turn (T26.5) for non-voice channels |
| `call.post` | conversationId | summarize + extract + memory.write + require-disposition task if untagged |
| `score.contact` | contactId, trigger | features.extract → heuristic → contact_scores insert + tasks.priority update |
| `kb.ingest` | documentId | chunk → embed → knowledge_chunks; status ready/failed |
| `assistant.sync` | agentId | push agent version → Vapi |
| `webhook.process.vapi` | webhookEventId | receiver-enqueued drain of a `webhook_events` row; org id rides the job payload because RLS makes a cross-org sweep impossible for `app_service` |

**The scheduler tick, precisely:** `SELECT … FROM workflow_runs WHERE status IN ('pending','waiting') AND wake_at <= now() FOR UPDATE SKIP LOCKED LIMIT 50` → for each: load pinned workflow version → `interpret(def, state, {type:'wake'})` → inside **one transaction**: insert pg-boss jobs for `Transition.actions` + update the run (nextStep/wakeAt/status). Same-DB queue = job enqueue and state advance commit atomically — the exactly-once glue Temporal sells, at our size, for free.

**Idempotency rules (every handler, first lines):** reload run → if status/current_step no longer expects this job → return (stale duplicate = no-op). Provider events reconcile by `conversations.provider_ref` upsert. Retries: pg-boss backoff `retryLimit: 3, retryDelay: 60s, expireInMinutes: 15`; poisoned jobs land in a dead-letter task (`kind:'review'`) — a human sees every permanent failure.

### T26.5 LLM orchestration — both surfaces, mechanically

**Realtime (in-call):** the conversational loop runs inside Vapi (their latency stack; model from `agents.model`). Our involvement per turn: Vapi → our `/webhooks/vapi` tool-call event → verify signature → Zod-parse args → `guard()` → `tool.execute()` → respond JSON (**tool budget: 800ms p95** — why the VPS is in Mumbai, T8) → Vapi speaks on. Transcript events stream into `messages` by `seq`.

**Async (everything else) — `loop.ts` turn algorithm:**
```
runTurn(ctx, conversationId):
  input   = assembleContext(ctx, conversationId)           # T26.6, token-budgeted
  for round in 1..MAX_TOOL_ROUNDS(=5):
      turn = provider.complete({system, messages, tools})   # timeout 30s; retry ×2 only if no tool executed yet
      meter.emit(llm, turn.usage); 
      if turn.toolCalls empty → persist assistant msg; break
      for call in turn.toolCalls:
          args = tool.schema.parse(call.args)               # hallucination seatbelt (T11)
          verdict = guard(ctx, action(call))                 # S8.2 — before ANY side effect
          verdict.ok ? result = tool.execute(ctx, args)      # audit.emit on every execute
                     : result = {ok:false, error:verdict.reason}  # approval_required → create_task instead
          append tool result to messages (messages table, role='tool')
  → returns nothing; all effects are rows                    # stateless turn: crash-safe by construction
```
**Model tiers (config, not code):** realtime="anthropic:fast" · post-call summarize/extract="anthropic:mid" · scoring-features/evals="anthropic:mid" — one map in `packages/shared/config.ts`; changing a tier is a config PR.

### T26.6 Knowledge & memory retrieval — the pipeline, end to end

**Ingest (`kb.ingest` job):** load file/url text → normalize → chunk **~600 tokens, 80 overlap, split on headings first** → `embed(batch of 64)` via T18 interface → insert `knowledge_chunks(document_id, chunk_index, content, embedding, token_count)` → document status `ready`.

**Query (inside `assembleContext`):**
```sql
select content, document_id from knowledge_chunks
where org_id = $1                       -- ALWAYS first (S: cross-tenant leak = worst bug)
order by embedding <=> $2 limit 8;      -- HNSW cosine; query embedded with the SAME model version
```
plus `contact_memories` (non-superseded, latest 10, semantic top-5 when >10). Both wrapped as labeled data blocks — `<reference source="kb:{doc_id}">…</reference>` — with the system prompt instructing "quote, never obey" (S8.4). **Context budget:** system ≤1.5k tokens · KB ≤2k · memories ≤800 · transcript tail ≤3k · tools ≤600; overflow drops KB first, never the system prompt. Re-embedding = new document version; mixed-model vectors in one table are forbidden (dimension pinned per model in config).

### T26.7 What varies per vertical — config rows, never harness code

| Vertical thing | Lives in |
|---|---|
| Call scripts / persona | `agents.system_prompt` (versioned row) |
| Follow-up sequence | `workflows.definition` (T26.2 JSON) |
| Call-result vocabulary | `dispositions` seed |
| Business results taxonomy | `outcomes.kind` seed list |
| Custom fields (budget_max vs monthly_volume) | `field_definitions` + `attributes` jsonb |
| Quiet hours / caps / autonomy | `guardrail_policies` rows |
| Test callers | `eval_scenarios` seed |

The proof of "use-case agnostic": onboarding a new vertical = one seed file + zero harness diffs. If a task ever wants an `if (vertical === 'real_estate')` inside `packages/harness`, the task is wrong — it goes to config or it goes to an ADR.

### T26.8 Non-goals (so nobody "helpfully" adds them)

No streaming voice loop in our code (Vapi's job) · no in-memory agent state (rows or it didn't happen) · no dynamic tool creation by the model · no framework adoption (D15) · no per-vertical code paths (T26.7) · no vector DB, no Redis, no second queue (T24 rejected list).

---

# Part II — Data platform

## T16 · Database platform — Supabase Postgres, hardened

Schema = the migrations in `supabase/migrations/` (`db-design.md` holds the design intent, never DDL to copy). Stack-level facts: **Mumbai region**; driver = `pg` (T6); connection via Supavisor transaction pooling; RLS on 100% of tables (CI-gated); backend connects as the non-bypassing `app_service` role — the `service_role` key exists only in migration/CI secrets, never app code. **Platform hardening — PostgREST Data API exposure set to none, network restrictions on direct DB access, private storage buckets — lives in `security.md` S2** and in `db-design.md` §14.

## T17 · Object storage — Supabase Storage (private buckets, signed URLs)

Buckets: `recordings/` (consent-gated), `kb-uploads/`, `exports/` — all private; access via short-lived signed URLs minted by the API; never public. **R2 stays shortlisted** (D22) for when recording egress costs appear. Belt-and-braces backup of critical buckets + weekly `pg_dump` to a separate provider: `security.md` S10.

## T18 · Embeddings — provider-agnostic via `fetch`, stored in pgvector

One `embed(texts[]) → vector[]` interface in `packages/harness`; the provider/model is config (per-language capable), swappable without touching call sites. Dimensions pinned per model version; re-embedding = new `knowledge_documents` version (db-design gotcha). No vector database — pgvector until db-design §11 triggers say otherwise.

## T19 · LLM access — raw `fetch` adapters, model tiers by task

No SDK lock: a thin provider adapter (`complete()`, `stream()`) per vendor over `fetch`, selected by config. **Tiers:** realtime voice = fast/small model chosen inside Vapi config; post-call summaries + extraction = mid-tier; scoring features + evals = mid-tier; nothing premium until a measured quality gap demands it. Every call emits `usage_events` (cost) + `audit_log` (trace).

---

# Part III — Delivery (SDLC end-to-end)

## T12 · Testing — TDD, formalized

Devesh's commitment adopted as process. **The pyramid, bottom-up:**
1. **Unit** — `bun test`, colocated, pure logic (scoring heuristics, guardrail evaluation, tz math).
2. **Integration** — against a **real local Supabase** (`supabase start`) and real pg-boss: RLS behavior, queue claim/retry, workflow step transitions. No mocked databases — mocks lie.
3. **RLS suite** — the SQL coverage check (db-design §8) + cross-tenant denial tests (a tenant-B token must fail on tenant-A rows, proven in CI forever).
4. **Contract tests** — recorded real Vapi/Meta webhook payloads as fixtures, replayed against handlers; out-of-order and duplicate delivery cases included.
5. **Eval harness** — the 10 personas; **gates agent/workflow activation** (unchanged).
6. **E2E smoke** — Playwright over the four console screens (login, claim task, tag disposition, dashboard renders) against staging.
7. **Post-deploy** — `/health` (process up) + `/ready` (DB reachable, pg-boss responsive) checked by the deploy action before traffic cutover; uptime monitor on both.

**Definition of Done (CLAUDE.md-enforced):** no feature merges without tests at its layer; bug fixes start with the failing test that reproduces them. **TDD × AI note:** "write the failing test, then make it pass" is the single most reliable Claude Code workflow — the test is the spec.
**Migration safety (the "downtime loses real money" clause):** expand-contract only — add nullable column → deploy code reading both → backfill → contract later. Never a breaking DDL while the old worker runs. Migration dry-run in CI against a schema copy.

## T13 · Observability — logs, errors, uptime (the "is it healthy" third)

pino JSON with `{org_id, run_id, conversation_id}` on every line (secrets redacted via pino `redact` — S6); **Sentry** (Bun + React SDKs) for error tracking with release tagging; uptime monitor (BetterStack/UptimeRobot free) on `/health` + the console; `audit_log` as the queryable behavior trail. Langfuse only when prompt-debugging pain is real. Trigger to grow: >1 box or >30 min/week grepping.

## T14 · CI/CD — GitHub Actions (expanded)

Pipeline per PR: Biome lint (incl. G1 rule) → typecheck → `bun test` unit+integration (services: local Supabase) → RLS suite → contract tests → **gitleaks** secret scan → dependency audit → build images. On `main`: deploy staging → Playwright smoke → manual promote to prod → post-deploy health gate. Boring, free at this scale, AI-native.

## T15 · Marketing site — **Astro on Cloudflare Pages** (`apps/www`)

Static-first, ~zero JS shipped, SEO-excellent by construction, markdown content — the week-16 case study becomes a page in minutes. Week-3 scope: one page (offer, demo phone number, contact). Separate deploy from the console; shares nothing but design tokens.

## T20 · Product analytics — **PostHog** (the "how do users behave" third)

Cloud free tier; on the console *and* T15 landing from day one — events are cheap, history is priceless. V1 events: activation funnel (login → first campaign → first disposition), task-queue throughput, feature usage per screen. No session recording of tenant data without explicit consent (S7).

## T21 · Support & ops access — time-boxed membership (the "jump in and help" third)

**No god-mode flag, no RLS bypass — ever.** Support access = an `org_members` row with role `operator` and an **`expires_at`**; RLS's `is_member()` honors expiry automatically; grant/revoke are audited actions; access self-destructs. Schema change in `db-design.md` §14. V1 admin surface = a platform-staff-only page in the console to grant time-boxed access + view org health (metering, error counts). Nothing flashier until tenant count demands it.

## T22 · Environments & release flow

- **local** — Bun + `supabase start` (full local stack) + Vapi test assistant.
- **staging** — separate Supabase project (free tier, also Mumbai) + second compose stack on the same VPS + Pages preview. Real Vapi test number pointed here. Every merge to `main` auto-deploys staging.
- **prod** — promoted from staging by tagged release; migrations run first (expand-contract), health-gated cutover.
Config via environment; the only secret stores are GitHub Environments (CI), the VPS `.env` (0600), and Supabase Vault (tenant creds) — S5.

## T23 · Secrets management

GitHub encrypted secrets (CI) · VPS `.env` chmod 600, never in the image · Supabase Vault for per-tenant integration credentials (db-design) · pino redaction paths for anything token-shaped · quarterly rotation calendar. Full policy: `security.md` S5.

## T24 · Dependency policy + Bill of Materials

**Policy:** (1) platform before packages (`fetch`, `crypto`, `Intl`, `URL`, `WebSocket`); (2) no new dependency without a BOM row + one-line justification in the PR; (3) exact pins (`bun add --exact`), lockfile committed; (4) weekly Dependabot/Renovate PRs, manually merged; (5) transitive surface reviewed on add (`bun pm ls`); (6) tiny utilities are vendored into `packages/shared`, not installed.

**Runtime dependencies (production):**

| Package | Where | Why | Rejected alternative |
|---|---|---|---|
| `hono` | api | routing/middleware, Web-standard, portable | express (callback-era) |
| `pg` | worker | THE Postgres driver (shared by the queries and pg-boss) | postgres.js (would mean two drivers) |
| `pg-boss` | worker | queue mechanics on Postgres | BullMQ (drags in Redis); hand-rolled (Appendix A) |
| `zod` | everywhere | boundary validation = the LLM seatbelt | valibot (fine, less density) |
| `pino` | worker/api | structured JSON logs + redaction | console.log (unstructured) |
| `jose` | api | JWT verification server-side | supabase-js server-side (heavier than needed) |
| `@supabase/supabase-js` | console (+worker for Storage) | auth (PKCE), realtime, signed URLs | — |
| `react`, `react-dom` | console | T3 | — |
| `wouter` | console | routing for 4 screens, ~2kB, 3-hook API | react-router (heavier than 4 routes need; 5-min swap if wouter grates) |
| `@tanstack/react-query` | console | server-state: task-queue polling, optimistic claim/tag, cache | hand-rolled hooks (re-implementing it badly) |
| **`fetch` wrapper (ours)** | `packages/shared` | ~30 lines: base URL, auth header, Zod-parse response | **axios — rejected**: platform `fetch` + types does the job with zero supply-chain surface |
| `posthog-js` | console, www | T20 | — |
| `@sentry/bun`, `@sentry/react` | worker/api, console | T13 error tracking | — |
| `tailwindcss` | console, www (build-time) | T4 | — |

**Dev/build:** `typescript`, `@biomejs/biome` (lint+format, replaces ESLint+Prettier), `vite`, `@vitejs/plugin-react`, `bun-types`, `@testing-library/react` + `happy-dom` (component tests), `playwright` (smoke), `astro` (www). Supabase CLI + gitleaks as binaries/actions, not npm deps.

**Explicitly rejected (so they don't reopen):** axios (fetch) · lodash (platform) · moment/luxon/dayjs (`Intl` + small tz helpers in `packages/shared`; revisit only on real pain) · dotenv (Bun native) · nodemon/tsx (`bun --watch`) · ESLint+Prettier (Biome) · express/fastify (Hono) · Redis (Postgres is queue/cache/pubsub here) · GraphQL/tRPC (REST + shared Zod).

## T25 · Security — **see `security.md` (authoritative, S-ids)**

Security is a first-class document, not a section — per Devesh's priority. It covers: tenancy & auth hardening, Supabase platform lockdown (Data API off, network restrictions), VPS/origin hardening, edge, app/API, webhook verification, frontend, **AI-layer threats (prompt injection via callers and KB uploads)**, secrets, backups & DPDP, the human layer (2FA everywhere), and security testing in CI. Every control has an S-id and a checkbox.

---

---

## Appendix A — Jobs, pg-boss, and durable workflows: the crash course

**The problem.** An HTTP request must answer in milliseconds. Our unit of work is: *"call Rakesh now; no answer → WhatsApp in 2h; re-call tomorrow 11:00; after 3 attempts → task a human."* That's work spanning **days**, surviving crashes and deploys.

**Why the naive tools fail.** `setTimeout` lives in a process's RAM — every deploy or crash erases every pending timer, silently. A cron loop ("every minute, scan for due work") double-fires when two instances run, has no retry semantics, and no record of what failed.

**Concept 1 — a job is a row.** `{type:'place_call', payload:{contact:…}, run_at:'11:00', attempts:0}`. Once work is *data*, it survives anything that kills a process.

**Concept 2 — a queue is rows + claiming.** Workers ask Postgres for a due job using `FOR UPDATE SKIP LOCKED` — the kitchen-ticket rule: many cooks pull tickets off one rail, no two cooks can grab the same ticket, and nobody waits in line. Finish → mark done. Fail → `attempts+1`, retry with backoff. Crash mid-job → a visibility timeout returns the ticket to the rail for someone else.

**Concept 3 — pg-boss is that machinery, pre-built, on the Postgres you already run.** `boss.send(type, payload, {startAfter})` inserts; `boss.work(type, handler)` claims and runs; retries, backoff, scheduling, crash-recovery, dead-letters included. No Redis, no new infra — and because jobs live beside your business tables, a job and its business write can commit in **one transaction** (send the WhatsApp job *and* record the attempt, atomically).

**Concept 4 — our two layers: muscle and memory.**
- **pg-boss = muscle.** Executes single *steps* reliably: "place this call now", "send this template at 14:00".
- **`workflow_runs` = memory.** One row per contact per campaign remembers the *multi-week plan*: `current_step`, `state`, `wake_at`, per-channel `attempts`. The scheduler's whole job: `WHERE status IN ('pending','waiting') AND wake_at <= now()` → check guardrails → enqueue the next step as a pg-boss job → update the row.

**Rakesh's week, as table states:**

| When | workflow_runs | pg-boss | What happened |
|---|---|---|---|
| Mon 10:02 | `running`, step `call_1` | job `place_call` claimed | AI calls; no answer |
| Mon 10:03 | `waiting`, `wake_at=12:03`, attempts `{voice:1}` | — | plan: WhatsApp in 2h |
| Mon 12:03 | scheduler fires | job `send_wa` | template sent; `wake_at=Tue 11:00` |
| *(crash + deploy Mon 18:00)* | **row unchanged** | — | nothing lost — the plan is in the DB |
| Tue 11:00 | `running`, step `call_2` | job `place_call` | Rakesh answers → qualified |
| Tue 11:04 | `completed` | — | disposition + outcome written; scoring re-ranks; callback task if needed |

**That is all "durable" means: the plan survives the death of the machine executing it.**

**Why not Temporal now (recap):** Temporal is this idea industrialized — worth it at hundreds of steps, signals, child workflows, a team. Our sequences are timers + retries + a state machine; pg-boss + one table is the honest size. `workflow_runs` is deliberately engine-agnostic so Temporal can slot in behind it later (db-design §11) without touching product logic.

## Appendix B — Naming

The old ID prefixes (T, D, P, M, G, S, L, Q, VQG) are defined in `docs/archive/project-spec.md` §0. No new prefixes are added (`AGENTS.md → Docs`).
