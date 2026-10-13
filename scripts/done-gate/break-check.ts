// The break check: for guardrail, tenancy and money code (broken-lines.ts), each line a change adds is broken on
// purpose, a condition on it flipped and the statement it starts removed, and at least one test must then fail (an
// assertion failing, or the test throwing). It runs in one scratch copy of the change (code-copy.ts): the test files
// that can reach a broken file by their imports each run once with coverage, to learn which run which line, and each
// broken copy then runs only the files that ran its line, stopping at the first that fails. Left out are the lines the
// coverage check leaves out (moved ones, ones whose comment alone changed, ones holding no code), a line no test runs
// (the coverage check's to report), and a line marked `// break-check gap: <why>` (break-marks.ts). The check has its
// own time limit, so the gate's stop never runs past its hook's; when it runs out, it names the lines not yet broken.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { breakMarkOn, saysWhy } from "./break-marks";
import { breaksOf, kindOf } from "./broken-lines";
import { codeCopy } from "./code-copy";
import { codeLines, holdsCode } from "./code-lines";
import { uncommented } from "./code-text";
import { commentEdits } from "./comment-edits";
import { git } from "./git";
import { type Hits, lineRan } from "./lcov";
import type { Snap } from "./snapshot";
import { isTestFile, runTestFile } from "./test-run";

/** The check's whole time limit, and one test file's on a broken copy (a break that hangs a test counts as caught). */
export const BUDGET_MS = 15 * 60_000;
const BROKEN_RUN_MS = 3 * 60_000;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** PURE: the modules a file's code imports or re-exports, as written. */
const importsIn = (text: string) =>
  [
    ...uncommented(text).matchAll(
      /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
    ),
  ].map((m) => m[1] ?? "");

/** The test files under `dir` that can reach any of `targets` through their imports, as a file of the repo. */
function testsReaching(dir: string, tests: string[], targets: Set<string>) {
  const edges = new Map<string, string[]>();
  const importsOf = (f: string) => {
    const known = edges.get(f);
    if (known) return known;
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {}
    const found = importsIn(text).flatMap((spec) => {
      if (/^(bun|node):/.test(spec)) return [];
      try {
        const to = relative(dir, Bun.resolveSync(spec, join(dir, dirname(f))));
        return to.startsWith("..") || to.includes("node_modules") ? [] : [to];
      } catch {
        return [];
      }
    });
    edges.set(f, found);
    return found;
  };
  return tests.filter((t) => {
    const seen = new Set([t]);
    for (const f of seen) {
      if (targets.has(f)) return true;
      for (const g of importsOf(f)) seen.add(g);
    }
    return false;
  });
}

type Line = { file: string; line: number; text: string };

/**
 * Breaks each new line of guarded code in a copy of the change and runs the tests that run it. Text for Devesh, its
 * first line the summary the gate shows, and whether every break was caught in time.
 */
