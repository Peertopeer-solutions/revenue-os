// For the done rules (rules.ts): CI's required check is the job `checks`. When ci.yml splits the work into other jobs,
// `checks` must pass only when every one of them passed: it waits for every other job (`needs`), runs whatever
// happened to them (`if: always()`), and holds one step, one of the two fixed ones below, unconditioned, in the default
// shell and with no settings of its own beside it; and nothing at the workflow's top (`env`, `defaults`) or another job
// named `checks` can stand in for it. One skip is allowed: a job may be held back from pull requests (QUEUE_ONLY), to
// run only in the merge queue and on main, when `checks` holds the step that accepts a skipped job on a pull request
// alone. So no other job condition is allowed (one could skip a job in the merge queue), no job that runs on pull
// requests may wait for a held-back one (it would be skipped there too), and at least one job must run on them.
// Whether or not the work is split, no job's work may be hidden from a pass: no continue-on-error, which turns a
// failure into a pass; no step condition that skips a step on the way to a passing job; no shell that carries on past
// a failing command; and no call to another workflow or a local action, whose steps this rule can't see. A file the
// rule reads differently from GitHub (a key YAML's `?` form hides, no `jobs` it can find) is refused, not passed.

export const CI = ".github/workflows/ci.yml";

/** The one step `checks` holds: it fails unless every job `checks` waits for ended in success. */
export const ALL_PASSED = {
  name: "Every job it waits for passed",
  env: { RESULTS: `\${{ join(needs.*.result, ' ') }}` },
  run: 'for r in $RESULTS; do test "$r" = success || { echo "a job checks waits for ended $r ($RESULTS)"; exit 1; }; done',
};
/** A job's condition that holds it back from pull requests: it runs in the merge queue and on pushes to main. */
export const QUEUE_ONLY = "github.event_name != 'pull_request'";
/** The other step `checks` may hold: as ALL_PASSED, but on a pull request a job may also have been skipped. */
export const QUEUE_ONLY_SKIPPED = {
  name: "Every job it waits for passed, or on a pull request was held back from it",
  env: {
    RESULTS: ALL_PASSED.env.RESULTS,
    HELD_BACK: `\${{ github.event_name == 'pull_request' && 'skipped' || 'none' }}`,
  },
  run: 'for r in $RESULTS; do test "$r" = success || test "$r" = "$HELD_BACK" || { echo "a job checks waits for ended $r ($RESULTS)"; exit 1; }; done',
};
// What `checks` may set beside its needs, its condition and that step.
const CHECKS_KEYS = new Set([
  "needs",
  "if",
  "runs-on",
  "permissions",
  "steps",
  "timeout-minutes",
  "name",
]);
// The step conditions that never skip a step on the way to a passing job; success() is GitHub's own default.
const STEP_IFS = new Set([
  "always()",
  "!cancelled()",
  "success()",
  "success() || failure()",
]);
// The shells that stop at the first failing command (GitHub runs them with -e); a step without one runs in bash -e.
const SHELLS = new Set(["bash", "sh"]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Exactly the fixed env, in any order. */
const sameEnv = (a: unknown, b: Record<string, string>) =>
  isRec(a) &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([k, v]) => a[k] === v);
