# Fix when touched

This list is the clean-up that gets no roadmap slice: stale comments, unused code, tests that check the wrong thing, out-of-date agent instructions and docs, files that do more than one job, and leftover branches. Each entry is fixed in the same PR as any change that touches its area, never as a project of its own. It lives at `docs/fix-when-touched.md`, and AGENTS.md → The loop, step 6, sends every PR here.

**How to use it**
- Find the folder you are editing in the table below, and do that entry's fix for the files your PR touches. Your PR still names its own roadmap item on its first line; for each entry whose area it touches, the PR body adds a line of its own, `Fix-when-touched: <entry number> · fixed · <what you fixed>` or `Fix-when-touched: <entry number> · not applicable · <why>`, for example `Fix-when-touched: 1 · fixed · dropped the old task codes in scripts/demo.ts`. A line inside an HTML comment or a code block counts for nothing.
- `rules-from-main` fails a PR that changes a file the table's left column covers without that line, and names the entries and the files that called for them. Only the paths in backticks count, so keep every path there in backticks: one ending in "/" covers everything under that folder, any other covers that one file, at any letter case. It reads this table as main has it, so a PR that edits the table is judged by the table as it was before the edit.
- One entry has a latest date: the runbooks must be fixed by Slice 6's security walk.
- Anything that needs Devesh (his Mac, his settings, his files) is in STATE.md → Waiting on Devesh, not here.
- When an entry is fully fixed, strike it from this list in that same PR.
- Cite code by file and function name, not by line number: line numbers go stale as soon as the file changes (entry 1 lists two test comments where they already have).
- File and line references were checked against main at commit ef7c60d on 2026-09-29; entries 10 and 11, the additions to entries 1, 2, 4 and 8, and the findings table at the end were checked at 7d5e52e on 2026-10-01.

## Find your area

| If your PR touches… | Fix this too |
|---|---|
| Any file in `packages/`, `services/`, `apps/console/`, `scripts/`, `tests/` or `supabase/` | 1. Comments that point at old codes or say untrue things |
| `packages/harness/`, `services/worker/src/scheduler.ts`, `apps/console/src/ui/primitives/`, `docs/tech-stack.md` | 2. Unused code that shows agents a second way of doing things |
| `packages/channels/test/channels.test.ts`, `packages/shared/test/api-error.test.ts` | 3. Tests that read source code as text |
| `.claude/skills/`, `.claude/agents/verifier.md`, `lessons.md` | 4. Agent instructions that restate drifting facts |
| `docs/runbooks/`, `docs/security.md`, `docs/decisions/D36-phased-security-posture.md` | 5. Runbooks that still describe the retired orchestrator |
| `scripts/demo.ts`, `scripts/dev-login.test.ts` | 9. Imports the lint rule allows only as exceptions |
| Local branches, `.claude/worktrees/`, `.gitignore` | 8. Leftover branches and worktrees |
| `packages/harness/src/workflow/`, `services/worker/src/scheduler.ts`, `services/worker/src/runs.ts`, `services/worker/src/handlers/place-call.ts`, `services/worker/src/routes/screens.ts`, `apps/console/src/features/screens/`, `services/worker/src/vapi/process.ts`, `packages/harness/src/loop.ts`, `packages/db/src/orgs.ts`, `scripts/demo.ts` | 10. Files with more than one job |
| `packages/harness/src/loop.ts`, `packages/harness/src/workflow/interpret.ts` | 11. Functions over the complexity limit |

## Product code

### 1. Comments that point at old codes or say untrue things

**Fix:** In each file your PR touches, replace old task, milestone, moat and spec-section numbers (such as `task 1`, `T9`, `M2`, `moat #4`, `§12`, all defined only in docs/archive) with plain words or the file that now holds the fact, correct any comment that names a finished task as the fix for a stub that is still live, and turn a line-number citation into the function's name.

**When:** the PR that next touches the file. AGENTS.md → Docs already requires this; this entry lists where it is still owed.

