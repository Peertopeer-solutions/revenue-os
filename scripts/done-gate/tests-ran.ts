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

// The four-runs-at-once test (four whole-suite runs and a demo started together) and the switch that leaves it out
// of the whole-suite run by its path, never by skipping it. The Mac's gate sets it (checks.ts); CI's required
// `checks` never does, and every agent merge waits for `checks` to pass (merge-gate.ts).
export const AT_ONCE = "services/worker/test/test-runs-at-once.test.ts";
export const LEAVE_AT_ONCE = "--leave-at-once-to-ci";

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
 * lists it. Bun's run also writes its coverage, and fails if a product line the change adds is run by no test.
 * `leaveAtOnce`: bun's run leaves out AT_ONCE by its path.
 */
export function allTestsRun(
  repo: string,
  e2e: boolean,
  leaveAtOnce = false,
): number {
  const dir = mkdtempSync(join(tmpdir(), "done-gate-tests-"));
  const report = join(dir, "junit.xml");
  try {
    const r = spawnSync(
      process.execPath,
      e2e
        ? ["run", "e2e", "--reporter=list,junit"]
        : [
            "test",
            "--reporter=junit",
            `--reporter-outfile=${report}`,
            "--coverage",
            "--coverage-reporter=lcov",
            `--coverage-dir=${dir}`,
            ...(leaveAtOnce ? [`--path-ignore-patterns=${AT_ONCE}`] : []),
          ],
      {
        cwd: repo,
        stdio: "inherit",
        env: { ...process.env, CI: "1", PLAYWRIGHT_JUNIT_OUTPUT_FILE: report },
      },
    );
    const off = notRun(
      existsSync(report) ? readFileSync(report, "utf8") : "",
    ).filter((t) => !(t in MAY_SKIP));
    if (off.length)
      console.error(
        `✗ ${off.length} test(s) did not run (skipped or todo):\n${off.map((t) => `- ${t}`).join("\n")}\nMake each one run. One that truly can't run everywhere goes in MAY_SKIP in scripts/done-gate/tests-ran.ts, with why; Devesh sees that change.`,
      );
    const gaps = e2e ? [] : coverageProblems(repo, join(dir, "lcov.info"));
    if (gaps.length) console.error(gapsTold(gaps));
    return (r.status ?? 1) || (off.length || gaps.length ? 1 : 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
