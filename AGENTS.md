# Revenue OS — how we work (v3 · 2026-09-25)

The operating rules for every contributor — Claude, Codex or human. If a rule is not in this
file, it is advice. Four files are law, each answering one question:

| File | Answers |
|---|---|
| `AGENTS.md` (this file) | How do we work? |
| `docs/NORTH-STAR.md` | What are we building, and why? |
| `ROADMAP.md` | What do we build next, and what counts as done? |
| `STATE.md` | What actually works today, what waits on Devesh, what have we decided? (One file per decision in `docs/decisions-in-force/`, which STATE.md points to.) |

Everything else in `docs/` is reference (useful, may describe unbuilt things) or `docs/archive/`
(history — never cite it as current). Tracker page, rendered from ROADMAP.md, STATE.md and the records in docs/decisions-in-force/ and docs/rule-changes/:
https://claude.ai/artifact/AA8oywPgYW1VgSefP4Va2E

## Hard rails (never, no exceptions)
1. **Secrets** — never read or write `.env*` values; never put tokens in chat, commits or logs.
2. **Cloud** — no prod deploys; no `supabase link` or `supabase db push` from agent sessions (the
   hooks refuse both, and migration repair and a reset of the linked database: `scripts/done-gate/tools.ts`
   says what agents' own tools may not do). Every merge to main applies its new migrations to cloud staging
   once `checks` has passed on it (`.github/workflows/staging-migrations.yml`), so merging a migration *is* a
   cloud push: treat it that way.
3. **Tenancy** — every new tenant table ships with `org_id` + RLS + a cross-tenant denial test in
   the same PR (RLS is enforced on all tables by `tests/rls_coverage.sql`; denial tests do not yet
   cover every older table). DB access only through `packages/db` `withOrg` (the `app_service`
   role + `request.org_id`). Never the Supabase service-role key in app code. Only `agents`, `workflows` and `eval_scenarios` may
   hold global template rows with a null `org_id`. A link between two companies' records pairs `org_id` with
   `org_id` (a link to a template table carries `app.same_company_or_template` instead), and every
   duplicate-protection key includes `org_id`; `tests/rls_coverage.sql` fails any other (migration 019 shows how).
4. **History** — migrations are append-only (expand–contract); never edit an applied one (`rules-from-main`
   refuses a PR that edits, renames or deletes a migration already on main or reuses a migration number:
   `scripts/done-gate/migrations.ts`); never force-push a shared branch.
5. **Sends** — outbound messages only through `packages/channels` doorways, which run `guard()`
   first; tool side effects pass the autonomy check; approval-gated actions become a human task,
   never a silent drop.
6. **Webhooks** — authenticate before trusting, dedupe with a database constraint, store and
   return fast; side effects happen in workers.
7. **main is PR-only with CI green** (required checks: `checks`, and `rules-from-main`, which runs main's
   copy of the rules). Merge authority follows the PHASE line on line 1 of `STATE.md`: SETUP = agents squash-merge
   independent PRs one at a time on observed-green checks with real evidence, after confirming base == main (once
   main's ruleset has a merge queue, an agent's merge adds the PR to the queue, which lands it only when `checks` and
   `rules-from-main` pass on it on top of main and the PRs ahead of it); LIVE = only humans merge. A rule file is any path `RULE_FILES` in `scripts/done-gate/rules.ts` matches. A change to one
   needs nobody's approval to start and is explained before it merges: its PR body has one line per changed rule,
   `Rule change: <rule> · tighter | looser | neutral | mixed · <why>`, naming each changed file by its path, its
   file name or the folder it sits in, and the same PR adds a record per changed rule to `docs/rule-changes/`, one file each, as that folder's README says; the agent shows Devesh that explanation in chat, then, in SETUP, merges
   it itself on observed-green checks like any other PR. `rules-from-main` judges every PR with main's copy of the
   rules (`bun run gate pr`) and refuses one whose rule changes are not explained and recorded; the local hooks
   judge with the checkout's own copy, a convenience, never the judge. docs/runbooks/rules-check-way-back.md says
   what Devesh does if main's copy misfires. Agents use Devesh's own GitHub login, so GitHub's settings only stop
   accidents; the hooks enforce what agents must not do (`scripts/done-gate/tools.ts`).
8. **No false "done"** — never report a capability as working if it runs only in tests, has no
   production caller, or is wired to a stub. Every stub on a production path is listed as
   **Stub** in `STATE.md → What works today`.

## Definition of done
- **An item is done** when (1) it is merged with `checks` green, (2) it is reachable from a
  production entry point with real adapters — or it is explicitly an internal change with no
  runtime surface — and (3) its roadmap line carries evidence: the PR plus how it was seen
  working (command output, screenshot, database rows). Land every capability together with the
  code that calls it; a function nothing calls is not done. Off-roadmap and Side-track PRs are
  not roadmap items: (1) and (2) still apply, and their evidence lives in the PR body.
- **A slice is done** when its proof runs automatically and passes; Devesh does not need to act.
  Every slice's `Proof:` line is written as steps a script can run and check against the real
  product (`bun run proof <slice>`, whose steps live in scripts/proof/). When the
  slice's last item lands, the agent sets it to `proof ready`; when every step passes, the agent
  sets it to `done` and writes the date and the passing run's link after `Proof passed:`, in a PR
  whose body carries that run's report (`rules-from-main` refuses a link that is not a run of the
  proof workflow that succeeded as a whole and passed every step of that slice, on a commit on
  main; a body without the report's heading and `Run:` line; a done slice with an unticked item;
  and a change to a done slice that keeps its link; `bun run cycle --banner` shows each slice's
  latest run and what to do). Each run's short report (what was done,
  what was seen, screenshots, and a recording or transcript where a call or chat is involved) is
  posted to the standing "Proof reports" GitHub issue, so GitHub notifies Devesh; he may look at it
  or ignore it, and a done slice reopens if he says so. GitHub re-runs the proofs of `proof ready`
  and `done` slices after each deploy to main and once a day. If a step fails, the agent adds an
  item naming the failure and the slice (even a done one) goes back to `in progress`. A step that
  cannot run because something in `STATE.md → Waiting on Devesh` is missing (a test number, a key,
  a login) is reported as waiting and names that Waiting item; the slice and its items stay as
  they are.
