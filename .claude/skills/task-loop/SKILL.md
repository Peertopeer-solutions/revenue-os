---
name: task-loop
description: Use when building a roadmap item — any session implementing the next unchecked item of the current slice in ROADMAP.md, or a Side-track or off-roadmap PR. The branch → failing test → implementation → gates → PR → observed-green CI → evidence → roadmap/state update procedure, the WIP cap, and merge discipline.
---

# task-loop — the per-item build loop (AGENTS.md is the rulebook; this is the checklist)

## Read first, in this order
1. `AGENTS.md` — hard rails, **Definition of done**, the loop, merge rule.
2. `ROADMAP.md` — the current slice (`bun run cycle --banner` prints it; the rule is at the top of
   ROADMAP.md): its goal, its proof, your item.
3. `STATE.md` — line 1 PHASE, **What works today** (is the thing you touch a Stub? a Tests-only?),
   **Decisions in force**.
4. `docs/NORTH-STAR.md` if the item touches what the product does for a customer.

## The loop (every step blocking)
1. **WIP cap:** three or more open task PRs ⇒ stop and tell Devesh.
2. **Check the item against current main** — it may already be done or overtaken.
3. Branch `feat/…` or `fix/…` off up-to-date `origin/main` — independent, never stacked — and record
   what it builds: `git config branch.<name>.description "<text>"`, the text being the item's text,
   `Side track: <what>` or `Off-roadmap: <what>` (the hooks show it on every prompt).
4. **Failing test first**, at the layer you touch. For security, RLS, migration or guard work,
   review the failing tests line by line before writing the implementation.
5. Implement **with its production caller** — a capability nothing real calls is not done.
6. Show it working: run it from a real entry point (API call, script against the local stack,
   `bun run see <console path>`) and capture the evidence.
7. Open the PR and write its records now, before the run the merge uses, so the gate and the verifier
   rule on the final code. PR body: written as AGENTS.md → The loop, step 4, says (its first line,
   every line that step says it owes, then what / why / evidence), the gate's line and the ruling
   left for step 10; `PR_BODY="$(cat body.md)" bun run gate pr` judges it as `rules-from-main` will.
   Same PR: tick the item in `ROADMAP.md` with `· evidence: …`, from what you have seen (a Side-track
   or off-roadmap PR has no line to tick; its PR body's evidence is the record); update `STATE.md →
   What works today` if reality changed; add a `Decisions in force` line for any decision.
8. Go through **Before your first verifier run** (below), then `bun run gate` run bare (never piped).
   Every check passes in `bun run gate` here first, and CI confirms it.
9. Run the verifier agent with Devesh's request word for word (when he gave none, the roadmap item's
   text, word for word); the done gate won't let you stop on product code without its PASS, or its
   CANNOT_VERIFY naming what only Devesh can provide (he is told it is NOT verified). A FAIL means a
   fix, then steps 7 to 9 again on the new code.
10. Put the gate's line and the verifier's ruling in the PR body, which is not in the files, so the
    code they ruled on stays the code that merges. `gh pr checks <n> --watch` — every required check
    must be observed green on GitHub; absent or red means stop.
11. Merge per PHASE (STATE.md line 1): SETUP = squash-merge one PR at a time after confirming
    `gh pr view <n> --json baseRefName` is main; never loop merges. LIVE = never merge. Merge with
    `gh pr merge <n> --squash --match-head-commit <the PR's full head commit>`; AGENTS.md → The loop,
    step 5, says what the done gate checks before it lets that through. Once main's ruleset has a merge
    queue, that command queues the PR instead (no need to bring main in first): watch it land on main
    (`gh pr view <n> --json state`); if the queue takes it out, fix it, re-gate, re-verify and queue it again.
12. After merge, republish the tracker page (see AGENTS.md → The loop, step 6).
13. If the last item of the slice landed, set the slice to `proof ready`; the proof workflow runs
    `bun run proof <slice>` after the next deploy to main and once a day, and `bun run cycle
    --banner` shows its latest run. When every step passes, set the slice to `done` and write the
    date and the passing run's link after `Proof passed:` (the banner prints the line), in a PR
    whose body carries the run's report (the run posts it to the "Proof reports" GitHub issue,
    which reaches Devesh; `rules-from-main` checks the link and the report); if a step
    fails, add an item naming the failure and set the slice back to `in progress`; a step reported
    as waiting on something in `STATE.md → Waiting on Devesh` changes nothing (AGENTS.md →
    Definition of done).

