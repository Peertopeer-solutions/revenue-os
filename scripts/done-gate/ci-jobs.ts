// For the done rules (rules.ts): CI's required check is the job `checks`. When ci.yml splits the work into other jobs,
// `checks` must pass only when every one of them passed: it waits for every other job (`needs`), runs whatever
// happened to them (`if: always()`), and holds one step, the fixed one below, unconditioned, in the default shell and
// with no settings of its own beside it; no job or step may set continue-on-error, which turns a failure into a pass;
// and nothing at the workflow's top (`env`, `defaults`) or another job named `checks` can stand in for it.

export const CI = ".github/workflows/ci.yml";

/** The one step `checks` holds: it fails unless every job `checks` waits for ended in success. */
export const ALL_PASSED = {
  name: "Every job it waits for passed",
  env: { RESULTS: `\${{ join(needs.*.result, ' ') }}` },
  run: 'for r in $RESULTS; do test "$r" = success || { echo "a job checks waits for ended $r ($RESULTS)"; exit 1; }; done',
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

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

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
  if (
    !["always()", `\${{ always() }}`].includes(String(checks.if ?? "").trim())
  )
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
  const fixed =
    !more.length &&
    isRec(step) &&
    Object.keys(step).every((k) => ["name", "env", "run"].includes(k)) &&
    same(step.env, ALL_PASSED.env) &&
    String(step.run ?? "").trim() === ALL_PASSED.run;
  if (!fixed)
    problems.push(
      `\`checks\` must hold exactly one step, ${JSON.stringify(ALL_PASSED)}, which fails unless every job it waits for passed`,
    );
  if (isRec(ci) && (ci.env !== undefined || ci.defaults !== undefined))
    problems.push(
      "ci.yml sets `env` or `defaults` for every job, which could change how `checks` runs its step",
    );
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRec(job)) continue;
    if (id !== "checks" && String(job.name ?? "").trim() === "checks")
      problems.push(`the job ${id} is named checks, as the required check is`);
    if (job["continue-on-error"] !== undefined)
      problems.push(
        `the job ${id} sets continue-on-error, which turns its failure into a pass`,
      );
    for (const step of Array.isArray(job.steps) ? job.steps : [])
      if (isRec(step) && step["continue-on-error"] !== undefined)
        problems.push(
          `a step of the job ${id} (${String(step.name ?? step.run ?? step.uses ?? "unnamed").split("\n")[0]}) sets continue-on-error, which turns its failure into a pass`,
        );
  }
  return problems;
}