- **Slice 0's two AI steps run on Devesh's Mac**, never with an Anthropic key: the scripted agent
  session and the verifier's run need a real model, so Devesh runs `bun run proof 0 --on-my-mac`
  in his own terminal, signed in through the token `claude setup-token` makes (it stays in that
  terminal; no agent ever sees it), with the local stack up. It writes a record of the run (the
  commit, the date, each step's result and a fingerprint of every file those steps test) and the
  transcripts into docs/proof/slice-0-ai/, which an agent commits in a pull request whose first
  line is `Roadmap: off-roadmap — Slice 0's AI steps, run on Devesh's Mac`. GitHub's proof run
  takes each step as passed on Devesh's Mac while that record passed it and matches the files as
  main has them, and otherwise reports it waiting on "run the AI steps again on Devesh's Mac",
  which the report and `bun run cycle --banner` name; `rules-from-main` sets Slice 0 to done only
  while main's record passed both and matches main (scripts/done-gate/mac-record.ts).
- Passing tests are required and never sufficient. Tests with fakes prove logic, not the product.
- **The done gate enforces this, so nobody has to remember it.** Whenever a Claude agent stops,
  `scripts/done-gate.ts` checks what its session changed in each checkout it worked in (and was the last
  to work in): first the rules against fake-done (throwing
  stubs, exports and re-exports nothing calls, silenced checks, skipped tests, tests that read source code, a
  test file, test or `expect` line removed without a line in docs/removed-tests.md, an exception without a
  reason), then every check on the exact code (without Docker the tests, database policies and browser checks
  are left to CI, and while background work runs they wait for a later stop; either way Devesh sees `NOT fully
  checked`, never a ✓), then, if product code changed (every file but docs/, Markdown, tests and the gate, CI
  and hook files: .github/, .codex/, .claude/, scripts/done-gate*), a ruling from the verifier agent
  (`.claude/agents/verifier.md`), which runs the product and compares it with Devesh's words (when
  he gave none, the roadmap item's text, word for word): PASS,
  or CANNOT_VERIFY naming what only Devesh can provide (a real phone number, an account, a key),
  which reaches him marked NOT verified. Until then the agent is sent back to work, and Devesh sees
  each verdict. Codex runs the same gate when a turn ends (`.codex/hooks.json`, once trusted in
  Codex's `/hooks`) but has no verifier agent, so a green product change stops once, marked NOT
  independently verified: ask Claude to run the verifier, or check it yourself. Humans run `bun run gate`.
  The gate stops careless or premature "done", not an agent that sets out to forge it: Devesh's
  own attention and GitHub's required checks (`checks`, and `rules-from-main`, which runs main's copy of the
  rules) are the backstops, and `STATE.md → What works
  today` lists the gate's known holes.
- **Interrupted work holds the next session.** A session that starts in a worktree on a branch
  holding a change that never passed the gate, or that writes that branch's checkpoint, is held to
  it once the session that made it has stopped (quiet for 15 minutes): each of its stops judges
  that change as its own until one passes on that branch. Asking Devesh (`bun run gate pause`)
  ends the hold. In the main checkout, where Devesh keeps files of his own, and in a checkout a
  session only looks at, he is told once instead.
- CI also runs the done rules on every pull request (`bun run gate rules`), so they bind every
  agent and human.
- Tests and browser checks run through `bun run gate tests [e2e]`, in the gate (whose whole-suite run leaves the
  four-runs-at-once test to CI: The loop, step 3) and in CI: any test
  reported skipped or todo fails them, however it was switched off, unless `MAY_SKIP` in
  `scripts/done-gate/tests-ran.ts` lists it with why. Bun's run also fails when a line the change adds to a
  .ts or .tsx file under apps, services or packages is run by no test (a line it only moves, or whose comment
  alone it edits, aside), or a new migration has no database test in the same change that uses what it adds
  (scripts/done-gate/coverage.ts). A deliberate gap, or a line wrongly reported as not run, is marked on its
  line, `// coverage gap: <why>`; console code only the browser checks reach,
  `// coverage: browser-only (<its .e2e.ts file under apps/console/e2e>)`; a mark alone on its line covers
  the line below it, the form JSX needs.
- A change with product code proves its tests test it (`bun run gate proven`, in the gate and in CI): each
  test it adds or edits must fail on main's code and pass on the change (both run in scratch copies that
  differ only in product code, on the one local database; lines it only moves are left out). One that deliberately checks behaviour main already has says so at the end
  of its first line or alone on the comment line just above it, `// behaviour already on main: <why>`, and
  the PR body copies it as `Behaviour already on main: <file> · <why>`.