## Before your first verifier run: its commonest FAIL reasons
18 of the verifier's 39 runs from 2026-10-02 to 2026-10-12 ruled FAIL, and each FAIL costs a round of fix,
gate, verifier and CI, about 50 minutes. These are the reasons those rulings gave, as the pull request bodies
and session transcripts of that time record them. Check each one yourself first. This list adds to the
verifier's checks and replaces none; your answers are for you, never evidence you hand the verifier.
1. **The records match the code, and main after each merge, counts included.** ROADMAP.md, STATE.md, the
   docs and the PR body say what the code does now: count every number again (tests, steps, files,
   statements), read every name and claim against the code, and after merging main in, read again each line
   the merge touched (seen in PRs 129, 152, 153, 160, 161).
2. **Each outside call's failure has a test.** An outside call (the database, a provider, `gh`, `git`, `ps`,
   the sign-in server) can be unreachable, answer empty, be cancelled, or get bad or missing input: each case
   is answered correctly, has a test, and marks no good work failed (PRs 144, 147, 154, 157, 159).
3. **Each edge case the request names has a test**, at the layer people use: another company, a duplicate,
   empty or missing input, a value too long (PRs 154, 157, 159).
4. **Each new or edited test fails on main for its stated reason**, not for another one: run it on main's
   code and read why it fails (PRs 148, 160).
5. **A decision line covers this change only.** Its headline claims no more than the code does, and it
   loosens no rule from outside the rule files (PRs 147, 157).
6. **The PR is open, and the item's ROADMAP.md and STATE.md lines are written, before the `bun run gate` and
   verifier run whose results the merge uses** (step 7), so both rule on the final code. Claim no ruling or
   CI result you have not seen, and leave no placeholder by the time you merge (PRs 148, 152, 160).

## Never (any phase)
Edit applied migrations · touch `.env`/secrets · force-push · add a dependency without a
justification line · mutate an active agent/workflow version · approve a PR · call a stubbed or
caller-less capability "done" · merge while `STATE.md` says `PHASE: LIVE` · drop the current item
for a new build ask except as AGENTS.md → The loop, step 1 allows (marketing site: the Side track, no
replan; an item from a later slice: a replan that moves its line into the current slice; anything
else: only after Devesh says "off-roadmap" or "replan") · open a second off-roadmap PR, or a second
Side-track PR, while one of the same kind is open (two separate limits, so one of each may be open;
AGENTS.md → The loop, step 1 has the command that finds them) · commit work that does not belong in
the repo (prospect lists, videos, research, naming, real people's data; the repo's own fake seed
and test data is fine to commit).

## Parallel waves (optional, when items are file-disjoint)
One worktree per item under `.claude/worktrees/` (never in lint scope); every check passes in
`bun run gate` here first, and CI confirms it; landing stays serial, base == main each time; at most one migration-writing item per wave.

## What the old lessons became
The lessons this skill once sent you to lessons.md for (gates, CI, pipes, worktrees, queues, exit codes)
are checks now:
- A gate whose exit code a pipe hides lets nothing through: a stop and a merge count only the gate's own
  record of a pass (scripts/done-gate/verdict.ts, merge-gate.ts), never an exit code you read.
- A red or missing CI run stops a merge: it waits until GitHub reports `checks` passed on a head that holds
  main's tip (scripts/done-gate/merge-gate.ts).
- Worktrees stay out of lint: biome.json leaves `.claude/worktrees` out, and scripts/lint-scope.test.ts
  fails if it stops doing so.
- A queued item that already landed: the banner reads ROADMAP.md on origin/main, and `rules-from-main`
  refuses a pull request naming an item main already ticked unless it adds to its evidence
  (scripts/done-gate/pr-first-line.ts).

Read `STATE.md → Decisions in force`; where it and this file disagree, AGENTS.md decides, then that list.
