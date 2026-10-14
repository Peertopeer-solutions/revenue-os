# D36 — Phased security posture: SETUP → LIVE (one explicit switch, no ambient contradictions)

**Status:** In force. Its rules are restated in `AGENTS.md` (hard rail 7) and `STATE.md` (PHASE line and Decisions in force); this file keeps the reasoning.

## Context

By 2026-07-12, merge authority was stated differently in six places spanning three policy
generations: security.md S13.1/S13.6 ("merge is structurally human", written pre-autonomy),
dev-workflow §1/§3/§4B (the D32 solo-mode-bypass era), the task-loop skill ("human-only, never
squash"), orchestrator/CLAUDE.md ("Never: approve/merge"), AGENTS.md rail 6 ("currently Devesh's
act"), and the doc-change skill ("only his merge makes it law") — while live reality was a
zero-approval ruleset (autonomy v2.1), a named auto-merge-on-green grant, and agents
squash-merging PRs #30–#33 under it. Every text was honest when written; none were reconciled
when the posture moved. The cost is real: agents hesitate, or obey whichever law they read first.

Devesh's direction (2026-07-12, verbatim intent): *speed now — we're setting up and must break
stuff; maximum security at go-live, every step monitored; security features are sacred and get
tightened and reviewed more often once live.*

## Decision

**One phase switch, one location: `STATE.md` line 1 — `PHASE: SETUP` or `PHASE: LIVE`.**
Every phase-conditional rule cites the phase instead of hard-coding an era. Flipping the phase is
**Devesh's act alone**, done as the final step of `docs/runbooks/go-live.md`.

### Phase-independent hard rails (sacred — never traded for speed, in either phase)

These are *technical* controls that run mechanically on every PR/boot; SETUP does not weaken them:

1. Secrets: never read/write `.env*` values; no tokens in chat/commits/logs; gitleaks in CI.
2. Tenancy: org_id + RLS + cross-tenant denial tests; DB access only via packages/db withOrg;
   rls_coverage gate raises on offenders.
3. History: migrations append-only; no force-push on shared branches.
4. Sends: outbound messages only through packages/channels guard(); autonomy checks on tool
   side effects; approval-gated tools become human tasks, never silent sends.
5. Webhooks: signature verified on the raw body before anything; idempotency by constraint.
6. CI is the trust anchor (S13.7): merge decisions read observed CI checks, never local claims.

### SETUP phase (now): what is deliberately relaxed, and why it is safe enough

- **Agents create AND merge PRs** on: observed-green required `checks` + genuine testing evidence
  (bare-gates exit 0 minimum; live/e2e proof for runtime surfaces) + base==main + one PR at a
  time. This writes Devesh's 2026-07-11 grant into law. **Squash-merge is the standard for
  independent branches**; stacked branches (rare now) keep D32's merge-commit rule because squash
  rewrites the patches above.
- Human approval count = 0 on the ruleset; CODEOWNERS review not enforced. Docs PRs follow the
  same merge-on-green path **when Devesh commissioned the change in-session**; uncommissioned doc
  changes still stop at a DRAFT PR for him.
- S13.2 bot identity, S13 preflight, and the unattended watchdog stay **parked** (interactive
  loops only). S13.8 container isolation, monitoring/alerting, and kill-switch rehearsal are
  deferred to go-live.
- Deny-lists stay as friction/audit signal; the auto-mode classifier remains the live guard for
  genuinely destructive/loosening acts (it has proven it fires).

**Accepted risk, stated plainly:** during SETUP a compromised or wrong agent session could merge
bad code into main on a green build. Mitigations that remain: the hard rails above, the
classifier, append-only history (revert is cheap), no production environment exists to damage,
and every secret that exists during SETUP is treated as burned — rotation is a mandatory go-live
step.

### LIVE phase (flip = go-live): maximum force, structurally enforced

- Ruleset back to: 1 approval + code-owner review on `docs/**`/`CLAUDE.md` + required checks
  (backup JSON: `orchestrator/state/ruleset-18778679-backup-2026-07-11.json`). Agents cannot
  merge — enforced by GitHub, not by promise. S13.1–S13.9 apply in full, preflight mandatory
  before any autonomous run.
- All SETUP-era secrets rotated; demo users/orgs deleted; monitoring (uptime on /health + /ready,
  log drain, advisor runs, dependency alerts) on before traffic; kill-switch rehearsed.
- Every step of the flip lives in `docs/runbooks/go-live.md` (Devesh-only tasks, checkbox form).
  The runbook's last step commits `PHASE: LIVE` to STATE.md, which re-arms every conditional rule.

## Alternatives considered

- **Keep patching individual docs as posture shifts** — rejected: that is the process that
  produced six contradictory statements in 48 hours.
- **Two rulebooks (setup.md / live.md)** — rejected: two documents drift independently; one
  switch with conditional clauses cannot disagree with itself.
- **Full security now** — rejected by the owner: setup-phase iteration speed is the product
  priority; there is no production data or traffic to protect yet.

## Consequences

- AGENTS.md rail 6, security.md S13 preamble + S13.1/S13.6, dev-workflow §1/§3/§4B merge lines,
  task-loop + doc-change skills all patched in this PR to cite the phase (cross-reference rule,
  spec §0). orchestrator/CLAUDE.md patched in its own repo, same day.
- `docs/runbooks/go-live.md` created (the Devesh-only checklist).
- Sessions read `STATE.md` line 1 before any merge-authority decision.

## Reversal trigger

Any real security incident during SETUP (leaked non-local secret, cross-tenant read, bad merge
that reaches a deployed environment) ⇒ flip to LIVE posture immediately regardless of launch
readiness, then reassess.