- Guardrail, tenancy and money code (the paths `GUARDED` in `scripts/done-gate/broken-lines.ts` lists) is
  broken on purpose (`bun run gate broken`, in the gate and in CI): for each line a change adds there, a
  condition on it is flipped and the statement it starts is removed, in a scratch copy, and at least one of the
  tests that run that line must then fail; a test file that runs such a line and fails, or doesn't finish, when run
  alone on the change fails the check. TypeScript only: SQL is not broken. It has its own time limit and,
  when that runs out, fails naming the lines not yet broken. A deliberate gap is marked at the end of the line
  or alone on the comment line above it, `// break-check gap: <why>`, and the PR body copies it as
  `Break-check mark: <file> · <why>`.
- Codex reads hooks from the main checkout's `.codex/hooks.json`, not from a worktree's.
- The shared-database lock covers checks run through `bun run gate` or `bun run see`; running tests
  any other way (`bun test`, `bun run e2e`, `bun run gate tests`) can collide with another agent's run.
- When time slips, cut console polish — never guardrails, consent or metering.

## The loop
1. Take the next unchecked item in the **current slice** of `ROADMAP.md` (the rule is at the top
   of that file; `bun run cycle --banner` prints it, and the agent hooks show it when a session
   starts and on every prompt, but Claude Code loads them only for a session started at the
   repo or a worktree root, never a subfolder). Check it against current main first — it may
   already be done. One item, one branch, one PR. When Devesh asks for something else mid-cycle:
   - a question or look-up: answer it; no branch switch, no code;
   - work that does not belong in the repo (prospect lists, videos, research, naming, real
     people's data; the repo's own fake seed and test data is fine to commit): do it in a
     scratch folder outside the repo; never commit it; no branch;
   - marketing-site work (`apps/www`): the **Side track** in `ROADMAP.md`; no replan;
   - an item already on the roadmap in a later slice: that is a replan, and the PR that builds
     it moves the line into the current slice;
   - any other build ask: reply "off-roadmap PR, or replan?" and build nothing until Devesh
     picks (a replan adds the item to the current slice in the same PR that builds it). A
     message that already starts with "off-roadmap" or "replan" has picked.

   At most one off-roadmap PR is open at a time. Find it by the first line of its PR body (step
   4), never by a phrase search, which also matches a PR that only quotes that line:
   `gh pr list --state open --json number,url,body --jq '.[] | select(.body | startswith("Roadmap: off-roadmap")) | .url'`

   When one is open and Devesh asks for another, link it and ask him to merge or close it, or to
   replan; build nothing new until he answers. The Side track has its own limit of one open PR
   (the same command with `Roadmap: Side track`): when it is full, link that PR and ask Devesh
   to merge or close it first.