**Known spots on main:**
- About 101 of 243 source files carry an old code. Bare `T2` to `T9` are the worst, because docs/tech-stack.md reuses those numbers for different topics (for example `packages/channels/src/types.ts:1` says "T5" meaning an old task, while tech-stack's T5 is the web framework).
- `packages/harness/src/types.ts:47` says company settings can tighten a tool's approval level; nothing does that.
- `apps/console/src/features/conversations/ConversationLink.tsx`, its header comment: old task codes, and "react-component.md:21", a line number that has moved; the rule it means is "second usage → promote" in `docs/patterns/react-component.md`. (Added 2026-10-03.)
- Two test comments cite lines of `services/worker/src/scheduler.ts` that have since moved: `packages/harness/test/interpret-action-payloads.test.ts` (the outcome handling, in `applyInlineAction`) and `packages/harness/test/seed-workflow-definitions.test.ts` (the step-map check, in `processRun`). Name the function instead.

**From findings:**
- Old ID codes in code comments point to archived docs, and the T-numbers collide with docs/tech-stack.md
- Code comments name finished tasks as the fix for stubs that are still live

### 2. Unused code that shows agents a second way of doing things

**Fix:** Delete code nothing in the product calls, so agents stop building on it.

**When:** the PR that next touches that package or doc.

**What goes, and where:**
- No known spot is listed on main; the fix still binds any unused code a PR in these areas finds. (The unused text-box component, `apps/console/src/ui/primitives/Textarea.tsx`, was kept with a note saying it is a design-system piece waiting for a screen, by the Browser checks item on 2026-10-18.)

**From findings:**
- Dead modules that advertise a second way of doing things: Drizzle schema mirror and dependency, AI-provider registry, a stale demo script, an unused component
- Half the schema has no production code, and a Drizzle 'mirror' covers 3 of 33 tables, is unused, and is labelled the only DB entry

## Tests

### 3. Tests that read source code as text

**Fix:** When you edit one of these test files, replace its checks that read source code as text with a test that renders, calls or drives the code (or with a lint rule), and delete false "RED today" comments (they claim a passing test fails).

**When:** the PR that next edits the test file. The rule is that behaviour is proved by behaviour tests; a structure check (which part may import which) or a secret scan lives in lint or `bun run guards`, never in a test file. The done gate refuses new source-reading test lines (`scripts/done-gate/source-reading.ts`, which since [#137](https://github.com/devesh911/revenue-os/pull/137) also catches a code file imported with options, such as `with { type: "text" }`; docs/done-gate.md → The done gate lists the ways that still get past it), so only the existing ones remain.

**Why it matters:** the guardrail settings test checked that the Settings save's source said `PUT` and stayed green for about two months while the browser blocked that save.

**What remains** (the rest was done by [#137](https://github.com/devesh911/revenue-os/pull/137): the source halves of the console page, boot and guardrail settings tests went, replaced by render, start-up, hook and browser tests, a lint rule for the Supabase client and guards for the Anthropic SDK and raw HTML; the console tests moved from `tests/` into `apps/console/test/`):
- "RED today" comments: one each in `packages/channels/test/channels.test.ts` and `packages/shared/test/api-error.test.ts`. (The four in `apps/console/test/pages-adoption-behavior.test.tsx` went with the Browser checks item on 2026-10-18.)
- Acceptable as they are (they check docs or settings, not product code): `apps/console/test/readme-coverage.test.ts`, `apps/console/test/ui-contract.test.tsx`, `scripts/guards.test.ts`, `scripts/verifier-instructions.test.ts`.

**From findings:**
- 16 test files check source code as text instead of what the code does, and the repo teaches this as 'the RED idiom'
- 38 stale 'RED today' comments on passing tests, tests that only pin a finished file move, and console tests split across two folders

## Agent instructions

### 4. Agent instructions that restate drifting facts

**Fix:** When a skill or the verifier is next edited, cut facts that drift down to pointers (files to read, commands to run), remove its sentence saying lessons.md outranks it (AGENTS.md, then docs/decisions-in-force/, decide), turn each still-true lesson it relies on into a check (a test, a lint rule or a verifier line), and add the lines below that are still missing.

**When:** the PR that next edits that skill, `.claude/agents/verifier.md` or lessons.md. The verifier is a rule file, so that PR's body explains the rule change before it merges.

**Known spots on main:**
- The "Learned since" greps of `.claude/skills/db-work/SKILL.md`, `.claude/skills/worker-webhook/SKILL.md`, `.claude/skills/console-feature/SKILL.md` and `.claude/skills/harness-agent/SKILL.md` still send agents to grep lessons.md; turn the lessons each greps for into checks, then cut the grep, as task-loop's section "What the old lessons became" did on 2026-10-13.
- Drifted facts: none known. (harness-agent's "all types live in src/types.ts" was fixed on 2026-10-12; console-feature's browser-test, query-key and archived-code facts were fixed on 2026-10-03.)
- lessons.md (36 KB, about 56 entries, many resolved or from the retired orchestrator) is the source for the checks. Still-true lessons worth a check first: a piped gate hiding its failure, a test mock that replaces a whole module without keeping the real parts, a guard with no production caller, test data that describes a world that doesn't exist, the lint preset being silently switched off, company links without delete rules, cross-site scripting tests that check the wrong text, and a blank secret in the web server's settings.

**Not here:** whether the two skills switched off on Devesh's machine should be on is his "Finish clearing the retired orchestrator from your Mac" item in STATE.md → Waiting on Devesh.

**From findings:**
- Skills tell agents that lessons.md outranks them, but lessons.md is 36 KB of mostly resolved history that calls itself 'not law'; its lessons should become checks
- Skills restate facts that have drifted; two of five skills are switched off locally; a stale untracked .agents skill copy remains

## Docs

### 5. Runbooks that still describe the retired orchestrator

**Fix:** The go-live and incident runbooks stop citing the retired orchestrator (the old unattended agent runner): go-live lists the exact merge-protection settings to apply for human-only merges (PR required, `checks` required, one approval, code-owner review, no force-push or branch deletion, no bypass for any login agents use), and incident says how to stop running agent sessions and worktrees, sign agents out of GitHub and close their PRs.

**When:** the PR that next touches `docs/runbooks/` or `docs/security.md`, and at the latest in Slice 6's security-checklist walk, whose roadmap line names this entry.

**Known spots on main:**
- `docs/runbooks/go-live.md:5, 12, 22-25, 61-62, 68, 70` cite orchestrator files and a merge-rule backup that no longer exist, so the go-live step that restores human-only merges can't be followed.
- `docs/runbooks/incident.md:6-14`: its "stop everything" step stops the orchestrator, not today's agent sessions.
- `docs/runbooks/vps-cloudflare-setup.md:4` cites orchestrator files. (The phased security posture decision, `docs/decisions/D36-phased-security-posture.md`, stopped citing them in [#176](https://github.com/Peertopeer-solutions/revenue-os/pull/176).)
- `docs/security.md:118-137` (section S13, the orchestrator's controls): its orchestrator-only controls (the bot's token, the disposable machine, the watchdog kill switch) move to docs/archive; the controls for the platform stay.

**Not here:** removing the orchestrator's watchdog from Devesh's Mac is his "Finish clearing the retired orchestrator from your Mac" item in STATE.md → Waiting on Devesh.

**From findings:**
- The retired orchestrator is still wired into the go-live and incident runbooks, and its watchdog is still installed on Devesh's Mac

## Local checkout

### 8. Leftover branches and worktrees

**Fix:** Whenever an agent cleans up after its own merged PR, it also deletes other local branches already merged into main, removes worktrees whose branch is merged and that have no uncommitted changes and no running session, and clears worktree entries whose folder is gone. (`.agents/` is in `.gitignore` since [#137](https://github.com/devesh911/revenue-os/pull/137), so a second copy of the skills can't be committed.)

**When:** any agent's clean-up after its own PR.

**State on 2026-09-29:**
- Local branches: on 2026-09-29, with Devesh's approval, 32 were deleted: 10 already merged into main (`git branch -d`) and 22 squash-merged whose tip is exactly the head their PR merged (`git branch -D`). 15 remain: 8 checked out in a worktree, 7 with no exactly matching merged PR (they may hold work that never landed). AGENTS.md → Hygiene now allows `-D` only for that exact case.
- 9 worktrees. The Downloads clone and the main checkout's stray `.agents` copy are already gone, but git still lists `~/Downloads/revenue-os/.claude/worktrees/marketing-launch` as prunable; `git worktree prune` clears it.
- `.agents/` is still not in `.gitignore`.

**State on 2026-10-01:** Devesh removed the three worktrees from before the done gate (his prospect spreadsheets now live in ~/Documents, outside the repo), and the prunable Downloads entry is gone. The main checkout and 7 worktrees remain, with 21 local branches, among them branches whose worktree is gone (for example `claude/realestate-prospecting-pipeline-f68eb3`, `claude/quizzical-ishizaka-fe2b61`). `.agents/` was still not in `.gitignore` then.

**From findings:**
- Stale worktrees, branches, a second out-of-date clone, and untracked out-of-date skill copies around the main checkout

## Imports

### 9. Imports the lint rule allows only as exceptions

**Fix:** When you edit one of these files, remove its exception from the lint rule's allowed list: `scripts/demo.ts` stops reaching into the worker's and packages' internal files (8 imports) and enrols its lead through the start-outreach route (Slice 2) and the worker's public surface; (the root console tests in `tests/` it also named moved into `apps/console/test/` in [#137](https://github.com/devesh911/revenue-os/pull/137), where they import the console's own files); `scripts/dev-login.test.ts` stops importing the worker's source (1 import).

**When:** the PR that next edits the file, once Slice 3's import rule has landed (before that, there is no list to strike from).

**From findings:** none of its own. This is the remainder of "Module boundaries are not enforced", which Slice 3's lint line settles.

## Structure

### 10. Files with more than one job

**Fix:** Split a file that does several unrelated jobs, but only along a seam the touching PR needs, never as a tidy-up of its own:
- The move is the PR's first commit and changes no behaviour; the PR's real change comes after it, so the move can be reviewed on its own (and, once Slice 0's done-rules item lands, detected as a move by git's moved-code detection, so the gate does not treat moved lines as new).
- The old import path keeps working: the new folder's `index.ts` exports exactly the old public names, no more.
- Never move code that a later roadmap item deletes. Isolate it instead, so that item deletes a whole file or folder.
- Update every citation of the moved code in the same PR, by function name, not line number.
- Write the result as one job per file, siblings importing each other in one direction only, no `utils` file, and a header comment naming the file's job. docs/patterns/one-job-per-file.md shows it, as an excerpt of the done gate's split.

**When:** the PR in the right-hand column below, or any earlier PR that has to change the same seam.

| File | Split into | Done by |
|---|---|---|
| `packages/harness/src/workflow/schema.ts`, and the step-map half of `services/worker/src/scheduler.ts` (`drive()`, the `MAX_STEPS` step cap, and the rule that clears the call's result) | step-map code together in `packages/harness/src/workflow/`, apart from what the planner keeps, so deleting the step map deletes one folder; enrolment (`services/worker/src/runs.ts`) and the call handler (`services/worker/src/handlers/place-call.ts`, which reads the step map with an unchecked type cast) call that module instead of each reading the step map themselves | Slice 3 · "A sequence can carry a goal plus rules…" |
| The "screens" grouping, one file in each of three layers: `services/worker/src/routes/screens.ts`, `apps/console/src/features/screens/api.ts` (the database layer's screens.ts is already split: see Done by) | tasks, contacts, conversations and metrics, with the same names in all three; each PR moves only the part it edits | database reads: done on 2026-10-12 by Slice 1 · "Every database query also filters by company…", into `packages/db/src/tasks.ts`, `contacts.ts`, `conversations.ts` and `metrics.ts`; its booking counts: Slice 4 · "Booking a site visit has one authoritative implementation…" (they count `booking` and `qualified`, while the engine writes `site_visit_booked`); worker routes: Slice 5 · "One shared membership and role check…"; console calls: contacts done on 2026-10-18 by Slice 1 · "When a lead says "don't contact me"…", into `apps/console/src/features/contacts/api.ts`, the rest by the first item that adds an action to its screen |
| `services/worker/src/vapi/process.ts` (`processVapiEvents` and one function per kind of call event; `fileEndOfCall` is the end-of-call handling) | the end-of-call handling in its own file | Slice 4 · "A call's result reaches the lead's sequence from the end-of-call report…" |
| `packages/harness/src/loop.ts` (`runTurn`) | its database writes leave for the single shared operations; a `tool-call.ts` is pulled out only by the slow-AI item | its task and audit writes: done on 2026-10-18 by Slice 1 · "Creating a hand-over task…" ([#190](https://github.com/Peertopeer-solutions/revenue-os/pull/190): createTask and audit in packages/db); its message writes: Slice 1 · "Each conversation operation has one authoritative implementation…"; `tool-call.ts`: "A slow or stuck AI model, dialer or WhatsApp service can't freeze the worker…" |
| `packages/db/src/orgs.ts`: companies (`createOrgWithAdmin`, `updateOrg`, `userOrgs`) and members (`memberRole`, `addMember`) | `orgs.ts` and `members.ts` | Slice 5 · "One shared membership and role check…" |
| `scripts/demo.ts` (402 lines) | a library and a command line | Slice 3 · "`bun run demo --keep` runs the sequence a real company gets…", or Slice 4's end-of-call item if it comes first |

**Leave as they are:** the rest of `services/worker/src/scheduler.ts` (each other seam is about to be rewritten: attempts counting by Slice 3's contact limits); the call and WhatsApp handlers; the small worker files; the harness's `types.ts`, `context.ts`, `retrieval.ts` and `tools/`; `packages/channels`; the console's `app/session`; `apps/www/test/lib.test.ts`. No shared queue-settings file: the scheduler copies each job's settings from its queue's row in pg-boss's own tables (`enqueueJob` in `services/worker/src/scheduler.ts`). The stand-in senders stay in `services/worker/src/jobs.ts` until Slice 2's real WhatsApp sender lands. Unused code is deleted, not moved (entry 2).

**From findings:** none of the 73. It comes from the structure review of 2026-09-30.

### 11. Functions over the complexity limit

**Fix:** When your PR rewrites one of these functions, bring it under biome's cognitive-complexity limit of 20 (biome's score for how deeply a function's branches and loops nest) and remove its file's exemption from `biome.json` in the same PR. The exemption is per file in `biome.json`, never a per-line ignore comment, which the done gate may read as silencing a check.

**When:** the PR that next rewrites the function. The limit, a ban on import cycles and these exemptions are in `biome.json` since Slice 0's done-gate split item, and `scripts/lint-limits.test.ts` shows they reach every app, service and package; keep each function from growing until then. Editing `biome.json` is a rule-file change, so the PR body explains it. `processVapiEvents` (`services/worker/src/vapi/process.ts`, 32) was split into one function per kind of call event, each under the limit, by Slice 1's per-company links item on 2026-10-11, and its exemption removed. `importContacts` (`packages/db/src/contacts.ts`, 22) was split into small functions under the limit by Slice 1's do-not-call item on 2026-10-18, and its exemption removed.

| Function | File | Score | Likely next rewrite |
|---|---|---|---|
| `runTurn` (one AI turn) | `packages/harness/src/loop.ts` | 27 | Slice 1's conversation-operation or slow-AI item |
| the inner `run` of `interpret` (walks the fixed step map) | `packages/harness/src/workflow/interpret.ts` | 27 | none: the step map is frozen and deleted in Slice 3, so this exemption goes with the file; a refactor that keeps its behaviour is allowed |

Scores from biome 2.5.3 (the pinned version) on main at d44c77c; none of the four files changed by 7d5e52e. Six more functions over 20 are in the done gate (`scripts/done-gate/`: `stop`, `simpleCommands`, `mergeGate`, `cli`, `snapshot`, `touch`), outside the limit's scope (source under apps, services and packages).

**From findings:** none of the 73. It comes from the structure review of 2026-09-30.

---

## Where the 73 audit findings went

The September audit's 73 findings, each with where it lives now. "Moved" marks a finding whose home changed in the third replan (2026-10-01), when Slice 1 was split and eight of its items moved to the front of Slices 3, 4 and 5. Slice items are named by how their roadmap line starts.

| Finding | Where it went |
|---|---|
| The path from a change to the cloud staging database has no mechanical stop: edited or clashing migrations pass CI, the staging push does not wait for CI, and main's rule lets the agents' own login skip checks | Settled by [#123](https://github.com/devesh911/revenue-os/pull/123) (CI refuses an edited, renamed, deleted or clashing migration, `scripts/done-gate/migrations.ts`; `.github/workflows/staging-migrations.yml` applies migrations only after `checks` has passed on the same commit) and by Devesh's GitHub settings (main's ruleset has no bypass, and since 2026-10-02 counts `checks` and `rules-from-main` only when GitHub Actions reports them) |
| The rules against pushing to the cloud database and reading secrets are written down but not enforced; `bun run db:migrate` is a loaded footgun | Settled by [#119](https://github.com/devesh911/revenue-os/pull/119) (the Claude Code and Codex hooks refuse cloud database pushes and `.env` reads, `scripts/done-gate/tools.ts`, and Claude Code's settings deny them; `bun run db:migrate` deleted) |
| The fixed 'local database only' safety check was copied, and four places still use the weak version | Settled by [#124](https://github.com/devesh911/revenue-os/pull/124) (the test setup, db:reset, evals and the demo use scripts/local-url.ts) |
| Every database test copy-pastes its own company setup; 7 use fixed names and delete-by-name, and 4 places delete every queued job | Settled by [#124](https://github.com/devesh911/revenue-os/pull/124) (tests/test-companies.ts; every job clean-up, the demo's included, touches only its own company) |
| Test runs collide on the one shared database: parallel agents crash each other and delete each other's data | Settled by [#124](https://github.com/devesh911/revenue-os/pull/124) (four whole-suite test runs started at once all pass and leave another company's data and the dev login's workspaces alone; what is still shared is in docs/done-gate.md → Automated tests and CI) |
| The pattern files that AGENTS.md says 'bind' teach unauthenticated, role-less, wrong-signature code | Settled by [#129](https://github.com/devesh911/revenue-os/pull/129) (the route and job examples are deleted and marked "do not copy" with the roadmap line that brings each; `bun run guards` fails a pattern naming a missing file, `scripts/guards/pattern-files.ts`) |
| The pattern docs agents are told to imitate describe code that does not exist, with no role check | Settled by [#129](https://github.com/devesh911/revenue-os/pull/129) (as above) |
| docs/patterns examples are invented code that does not match the real APIs, and agents are told to imitate it | Settled by [#129](https://github.com/devesh911/revenue-os/pull/129) (the rest are excerpts of named real files, and `bun run guards` fails one that no longer matches its file) |
| The design doc and migrations README still tell Claude to generate migrations from design DDL that contradicts current decisions | Settled by [#129](https://github.com/devesh911/revenue-os/pull/129) (both, and the db-work skill, say the migrations are the schema and a change is a new migration) |
| Test files are outside the typecheck gate: 49 type errors, including fakes that no longer match the real interfaces | Moved: Slice 3 · "Test files are type-checked like product code…" |
| About 98 test files are never type-checked, and 49 type errors already hide in the worker, engine and script tests | Moved: Slice 3 · "Test files are type-checked like product code…" |
| Test files are never type-checked; fakes have drifted from the real interfaces | Moved: Slice 3 · "Test files are type-checked like product code…" |
| API access control is opt-in per route: sign-in only on /orgs, membership check hand-copied 12 times, and the database's backend path trusts whatever company id is in the URL | Sign-in half settled by [#154](https://github.com/devesh911/revenue-os/pull/154) (every worker route requires sign-in but the four on PUBLIC_ROUTES in services/worker/src/auth.ts, and services/worker/test/sign-in.test.ts asks every mounted route without a token); the membership half: Slice 5, below |
| 'Invite-only' accounts are not enforced: the sign-in server accepts self sign-up, and any signed-in user can create a company | Settled by [#154](https://github.com/devesh911/revenue-os/pull/154) (the sign-in server refuses a self sign-up, and POST /orgs refuses anyone not on our operator list, platform_operators) |
| The one skipped test (dev-login sign-up path) is always skipped locally and runs in CI only because of file order; two tenancy suites skip instead of failing without DATABASE_URL | Settled by [#154](https://github.com/devesh911/revenue-os/pull/154) (the dev login is made in the local database, its test runs everywhere and MAY_SKIP is empty). The two tenancy suites, packages/harness/test/tools.test.ts and retrieval.test.ts, still skip without DATABASE_URL, but `bun run gate tests` (scripts/done-gate/tests-ran.ts) fails any test reported skipped however it was switched off, and the gate and CI always set DATABASE_URL, so a run without the database fails rather than passing quietly |
| The database treats every backend request as an admin of whatever company id it is handed; the only wall is 12 hand-copied route lines | Moved: Slice 5 · "One shared membership and role check (admin, operator, viewer)…" |
| The 'is this user a member, with which role' check is hand-copied into 12 API handlers, in 3 different styles, and the database does not back it up | Moved: Slice 5 · "One shared membership and role check (admin, operator, viewer)…" |
| The transcript API route has no route-level test; the membership check that stops one company reading another's call transcripts is untested | Moved: Slice 5 · "One shared membership and role check (admin, operator, viewer)…" |
| Staff profiles (names, phone numbers) are readable from any company's context | Moved: Slice 5 · "One shared membership and role check (admin, operator, viewer)…" |
| A company's records can point at another company's records (43 single-column links) | Slice 1 · "Every link between company records (all 43…" |
| Duplicate-message keys and call ids are unique across all companies: a collision silently drops one company's event or blocks its whole webhook queue | Slice 1 · "Every link between company records (all 43…" |
| The decided rule 'org_id in every where clause' is broken in about 18 queries and nothing checks it | Slice 1 · "Every database query also filters by company…" |
| Three written rules are already broken in main's code, so agents copy the broken version | Slice 1 · "Every database query also filters by company…" |
| Do-not-call is checked before every send but nothing ever records it | Slice 1 · "When a lead says "don't contact me"…" |
| AI agent tools take the lead's id from the model, so a lead's message can steer writes and sends onto a different lead of the same company | Moved: Slice 3 · "The AI's tools act only on the lead of the conversation they run in…" |
| The call-attempt limit resets whenever a lead is enrolled again: it only looks at the lead's newest sequence | Moved: Slice 3 · "Contact limits hold even when a company has saved no settings…" |
| Guardrail settings the console lets admins save do nothing, and a company created through the product has no attempt limit at all | Moved: Slice 3 · "Contact limits hold even when a company has saved no settings…" |
| Guardrail blocks (do-not-call, calling hours, call limit) are only tested against a pretend database; the real call-limit bug lives in that gap | Moved: Slice 3 · "Contact limits hold even when a company has saved no settings…" |
| The default time zone is decided in three places, and the engine's copy says UTC while the rest say India | Moved: Slice 3 · "Contact limits hold even when a company has saved no settings…" |
| A lead can be enrolled in the same sequence any number of times at once | Slice 1 · "A lead can be in the same sequence only once at a time" |
| The dashboard counts outcome labels the engine never writes, and the demo seed writes the dashboard's label to hide it | Moved: Slice 4 · "Booking a site visit has one authoritative implementation…" |
| Two different ways to 'book a site visit' that write different things, and the dashboard counts a third name | Moved: Slice 4 · "Booking a site visit has one authoritative implementation…" |
| The dashboard's bookings and qualified-lead numbers count names only the seed data writes; the engine writes a different one, and the tests on each side never meet | Moved: Slice 4 · "Booking a site visit has one authoritative implementation…" |
| Writes to shared tables are hand-rolled in several places with different rules; SQL is spread across three packages | Tasks, audit rows and access grants settled by [#190](https://github.com/Peertopeer-solutions/revenue-os/pull/190) (one writer each in packages/db, held by `bun run guards`); conversations and messages: Slice 1 · "Each conversation operation has one authoritative implementation…" |
| Same tables written by several copied raw-SQL writers that fill them differently (messages x3, tasks x4, conversations x3, contact lookup x2) | Tasks and the contact lookup settled by [#190](https://github.com/Peertopeer-solutions/revenue-os/pull/190) (createTask, leadNumber); messages and conversations: Slice 1 · "Each conversation operation has one authoritative implementation…" |
| Two audit-log writers, and neither is used by the worker's own sends, calls, outcomes or tasks; granting company access is not audited | Mostly settled by [#190](https://github.com/Peertopeer-solutions/revenue-os/pull/190) (the engine's writer is deleted, so audit rows go only through packages/db audit(); tasks and access grants are audited; `bun run guards` fails any other insert into audit_log); the worker's sends, calls and outcomes still write no audit row |
| Queue settings never reach scheduler-enqueued jobs, so a failed call silently strands the lead, and once a real dialer is wired a failure after dialing redials the lead up to 3 times | Settled by [#189](https://github.com/Peertopeer-solutions/revenue-os/pull/189) (the scheduler's jobs take their queue's settings, a send is saved before the provider is called and never sent twice, and a job that fails every try reaches a person through its dead letter) |
| A failed phone-call job rings the lead again: the call happens inside a database transaction that is then undone | Settled by [#189](https://github.com/Peertopeer-solutions/revenue-os/pull/189) (the call is saved before the dialer is called, with no transaction open while it answers, and a later run of the job never dials again) |
| Outside calls (AI model, dialer, WhatsApp) run inside open database transactions holding row locks, and the AI adapter has no timeout even though its type declares one | Slice 1 · "A slow or stuck AI model, dialer or WhatsApp service can't freeze the worker…" (the dialer and WhatsApp calls left their transactions in [#189](https://github.com/Peertopeer-solutions/revenue-os/pull/189); the AI model calls and the timeouts are still to do) |
| No database timeouts on the backend role, while AI and WhatsApp network calls run inside open transactions holding row locks | Slice 1 · "A slow or stuck AI model, dialer or WhatsApp service can't freeze the worker…" |
| An enrolled lead can stop forever with no task, no error and no log | Slice 1 · "A lead's sequence never stops silently…" |
| The worker never shuts down cleanly: the graceful-stop function exists and is tested but nothing in production calls it | Slice 1 · "Restarts lose no work…" |
| Console unit tests only render once on the server, so clicks, forms and effects are never tested; 7 screens and the guardrail Save have no browser test | Slice 1 · "Browser checks prove the console works…" |
| Console boot smoke passes while the console shows its 'configuration incomplete' error screen | Slice 1 · "Browser checks prove the console works…" |
| The demo runs a hand-copied sequence labelled 'VERBATIM' that has already drifted from the one the product ships | Moved: Slice 3 · "`bun run demo --keep` runs the sequence a real company gets…" |
| Module boundaries are not enforced: 28 verified cross-boundary imports, and only the no-Bun rule is linted | Slice 3 · "Lint enforces which parts of the code may import which…", then entry 9 here for its allowed exceptions |
| No spending limit on the AI: 'spend cap' is declared as a guardrail and claimed as enforced, but nothing implements it | Slice 3 · "A daily limit on the AI tokens each lead and each company can use…" |
| Agent evals never run automatically; nothing checks the AI's behaviour before a version goes live | Slice 3 · "Test conversations the agent must pass…" |
| Voice webhook trust is one secret for every company, and the company comes from the URL; the WhatsApp build is told to copy this receiver | Slice 4 · "Voice agent set up from our own agent settings and pushed to Vapi…" (the "do not copy" mark on the skill's pointer: done in [#129](https://github.com/devesh911/revenue-os/pull/129)) |
| Vapi call results are filed under whichever company id is in the web address; one secret is shared by all companies | Slice 4 · "Voice agent set up from our own agent settings and pushed to Vapi…" |
| Each API response shape is hand-written twice (database package and console), and the message-role list four times | Slice 5 · "Each API response is described once, in packages/shared…" |
| No content security policy or anti-framing header for the console or the marketing site | Console half: Slice 5 · "Console security headers…". Marketing half settled by [#111](https://github.com/devesh911/revenue-os/pull/111) (`apps/www/public/_headers`) |
| The security baseline has no owner on the roadmap: 80 of 80 controls are unticked, and code comments cite controls that do not exist | Slice 6 · "Before go-live, every control in docs/security.md is ticked…" |
| No lead's personal data can be erased: the database blocks deleting a lead, and messages, raw call payloads and memories have no delete path | Slice 6 · "A lead's personal data can be erased on request…" |
| Nothing can be deleted (company, staff user or lead), and tests hand-delete child rows as a workaround | Slice 6 · "A lead's personal data can be erased on request…" |
| Nothing on main enforces the definition of done; the 'no false done' rule is honour-system | Settled by [#106](https://github.com/devesh911/revenue-os/pull/106) (the done gate); its known holes: Slice 0's four items on the verifier ruling, the check before each command and merges, every stop, and the done rules |
| `bun run gates` 'run bare', as AGENTS.md instructs, cannot pass in any worktree; the skill tells agents to let CI judge | Partly settled by [#106](https://github.com/devesh911/revenue-os/pull/106) (`bun run gate` runs with the local stack's settings); the "CI is the verdict" lines left over in the task-loop skill and STATE.md were reworded on 2026-10-02 |
| Wired-up job paths that nothing ever triggers, while STATE.md says the agent loop 'Works' and runs on text replies | Settled by [#110](https://github.com/devesh911/revenue-os/pull/110) (the row says Tests only); its stale comment: entry 1 here; its dead hand-over action was deleted on 2026-10-12 (Slice 1 · "Every database query also filters by company…"); shutdown on restart: Slice 1 · "Restarts lose no work…" |
| STATE.md 'What works today' overstates several rows | Partly settled by [#110](https://github.com/devesh911/revenue-os/pull/110) (the agent-loop and scheduler rows); the comment claiming a per-assistant secret: entry 1 here; splitting the "Works" status into works-locally and live was not taken up |
| Setting up an agent and a sequence, activating an agent, creating a login and hand-off exist only in local scripts or tests, and STATE has no row for them | Settled by [#110](https://github.com/devesh911/revenue-os/pull/110) (rows added to STATE.md → What works today) |
| The fixed step-map decision core is scheduled for replacement but nothing stops agents from building more on it; keep-vs-replace map | Partly settled by [#110](https://github.com/devesh911/revenue-os/pull/110) (the freeze in docs/decisions-in-force/); the freeze line in the harness-agent skill and the verifier: entry 4 here |
| Old ID codes in code comments point to archived docs, and the T-numbers collide with docs/tech-stack.md | Entry 1 |
| Code comments name finished tasks as the fix for stubs that are still live | Entry 1 |
| Dead modules that advertise a second way of doing things: Drizzle schema mirror and dependency, AI-provider registry, a stale demo script, an unused component | Entry 2 |
| Half the schema has no production code, and a Drizzle 'mirror' covers 3 of 33 tables, is unused, and is labelled the only DB entry | Entry 2 |
| 16 test files check source code as text instead of what the code does, and the repo teaches this as 'the RED idiom' | Settled by [#137](https://github.com/devesh911/revenue-os/pull/137) (render, start-up, hook and browser tests, a lint rule and guards replace them; the idiom comments are gone) |
| 38 stale 'RED today' comments on passing tests, tests that only pin a finished file move, and console tests split across two folders | Mostly settled by [#137](https://github.com/devesh911/revenue-os/pull/137) (the console tests are in one folder, the move pins are gone); of the six 'RED today' comments left, four went with [#187](https://github.com/Peertopeer-solutions/revenue-os/pull/187), and two remain: entry 3 |
| Skills tell agents that lessons.md outranks them, but lessons.md is 36 KB of mostly resolved history that calls itself 'not law'; its lessons should become checks | Entry 4 |
| Skills restate facts that have drifted; two of five skills are switched off locally; a stale untracked .agents skill copy remains | Entry 4 (the switched-off skills: Devesh's "Finish clearing the retired orchestrator from your Mac" item in STATE.md → Waiting on Devesh) |
| The retired orchestrator is still wired into the go-live and incident runbooks, and its watchdog is still installed on Devesh's Mac | Entry 5, at the latest in Slice 6 · "Before go-live, every control in docs/security.md is ticked…" (the watchdog: Devesh's "Finish clearing the retired orchestrator from your Mac" item in STATE.md → Waiting on Devesh) |
| The tracker page Devesh uses to see progress is 3 days stale; the manual republish step was skipped | Settled by [#118](https://github.com/devesh911/revenue-os/pull/118) (the page shows the commit and date it was published from; entry 6 struck) |
| The landing page tells buyers in the present tense that voice, WhatsApp and do-not-call checks work today | Settled by [#111](https://github.com/devesh911/revenue-os/pull/111) (the FAQ says what the pilot will do; entry 7 struck) |
| Stale worktrees, branches, a second out-of-date clone, and untracked out-of-date skill copies around the main checkout | Entry 8 |

Totals: Slice 0 holds none, Slice 1 holds 17, Slice 3 holds 12 (9 moved), Slice 4 holds 5 (3 moved), Slice 5 holds 6 (4 moved), Slice 6 holds 3; 22 are settled or partly settled by merged PRs; 8 are entries here. Total 73.

---

9 entries, from 10 findings and the structure review.