/** A condition as written, without the `${{ }}` GitHub also accepts around it; success() alone is no condition. */
const cond = (v: unknown) => {
  const c = String(v ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  return c === "success()" ? "" : c;
};
/** Does the parsed file hold a key Bun read from YAML's `?` form, which GitHub reads as the key it names? */
const hiddenKey = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(hiddenKey)
    : isRec(v) &&
      Object.entries(v).some(
        ([k, x]) => k === "[object Object]" || hiddenKey(x),
      );

/** Why the job `id` could pass while its work did not run or failed. */
function jobProblems(id: string, job: Rec): string[] {
  const problems: string[] = [];
  if (job.uses !== undefined)
    problems.push(
      `the job ${id} calls another workflow (${String(job.uses)}), whose steps this rule can't see`,
    );
  if (job["continue-on-error"] !== undefined)
    problems.push(
      `the job ${id} sets continue-on-error, which turns its failure into a pass`,
    );
  const shell =
    isRec(job.defaults) && isRec(job.defaults.run)
      ? job.defaults.run.shell
      : undefined;
  if (shell !== undefined && !SHELLS.has(String(shell)))
    problems.push(
      `the job ${id} runs its steps in the shell "${String(shell)}", which may carry on past a failing command; only bash or sh may be named`,
    );
  for (const step of Array.isArray(job.steps) ? job.steps : []) {
    if (!isRec(step)) continue;
    const label = String(step.name ?? step.run ?? step.uses ?? "unnamed").split(
      "\n",
    )[0];
    if (step["continue-on-error"] !== undefined)
      problems.push(
        `a step of the job ${id} (${label}) sets continue-on-error, which turns its failure into a pass`,
      );
    if (cond(step.if) && !STEP_IFS.has(cond(step.if)))
      problems.push(
        `a step of the job ${id} (${label}) runs only when \`${cond(step.if)}\`, so the job could pass without it; a step may only set \`if: always()\` or \`if: !cancelled()\``,
      );
    if (step.shell !== undefined && !SHELLS.has(String(step.shell)))
      problems.push(
        `a step of the job ${id} (${label}) runs in the shell "${String(step.shell)}", which may carry on past a failing command; only bash or sh may be named`,
      );
    if (String(step.uses ?? "").startsWith("./"))
      problems.push(
        `a step of the job ${id} runs a local action (${String(step.uses)}), whose steps this rule can't see`,
      );
  }
  return problems;
}

/** PURE: ci.yml's text → why its `checks` could pass while a job it waits for did not. */
export function ciJobProblems(text: string): string[] {
  let ci: unknown;
  try {
    ci = Bun.YAML.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return [
      `${CI} can't be read as YAML (${(e as Error).message}), so whether \`checks\` waits for every job can't be told`,
    ];
  }
  if (!isRec(ci) || !isRec(ci.jobs) || hiddenKey(ci))
    return [
      `${CI} has no \`jobs\` this rule can read, or a key written in YAML's \`?\` form, so whether \`checks\` waits for every job can't be told`,
    ];
  const jobs = ci.jobs;
  const others = Object.keys(jobs).filter((id) => id !== "checks");
  const checks = jobs.checks;
  if (!others.length)
    return !isRec(checks)
      ? []
      : [
          ...(cond(checks.if) && cond(checks.if) !== "always()"
            ? [
                `the job checks runs only when \`${cond(checks.if)}\`, and a skipped check can pass`,
              ]
            : []),
          ...jobProblems("checks", checks),
        ];
  if (!isRec(checks))
    return [
      `${CI} has jobs (${others.join(", ")}) but none named \`checks\`, the check main's ruleset requires`,
    ];
  const problems: string[] = [];
  const needs = new Set([checks.needs ?? []].flat().map(String));
  for (const id of others)
    if (!needs.has(id))
      problems.push(
        `\`checks\` does not wait for the job ${id} (its \`needs\`)`,
      );
  if (cond(checks.if) !== "always()")
    problems.push(
      "`checks` lacks `if: always()`, so a job that fails would skip it, and a skipped check can pass",
    );
  for (const key of Object.keys(checks))
    if (!CHECKS_KEYS.has(key))
      problems.push(
        `\`checks\` sets \`${key}\`, which could change what it reports`,
      );
  if (checks.name !== undefined && checks.name !== "checks")
    problems.push(`\`checks\` is named "${String(checks.name)}", not checks`);
  const [step, ...more] = Array.isArray(checks.steps) ? checks.steps : [];
  const fixed = [ALL_PASSED, QUEUE_ONLY_SKIPPED].some(
    (f) =>
      !more.length &&
      isRec(step) &&
      Object.keys(step).every((k) => ["name", "env", "run"].includes(k)) &&
      sameEnv(step.env, f.env) &&
      String(step.run ?? "").trim() === f.run,
  );
  if (!fixed)
    problems.push(
      `\`checks\` must hold exactly one step, ${JSON.stringify(ALL_PASSED)}, which fails unless every job it waits for passed, or ${JSON.stringify(QUEUE_ONLY_SKIPPED)}, which also lets a job held back from pull requests be skipped on one`,
    );
  if (ci.env !== undefined || ci.defaults !== undefined)
    problems.push(
      "ci.yml sets `env` or `defaults` for every job, which could change how `checks` runs its step",
    );
  const heldBack = new Set(
    others.filter((id) => isRec(jobs[id]) && cond(jobs[id].if) === QUEUE_ONLY),
  );
  if (heldBack.size === others.length)
    problems.push(
      "every job `checks` waits for is held back from pull requests, so there `checks` would pass having run none",
    );
  // `checks` itself is judged above: its keys, and its one step, exactly.
  for (const id of others) {
    const job = jobs[id];
    if (!isRec(job)) continue;
    if (String(job.name ?? "").trim() === "checks")
      problems.push(`the job ${id} is named checks, as the required check is`);
    if (!heldBack.has(id)) {
      if (cond(job.if))
        problems.push(
          `the job ${id} runs only when \`${cond(job.if)}\`; a job \`checks\` waits for may be held back only from pull requests, by \`if: ${QUEUE_ONLY}\``,
        );
      for (const dep of [job.needs ?? []].flat().map(String))
        if (heldBack.has(dep))
          problems.push(
            `the job ${id} runs on pull requests but waits for ${dep}, which is held back from them, so ${id} would be skipped there too and \`checks\` would pass without it`,
          );
    }
    problems.push(...jobProblems(id, job));
  }
  return problems;
}