2. Branch `feat/…` or `fix/…` off up-to-date main — independent, never stacked — and record what
   it builds: `git config branch.<name>.description "<text>"`. The text is the roadmap item's
   text, `Side track: <what>` for marketing-site work, or `Off-roadmap: <what>` for an
   off-roadmap PR. Tests at the layer you touch and where people meet it, edge cases included
   (`.claude/agents/verifier.md`, step 5); integration tests run against the real local
   Supabase stack and real pg-boss — never mock the database; a bug fix starts from a failing
   reproduction. After each commit, and before you stop, update the branch's checkpoint:
   `bun run gate checkpoint --done "<what is done>" --failed "<what failed, or nothing>" --next
   "<the exact next step>"`. The gate adds Devesh's request word for word, shows the checkpoint
   to the next session that starts in that checkout or works there, and sends a stop on a branch
   that builds an item back until its checkpoint was written on the code as you leave it.
3. `bun run gate` green, run bare — never pipe a gate through anything that can swallow its exit
   code. It runs typecheck, lint, guards, then the checks on the change alone against the real local stack (the
   change's new and edited tests again on main's code, the break check on guardrail, tenancy and money code, the
   RLS check), then every test, then the browser checks. One test it leaves to CI: the four-runs-at-once test
   (services/worker/test/test-runs-at-once.test.ts, four whole-suite runs and a demo started together), left
   out of its whole-suite run by its path (`bun run gate tests --leave-at-once-to-ci`), never skipped; its
   summary says so and never counts it passed. CI runs three jobs at once, each on its own fresh local stack of
   only the database, sign-in, data interface and gateway (`.github/test-stack.sh`): the quick checks, the whole
   suite as the Mac runs it, and that one test alone (`bun run gate tests --at-once-alone`); its required
   `checks` waits for all three and passes only when every one passed (a done rule, `scripts/done-gate/ci-jobs.ts`,
   refuses a ci.yml where it could pass otherwise; the one skip it allows is a job held back from pull requests by
   `if: github.event_name != 'pull_request'`, which must still run and pass in the merge queue and on main). Every merge waits for `checks` (step 5), and tests proven
   still runs that test when a change adds or edits it. Never skip, silence or weaken a check to get past it. CI
   also runs gitleaks, `bun audit` and a Docker build; CI is the verdict.
4. See it work (`bun run see <console path>` saves what a signed-in person sees), then run the
   verifier agent with Devesh's request word for word (when he gave none, the roadmap item's text,
   word for word). PR body: the first line is `Roadmap: Slice N —
   <item>` (an item of the current slice, or one of Devesh's, by its text as ROADMAP.md has it, whole or up
   to its first colon; a note in brackets may follow; an item main already has ticked only in a follow-up
   that adds to its evidence), `Roadmap: Slice N — replan: <what>` (a PR that changes ROADMAP.md and ticks
   no item: it builds nothing), `Roadmap: Side track — <what>` or `Roadmap: off-roadmap — <what>`, each
   with an em dash; then what / why /
   evidence (the gate's line, the verifier's ruling, how the result was seen working), with a
   `Rule change:` line per changed rule file (hard rail 7), a `Fix-when-touched:` line per entry of
   docs/fix-when-touched.md whose area the PR touches (step 6), an `Exception: <file> · <why>` line per
   `done-gate: allow` exception the PR adds, a copy of each line it adds to docs/removed-tests.md, and a
   `Coverage mark: <file> · <what the mark says>` line per coverage mark the PR adds, and a
   `Break-check mark: <file> · <why>` line per break-check mark it adds. `rules-from-main`
   refuses a PR without them; `PR_BODY="$(cat body.md)" bun run gate pr` judges the body as it will. Watch CI: `gh pr checks <n> --watch`. Green means observed
   green on GitHub.
