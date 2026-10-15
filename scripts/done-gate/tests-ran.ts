// `bun run gate tests [e2e]`: bun's tests or the browser checks, as CI runs them, failing if any test did not run,
// or, for bun's tests, if a line the change adds is run by no test (coverage.ts).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverageProblems, gapsTold } from "./coverage";

// Tests allowed not to run, as "file > name", and why. Any other test that bun or Playwright reports as skipped
// or todo fails the tests or browser checks (`bun run gate tests`), however it was switched off. Empty: the one
// test it listed, the dev login's sign-up, went with self sign-up (Slice 1), and its replacement runs everywhere.
export const MAY_SKIP: Record<string, string> = {};

// The four-runs-at-once test (four whole-suite runs and a demo started together), the switch that leaves it out of
// the whole-suite run by its path, never by skipping it, and the one that runs it alone. The Mac's gate and CI's
// whole-suite job leave it out (checks.ts, ci.yml); CI's at-once job runs it alone, in the merge queue's build and on
// pushes to main (it is held back from pull requests), where CI's required `checks` passes only when every other job
// did (ci-jobs.ts, merge-gate.ts).
export const AT_ONCE = "services/worker/test/test-runs-at-once.test.ts";
export const LEAVE_AT_ONCE = "--leave-at-once-to-ci";
export const AT_ONCE_ALONE = "--at-once-alone";

/** What `bun run gate tests` runs: bun's whole suite, all but AT_ONCE, AT_ONCE alone, or the browser checks. */
export type TestsRun = "suite" | "leave-at-once" | "at-once-alone" | "e2e";

/** PURE: a JUnit report, bun's or Playwright's → every test it lists as skipped or todo, as "file > name". */
export function notRun(report: string): string[] {
  const entity: Record<string, string> = {
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    amp: "&",
  };
  const text = (s = "") =>
    s.replace(/&(quot|apos|lt|gt|amp);/g, (_, e: string) => entity[e] ?? _);
  return [
    ...report.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ]
    .filter(([, , body = ""]) => body.includes("<skipped"))
    .map(([, attrs = ""]) => {
      const attr = (k: string) =>
        text(attrs.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1]);
      return `${attr("file") || attr("classname")} > ${attr("name")}`;
    });
}

/**
 * `bun run gate tests [e2e]`: bun's tests, or the browser checks, as CI runs them (CI=1, so bun and Playwright
 * refuse .only), then fails if any test was skipped or left todo, however it was switched off, unless MAY_SKIP
 * lists it. Bun's whole-suite runs also write their coverage, and fail if a product line the change adds is run by
 * no test. AT_ONCE alone runs no product line in its own process, so it has no coverage check; it fails unless its
 * report lists exactly one test.
 */
export function allTestsRun(repo: string, run: TestsRun = "suite"): number {
  const dir = mkdtempSync(join(tmpdir(), "done-gate-tests-"));
  const report = join(dir, "junit.xml");
  const coverage = run === "suite" || run === "leave-at-once";
  try {
    const r = spawnSync(
      process.execPath,
      run === "e2e"
        ? ["run", "e2e", "--reporter=list,junit"]
        : [
            "test",
            "--reporter=junit",
            `--reporter-outfile=${report}`,
            ...(coverage
              ? [
                  "--coverage",
                  "--coverage-reporter=lcov",
                  `--coverage-dir=${dir}`,
                ]
              : [`./${AT_ONCE}`]),
            ...(run === "leave-at-once"
              ? [`--path-ignore-patterns=${AT_ONCE}`]
              : []),
          ],
      {
        cwd: repo,
        stdio: "inherit",
        env: { ...process.env, CI: "1", PLAYWRIGHT_JUNIT_OUTPUT_FILE: report },
      },
    );
    const junit = existsSync(report) ? readFileSync(report, "utf8") : "";
    const off = notRun(junit).filter((t) => !(t in MAY_SKIP));
    if (off.length)
      console.error(
        `✗ ${off.length} test(s) did not run (skipped or todo):\n${off.map((t) => `- ${t}`).join("\n")}\nMake each one run. One that truly can't run everywhere goes in MAY_SKIP in scripts/done-gate/tests-ran.ts, with why; Devesh sees that change.`,
      );
    const listed = junit.match(/<testcase\b/g)?.length ?? 0;
    const notOne = run === "at-once-alone" && listed !== 1;
    if (notOne)
      console.error(
        `✗ ${AT_ONCE} must run its one test alone, but the report lists ${listed}.`,
      );
    const gaps = coverage ? coverageProblems(repo, join(dir, "lcov.info")) : [];
    if (gaps.length) console.error(gapsTold(gaps));
    return (r.status ?? 1) || (off.length || gaps.length || notOne ? 1 : 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
