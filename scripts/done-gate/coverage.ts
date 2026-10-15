// Every product line a change adds is run by at least one test: each line it adds to a .ts or .tsx file under apps,
// services or packages (tests aside) must be one the gate's own test run ran, by the lcov report that run wrote and
// the line rule in lcov.ts. A file in scope the report doesn't name counts as 0% covered, unless it holds only
// types. Exempt are lines the change keeps: moved ones (the snapshot marks them, moved.ts) and ones whose comment alone it edits
// (comment-edits.ts); and a line marked as a gap (coverage-marks.ts). A new migration needs its database test
// (migration-tests.ts).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeLines, holdsCode } from "./code-lines";
import { uncommented } from "./code-text";
import { commentEdits } from "./comment-edits";
import { type Mark, markOn } from "./coverage-marks";
import type { Added } from "./diff";
import { type Hits, lineRan, parseLcov } from "./lcov";
import { untestedMigrations } from "./migration-tests";
import { isTest } from "./rules";
import { snapshot } from "./snapshot";

/** Does the change keep this added line's code as it was (moved, or only its comment edited)? */
type Keeps = (file: string, line: number) => boolean;

// Declarations (.d.ts) hold nothing that runs; tests are left out by isTest.
const IN_SCOPE = /^(apps|services|packages)\/.+(?<!\.d)\.tsx?$/;
// The browser tests a browser-only mark may name: the console's own, inside the repository.
const CONSOLE_E2E =
  /^apps\/console\/e2e\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.e2e\.tsx?$/;

/** PURE: does this code hold anything that runs? Bun's transpiler drops types, comments and type-only imports. */
const runs = (file: string, code: string) => {
  try {
    return (
      new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" })
        .transformSync(code)
        .trim() !== ""
    );
  } catch {
    return true; // code Bun can't read is judged as code
  }
};

/** PURE: line numbers → "line 4" or "lines 2-3, 7". */
const span = (ns: number[]) => {
  const parts: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (ns[j + 1] === (ns[j] ?? 0) + 1) j++;
    parts.push(j > i ? `${ns[i]}-${ns[j]}` : `${ns[i]}`);
    i = j;
  }
  return `line${ns.length > 1 ? "s" : ""} ${parts.join(", ")}`;
};

/** PURE: why a mark on a line of `file` does not hold, if it doesn't. `exists` says whether a file is in the checkout. */
const unheld = (file: string, mark: Mark, exists: (f: string) => boolean) => {
  if (mark.bad || mark.test === undefined) return mark.bad;
  if (!file.startsWith("apps/console/"))
    return "is marked browser-only, but only console code (apps/console) is left to the browser checks: mark it `// coverage gap: <why>`";
  if (!CONSOLE_E2E.test(mark.test) || !exists(mark.test))
    return `is marked browser-only, but ${mark.test} is not a browser test of the console (a .e2e.ts file under apps/console/e2e) in this checkout`;
};

/**
 * PURE: the change's added lines and the test run's report → each added line in scope no test ran, by file, after
 * each mark that does not hold. A mark excuses its own line, and the line below it when it stands alone on its line
 * (where the formatter keeps a mark in JSX). `read` gives a file as the change leaves it; `exists` says whether a
 * browser test a mark names is in the checkout; `keeps` says which lines' code the change keeps as it was.
 */
export function unrunLines(
  added: Added[],
  hits: Hits,
  io: {
    read: (file: string) => string;
    exists?: (file: string) => boolean;
    keeps?: Keeps;
  },
): string[] {
  const { read, exists = () => false, keeps = () => false } = io;
  const judged = added.filter(
    (a) => IN_SCOPE.test(a.file) && !isTest(a.file) && !keeps(a.file, a.line),
  );
  const problems: string[] = [];
  const excused = new Set<string>(); // "line file"
  for (const a of judged) {
    const mark = markOn(a.text);
    const bad = mark && unheld(a.file, mark, exists);
    if (bad) problems.push(`${a.file}:${a.line} ${bad}`);
    else if (mark) {
      excused.add(`${a.line} ${a.file}`);
      if (!holdsCode(uncommented(a.text)))
        excused.add(`${a.line + 1} ${a.file}`);
    }
  }
  // Per file the report doesn't name: its code line by line, or none when it holds only types.
  const unloaded = new Map<string, string[]>();
  const unrun = new Map<string, number[]>();
  for (const a of judged) {
    if (excused.has(`${a.line} ${a.file}`)) continue;
    const lines = hits.get(a.file);
    if (!lines) {
      if (!unloaded.has(a.file)) {
        const text = read(a.file);
        unloaded.set(a.file, runs(a.file, text) ? codeLines(text) : []);
      }
      if (!holdsCode(unloaded.get(a.file)?.[a.line - 1] ?? "")) continue;
    } else if (!lines.has(a.line) || lineRan(hits, a.file, a.line)) continue;
    unrun.set(a.file, [...(unrun.get(a.file) ?? []), a.line]);
  }
  for (const [file, ns] of unrun)
    problems.push(
      `${file}: ${span(ns)} never ran${hits.has(file) ? "" : " (no test loads this file, so all of it counts as not run)"}`,
    );
  return problems;
}

/**
 * The checkout's change since it left origin/main, against the lcov report (at the path `lcov`) of the test run that
 * just ran in it → every added product line no test ran, every mark that does not hold, and every new migration with
 * no database test.
 */
export function coverageProblems(repo: string, lcov: string): string[] {
  const read = (file: string) => {
    try {
      return readFileSync(join(repo, file), "utf8");
    } catch {
      return "";
    }
  };
  const snap = snapshot(repo);
  const moved = new Set(
    snap.added.filter((a) => a.moved).map((a) => `${a.line} ${a.file}`),
  );
  const edited = commentEdits(snap.added, snap.removed);
  // Bun writes no report when no file but tests loaded: then every file in scope counts as not run.
  const report = existsSync(lcov) ? readFileSync(lcov, "utf8") : "";
  return [
    ...unrunLines(snap.added, parseLcov(report, repo), {
      read,
      exists: (file) => existsSync(join(repo, file)),
      keeps: (file, line) => moved.has(`${line} ${file}`) || edited(file, line),
    }),
    ...untestedMigrations(snap.added, read),
  ];
}

/** PURE: the problems, as `bun run gate tests` tells them. */
export const gapsTold = (problems: string[]) =>
  `✗ Some lines this change adds are run by no test:\n${problems.map((p) => `- ${p}`).join("\n")}\nWrite a test that runs each one (for a new migration, a database test on the local stack that uses what it adds). A deliberate gap, or a line wrongly reported as not run (docs/done-gate.md → Every added line is run by a test lists the shapes the rule gets wrong: a function's first line right after a line no test runs, a line only a child process runs), is marked on its line: \`// coverage gap: <why>\`; console code only the browser checks reach: \`// coverage: browser-only (<its .e2e.ts file under apps/console/e2e>)\`. A mark alone on its line covers the line below it instead, the form to use in JSX: \`{/* coverage: … */}\` on the line above. Devesh sees every mark, and the PR body quotes each: \`Coverage mark: <file> · <what the mark says>\`.`;