5. Merge per the PHASE rule: one PR at a time, confirm `base == main`, never loop merges. At
   three or more open task PRs, stop taking new work. Merge with
   `gh pr merge <number> --squash --match-head-commit <the PR's full head commit>`, one per command: the
   done gate refuses it unless that commit passed `bun run gate` on this machine (a run without Docker,
   which skips the database tests, counts too), GitHub reports `checks` passed on that commit, and, while
   main's ruleset has no merge queue, the commit holds main's tip as `git ls-remote` reads it at that moment (an
   empty or unreadable answer refuses), so CI tested exactly the code the merge lands; the gate asks GitHub whether
   main's ruleset has a merge queue at that moment and refuses on an unreadable answer. With a merge queue the same
   command adds the PR to the queue and the head need not hold main's tip: GitHub runs `checks` and `rules-from-main`
   on it on top of main and the PRs ahead of it and lands it only when they pass. A PR the queue takes out (a
   conflict, or a check failing on the combined code) never reaches main: fix it, re-gate and re-verify the new
   head, wait for `checks`, and queue it again. And, for product code or a change to .github/workflows/ or the
   gate's scripts/done-gate/checks.ts, tests-ran.ts, coverage.ts, tests-proven.ts, break-check.ts or
   merge-gate.ts, the verifier ruled PASS on it; a CANNOT_VERIFY means only Devesh merges it. The
   check before each command also refuses the other ways of merging it can read (`--admin`, `gh api`, a
   merge handed to a shell or eval, an MCP tool that merges, a script in a line that names gh and
   merge), and any command or edit that touches the gate's record (`.git/done-gate`) or runs its hook by
   hand. It reads command text, so it stops a careless try, not a determined one (STATE.md lists what
   gets past it).