export function breakCheck(
  repo: string,
  snap: Snap,
  budgetMs = BUDGET_MS,
): { ok: boolean; text: string } {
  const started = Date.now();
  const texts = new Map<string, string>();
  const read = (f: string) => {
    if (!texts.has(f))
      texts.set(
        f,
        existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : "",
      );
    return texts.get(f) ?? "";
  };
  const edited = commentEdits(snap.added, snap.removed);
  const lines: Line[] = snap.added.filter(
    (a) =>
      kindOf(a.file) &&
      !a.moved &&
      !edited(a.file, a.line) &&
      holdsCode(codeLines(read(a.file))[a.line - 1] ?? ""),
  );
  if (!lines.length)
    return {
      ok: true,
      text: "Break check ✓ no new line in guardrail, tenancy or money code, so nothing to break",
    };
  const problems: string[] = [];
  const notes: string[] = [];
  const judged = lines.filter(({ file, line, text }) => {
    const above = read(file).split("\n")[line - 2] ?? "";
    const why =
      breakMarkOn(text) ??
      (holdsCode(codeLines(above)[0] ?? "") ? undefined : breakMarkOn(above));
    if (why === undefined) return true;
    if (saysWhy(why)) notes.push(`break-check mark at ${file}:${line}: ${why}`);
    else
      problems.push(
        `${file}:${line} has a break-check mark without a reason: write \`// break-check gap: <why>\``,
      );
    return false;
  });
  const files = [...new Set(judged.map((l) => l.file))];
  const late = () => Date.now() - started > budgetMs;
  /** What is left of the budget, at least a second: no test run may outlast it. */
  const left = () => Math.max(1000, budgetMs - (Date.now() - started));
  let copy: string | undefined;
  let runs = 0;
  let broken = 0;
  const caughtLines = new Set<string>();
  const unbroken: string[] = [];
  try {
    try {
      copy = codeCopy(repo, snap.from, snap.files);
    } catch (e) {
      return refused([
        `the change could not be copied to break its lines in: ${(e as Error).message}`,
      ]);
    }
    const dir = copy;
    const tests = [
      ...new Set([
        ...git(dir, ["ls-files"]).split("\n"),
        ...snap.files.filter((f) => existsSync(join(dir, f))),
      ]),
    ].filter((f) => isTestFile(f) && !f.startsWith("scripts/"));
    const hits = new Map<string, Hits>();
    for (const t of testsReaching(dir, tests, new Set(files))) {
      if (late()) {
        // Which test runs which line is not known yet, so no line can be judged.
        unbroken.push(...judged.map((l) => `${l.file}:${l.line}`));
        judged.length = 0;
        break;
      }
      const run = runTestFile(dir, t, { coverage: true, ms: left() });
      runs++;
      // A file that fails alone would leave the lines it runs unbroken, so it fails the break check: the whole-suite
      // run comes after this check, and in CI in a job of its own, and a file may pass there only on what another
      // test left behind.
      if (run.finished && run.status === 0) hits.set(t, run.hits);
      else
        problems.push(
          `${t} ${run.finished ? "fails" : "doesn't finish"} when run alone on the change, so it can't show whether a broken line is caught: make it pass alone (it may rely on data another test left behind)`,
        );
    }
    for (const { file, line } of judged) {
      const at = `${file}:${line}`;
      const runners = [...hits]
        .filter(([, h]) => lineRan(h, file, line))
        .map(([t]) => t);
      if (!runners.length) {
        notes.push(
          `${at} is run by no test, so it wasn't broken (the coverage check reports a line no test runs)`,
        );
        continue;
      }
      const original = readFileSync(join(dir, file), "utf8");
      const breaks = breaksOf(original, line, file.endsWith(".tsx"));
      if (!breaks.length) notes.push(`${at} holds nothing to flip or remove`);
      for (const b of breaks) {
        if (late()) {
          unbroken.push(`${at} (${b.how})`);
          continue;
        }
        writeFileSync(join(dir, file), b.text);
        // A run stopped by its own limit hung on the break: caught. One stopped because the budget ran out: not judged.
        let verdict: "caught" | "missed" | "late" = "missed";
        try {
          for (const t of runners) {
            const ms = Math.min(BROKEN_RUN_MS, left());
            const run = runTestFile(dir, t, { ms });
            runs++;
            if (!run.finished && ms < BROKEN_RUN_MS) verdict = "late";
            else if (!run.finished || run.status !== 0) verdict = "caught";
            if (verdict !== "missed") break;
          }
        } finally {
          writeFileSync(join(dir, file), original);
        }
        if (verdict === "late") {
          unbroken.push(`${at} (${b.how})`);
          continue;
        }
        broken++;
        if (verdict === "caught") caughtLines.add(at);
        else
          problems.push(
            `${at} (${kindOf(file)}) ${b.how === "flip" ? "with a condition flipped" : "with its statement removed"}, \`${b.shown}\`, and every test that runs it still passed: ${runners.join(", ")}`,
          );
      }
    }
  } finally {
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
  const took = `${broken} break(s), ${runs} test file run(s), ${secs(Date.now() - started)}`;
  const told = notes.map((n) => `\n⚠ ${n}`).join("");
  if (unbroken.length)
    problems.push(
      `the break check's time limit of ${budgetMs / 60_000} min ran out after ${broken} break(s): not yet broken: ${unbroken.join(", ")}. Make the tests that run these lines faster, or split the change`,
    );
  if (problems.length) return refused(problems, `${told}\n(${took})`);
  return {
    ok: true,
    text: `Break check ✓ ${caughtLines.size} line(s) broken in guardrail, tenancy and money code, each caught (${took})${told}`,
  };
}

const refused = (problems: string[], after = "") => ({
  ok: false,
  text: `Break check ✗ ${problems.length} problem(s) breaking new lines of guardrail, tenancy and money code on purpose:\n${problems.map((p) => `- ${p}`).join("\n")}\nWrite a test that fails when the line is broken. A deliberate gap is marked at the end of the line or alone on the comment line above it, \`// break-check gap: <why>\`; Devesh sees every mark, and the PR body quotes each: \`Break-check mark: <file> · <why>\`.${after}`,
});
