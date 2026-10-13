// Whether GitHub reports the required check `checks` passed on one exact commit, asked with a read (`gh api`, a GET)
// and counted only from GitHub Actions, the app main's ruleset pins `checks` to. The merge check asks it before every
// merge, as the Mac's gate leaves the four-runs-at-once test to CI; and whether main's rules hold a merge queue.

import { spawnSync } from "node:child_process";

const GITHUB_ACTIONS = 15368; // GitHub Actions' app id, which main's ruleset requires `checks` to come from

type Run = {
  name?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  app?: { id?: number };
};

/**
 * Why GitHub does not show `checks` passed on `sha`, or nothing when it does: every latest `checks` run GitHub
 * Actions reported on that commit completed with success, and there is at least one. `repo` is "owner/name"; with
 * none, gh reads it from the checkout at `cwd`.
 */
export function checksNotPassed(
  sha: string,
  repo: string | undefined,
  cwd: string,
) {
  const r = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo ?? "{owner}/{repo}"}/commits/${sha}/check-runs?check_name=checks&filter=latest`,
    ],
    { cwd, encoding: "utf8", timeout: 20_000 },
  );
  if (r.status !== 0)
    return `GitHub could not be asked (\`gh api\`: ${(r.stderr || "no answer").trim().split("\n")[0]})`;
  let runs: Run[];
  try {
    runs = (JSON.parse(r.stdout) as { check_runs?: Run[] }).check_runs ?? [];
  } catch {
    return "GitHub's answer could not be read";
  }
  const ours = runs.filter(
    (run) =>
      run.name === "checks" &&
      run.head_sha === sha &&
      run.app?.id === GITHUB_ACTIONS,
  );
  if (!ours.length)
    return "GitHub reports no `checks` run by GitHub Actions on it";
  const not = ours.filter(
    (run) => run.status !== "completed" || run.conclusion !== "success",
  );
  if (not.length)
    return `GitHub Actions reports \`checks\` ${not.map((run) => run.conclusion ?? run.status).join(", ")} on it`;
}

/**
 * Whether main's rules on GitHub hold a merge queue at this moment, asked with a read (`gh api`, a GET) of the rules
 * that apply to main, or why that can't be read: GitHub out of reach, an empty answer or one that is not a list of
 * rules. `repo` is "owner/name"; with none, gh reads it from the checkout at `cwd`.
 */
export function mainQueue(
  repo: string | undefined,
  cwd: string,
): { queue: boolean } | { why: string } {
  const r = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo ?? "{owner}/{repo}"}/rules/branches/main?per_page=100`,
    ],
    { cwd, encoding: "utf8", timeout: 20_000 },
  );
  if (r.status !== 0)
    return {
      why: `\`gh api\`: ${(r.stderr || "no answer").trim().split("\n")[0]}`,
    };
  let rules: unknown;
  try {
    rules = JSON.parse(r.stdout);
  } catch {
    rules = undefined;
  }
  // A full page may leave rules out, so it can't say there is no queue.
  if (!Array.isArray(rules) || rules.length >= 100)
    return { why: "an answer it can't read" };
  return {
    queue: rules.some(
      (rule) => (rule as { type?: unknown } | null)?.type === "merge_queue",
    ),
  };
}