6. The same PR ticks its roadmap item with evidence (an off-roadmap or Side-track PR has no line
   to tick; its PR body's what / why / evidence is the record), updates `STATE.md → What works
   today` if reality changed, and adds a file to `docs/decisions-in-force/` for any decision (one file per decision, as that folder's README
   says, so two PRs never edit the same lines).
   Any area the PR touches that has an entry in `docs/fix-when-touched.md` gets that fix in the same PR,
   or its body says why it doesn't apply, in the format that file's "How to use it" gives.
   A genuine surprise gets one factual line in `lessons.md`. After ROADMAP.md, STATE.md or a record
   changes on main, republish the tracker page (Claude: Artifact publish of `docs/tracker/index.html`
   with files `ROADMAP.md`, `STATE.md`, `parse.js` from `docs/tracker/parse.js`, and, each written to a scratch file,
   `records.md` from `bun run records` and `published.txt` from `git log -1 --format='%h on %cs' origin/main`, `url` = the tracker link above).

## When Devesh corrects you
Fix it, then turn that kind of mistake into a check so it can't come back: the prevent-repeat skill
(`.claude/skills/prevent-repeat/SKILL.md`) says how. A correction that only becomes a note will be
made again.

## Escalate to Devesh only for
Credentials · money · external accounts · irreversible or outward-facing actions · genuine
product-direction forks. Everything else: pick the boring option,
record it as a file in `docs/decisions-in-force/`, keep moving.

## Docs
- The four law files must agree with each other and with the code. When code and a law file
  disagree about what exists, the code is right: fix the file in the same PR.
- Changing a fact that other files cite? Update every citation in the same PR.
- Name things in plain words. No new ID prefixes; the only numbered things are roadmap slices.
  Old IDs (D, T, S, task-N) survive only where code already cites them. When you touch a file
  whose comments cite an archived doc or an old ID, point the comment at the file that now holds
  the fact, in the same PR.
- `docs/patterns/` holds the style to imitate: its rules bind. Each example is an excerpt of the real file named on
  its first line, or the pattern says "do not copy" and names the roadmap line that brings the real code;
  `bun run guards` fails any other code block, an excerpt that no longer matches its file, and a name of a file
  the repository doesn't hold.

## Commands (scripts are the interface)
`bun run gate` (every check, plus the done rules) · `bun run see <console path>` (screenshot and
errors as the dev login) · `bun run cycle --banner` (where we are: current slice, next item,
this branch's item) · `bun run local <cmd>` (any command with the running local stack's
settings) · `bun run dev` · `bun run db:reset`
(local only) · `bun run db:seed <pack>` · `bun run demo` · `bun run evals` · `bun run guards`
· `bun run proof <slice>` (that slice's proof steps and short report, as the proof workflow runs them)

## Conventions
- **Moat rules**: every conversation, message and task traces to a contact and, when known, a
  workflow run; every business result is an append-only `outcomes` row with attribution, never
  a status string · RLS on every public table · completed conversations require a disposition
  (not yet enforced: Slice 4) · guardrails run before every send · active agent and workflow
  versions are immutable — change means a new version plus passing evals · derived-data exports
  only through a consent-filtered, aggregated pipeline.
- TypeScript strict. Zod at every boundary: HTTP and webhook shapes in `packages/shared`;
  engine-internal schemas next to their module.
- **Database access** is parameterised SQL through `tx.query(text, [values])` inside `withOrg`,
  with `org_id` in every where clause as a second fence. Never concatenate values into SQL.
  One Postgres driver (`pg`).
- Money is numeric + currency; phone numbers are normalised to E.164 before insert.
- Dependencies are exact-pinned, and so are the Bun engine, GitHub Actions (by commit SHA), the
  Supabase CLI and the Docker base image; upgrades are deliberate PRs. A new dependency needs a
  one-line justification in the PR and a decision file in `docs/decisions-in-force/`. Prefer the platform (`fetch`,
  `crypto`, `Intl`) over packages.
- Write ownership: the worker writes runs, conversations, messages, memories, usage and
  scores; the console writes task status, dispositions, config and drafts.
- **Agent harness**: tool arguments are validated before execute · `guard()` before any side
  effect · job handlers first reload the row and no-op if stale · retrieved text (memories,
  knowledge) enters prompts fenced and labelled as data · model output never writes consent or
  guardrail fields (one exception: it may add a do-not-call block heard on a call, never remove one or grant consent; only the lead's own written YES lifts a block) · no in-memory agent state (rows or it didn't happen) · no per-vertical code
  in `packages/harness` (verticals are seed/config rows).
- Logs are pino JSON with `org_id`, `run_id`, `conversation_id` where known.
- G1: no `bun:*` imports or `Bun.` globals in `packages/**` (imports are lint-enforced).
- Hygiene: delete merged branches with `git branch -d`; `-D` only for a squash-merged branch whose
  tip is exactly the head its merged PR merged; remove worktrees with
  `git worktree remove` (never `rm -rf`).

## Gotchas
- The `pgboss.*` schema has no RLS by design; its jobs carry ids only and every handler
  re-enters `withOrg`. The `workflow_runs (status, wake_at)` index is sacred.
- Vapi webhooks arrive out of order: upsert the company's conversation by `provider_ref` (a call
  id is unique per company, not across companies), order transcripts by `messages.seq`. The receiver compares the `x-vapi-secret` header (one shared
  secret today) in a timing-safe way — it is not a body signature — and the org comes from the
  URL. `webhook_events` is a lifecycle table: `payload` never changes; status and processed_at do.
- Worktrees live under `.claude/worktrees/` and must never enter lint scope. Local database URLs
  need the `app_service` password used in `.github/workflows/ci.yml`.
- The `@harness/*` and `@db/*` path aliases are type-only; `scripts/` is not a workspace, so
  value imports there use relative paths. Test files are outside typecheck scope.
- `bun`'s `mock.module` is process-wide and hoisted: always spread the real module.
- Tailwind v4 apps need their own `biome.json` with Tailwind directives; never trust
  `biome migrate` on the `recommended` preset.
