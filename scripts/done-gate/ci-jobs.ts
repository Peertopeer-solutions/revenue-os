// For the done rules (rules.ts): CI's required check is the job `checks`. When ci.yml splits the work into other jobs,
// `checks` must pass only when every one of them passed: it waits for every other job (`needs`), runs whatever
// happened to them (`if: always()`), and holds one step, one of the two fixed ones below, unconditioned, in the default
// shell and with no settings of its own beside it; no job or step may set continue-on-error, which turns a failure into
// a pass; and nothing at the workflow's top (`env`, `defaults`) or another job named `checks` can stand in for it.
// One skip is allowed: a job may be held back from pull requests (QUEUE_ONLY), to run only in the merge queue and on
// main, when `checks` holds the step that accepts a skipped job on a pull request alone. So no other job condition is
// allowed (one could skip a job in the merge queue), no job that runs on pull requests may wait for a held-back one
// (it would be skipped there too), at least one job must run on pull requests, no step may be skipped while its job
// passes (`if:` only `always()` or `!cancelled()`), and no job may call another workflow, whose steps can't be seen.

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
// The step conditions that never skip a step on the way to a passing job.
const STEP_IFS = new Set(["always()", "!cancelled()"]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** A condition as written, without the `${{ }}` GitHub also accepts around it. */
const cond = (v: unknown) =>
  String(v ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");

/** PURE: ci.yml's text → why its `checks` could pass while a job it waits for did not; nothing for a single job. */
export function ciJobProblems(text: string): string[] {
  let ci: unknown;
  try {
    ci = Bun.YAML.parse(text);
  } catch (e) {
    return [
      `${CI} can't be read as YAML (${(e as Error).message}), so whether \`checks\` waits for every job can't be told`,
    ];
  }
  const jobs = isRec(ci) && isRec(ci.jobs) ? ci.jobs : {};
  const others = Object.keys(jobs).filter((id) => id !== "checks");
  if (!others.length) return [];
  const checks = jobs.checks;
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
      same(step.env, f.env) &&
      String(step.run ?? "").trim() === f.run,
  );
  if (!fixed)
    problems.push(
      `\`checks\` must hold exactly one step, ${JSON.stringify(ALL_PASSED)}, which fails unless every job it waits for passed, or ${JSON.stringify(QUEUE_ONLY_SKIPPED)}, which also lets a job held back from pull requests be skipped on one`,
    );
  if (isRec(ci) && (ci.env !== undefined || ci.defaults !== undefined))
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
      if (job.if !== undefined)
        problems.push(
          `the job ${id} runs only when \`${cond(job.if)}\`; a job \`checks\` waits for may be held back only from pull requests, by \`if: ${QUEUE_ONLY}\``,
        );
      for (const dep of [job.needs ?? []].flat().map(String))
        if (heldBack.has(dep))
          problems.push(
            `the job ${id} runs on pull requests but waits for ${dep}, which is held back from them, so ${id} would be skipped there too and \`checks\` would pass without it`,
          );
    }
    if (job.uses !== undefined)
      problems.push(
        `the job ${id} calls another workflow (${String(job.uses)}), whose steps this rule can't see`,
      );
    if (job["continue-on-error"] !== undefined)
      problems.push(
        `the job ${id} sets continue-on-error, which turns its failure into a pass`,
      );
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!isRec(step)) continue;
      const label = String(
        step.name ?? step.run ?? step.uses ?? "unnamed",
      ).split("\n")[0];
      if (step["continue-on-error"] !== undefined)
        problems.push(
          `a step of the job ${id} (${label}) sets continue-on-error, which turns its failure into a pass`,
        );
      if (step.if !== undefined && !STEP_IFS.has(cond(step.if)))
        problems.push(
          `a step of the job ${id} (${label}) runs only when \`${cond(step.if)}\`, so the job could pass without it; a step may only set \`if: always()\` or \`if: !cancelled()\``,
        );
    }
  }
  return problems;
}
