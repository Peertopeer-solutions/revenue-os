// The done rules: what no added line may do (throw as a placeholder, export or re-export what nothing calls, switch
// off a test or a checker, read source code in a test), which tests a change may not remove unexplained
// (removed-tests.ts), which files decide what "done" means, and which are product code.

import { changeMarks, markNote } from "./already-on-main";
import { breakMarkNotes } from "./break-marks";
import { CI, ciJobProblems } from "./ci-jobs";
import { exportsOf, statementAt, uncommented } from "./code-text";
import { markNotes } from "./coverage-marks";
import type { Added } from "./diff";
import { gitAnswer } from "./git";
import { movedNote } from "./moved";
import { entriesOf, removalProblems } from "./removed-tests";
import type { Snap } from "./snapshot";
import { readsCode, SOURCE_PATH } from "./source-reading";

// Where the rules against throwing placeholders and unused exports apply: the apps', services' and packages' source,
// and the database's migrations and seed.
const APP_CODE =
  /^(apps|services|packages)\/[^/]+\/src\/|^supabase\/(migrations|seed)/;
// Not product code: docs/ (docs/removed-tests.md with it), Markdown files, and the gate, CI and hook files, which the
// rule-change explanation judges (rule-changes.ts); test files neither. Every other changed file needs the verifier.
const NOT_PRODUCT = /^(docs|\.github|\.codex|\.claude)\/|^scripts\/done-gate/;
const MARKDOWN = /\.(md|markdown)$/i;
export const TEST =
  /[._](test|spec)\.[cm]?[jt]sx?$|\.e2e\.[cm]?[jt]sx?$|(^|\/)(tests?|e2e|__tests__)\//;
const CODE = /\.[cm]?[jt]sx?$/;

// Rule files: the files that decide what "done" means and how agents work, at any letter case. This is the one
// list; AGENTS.md hard rail 7, .github/CODEOWNERS and STATE.md cite it rather than repeating it, and the CODEOWNERS
// test keeps the two equal. Changing one is allowed: Devesh is told at every stop and in CI's log, and its pull
// request explains it and records it (rule-changes.ts). ROADMAP.md and STATE.md stay out, because every pull
// request changes them. scripts/staging-migrations.ts is in: it decides whether the cloud test database waits for
// `checks`.
export const RULE_FILES =
  /^(\.github\/|\.codex\/|scripts\/(guards(\.sh$|\/)|done-gate|staging-migrations|cycle-hook\.sh$|cycle\.ts$|local-env\.ts$|local-url\.ts$|app-service-login\.ts$)|tests\/(rls_coverage\.sql|setup[^/]*\.ts)$|\.mcp\.json$)|(^|\/)(\.claude\/(settings[^/]*\.json$|agents\/|skills\/|commands\/)|(AGENTS|CLAUDE)\.md$|\.gitleaks(\.toml|ignore)$|\.gitattributes$|package\.json$|bunfig\.toml$|biome\.jsonc?$|tsconfig[^/]*\.json$|playwright\.config\.ts$)/i;
const ALLOW = "done-gate: allow";
// In a test file, a test switched off or singled out: skip/only/todo, their conditional forms (skipIf, runIf,
// todoIf, if), Playwright's fixme and fail, bun's failing, after any modifiers (concurrent, serial, describe),
// called or picked as a value (`cond ? describe : describe.skip`, test["skip"]), and xit/xtest/xdescribe. The
// runner's name is captured, so a line's own variable of that name (`(it) => it.skip`) is left alone. What no
// pattern sees (an alias, a destructured skip) the tests check still catches: see MAY_SKIP.
// In a test, a delete of companies or queued jobs. tests/test-companies.ts does that for every test, deleting only
// what the test made; anything broader (`where slug like 'test-%'`, `where name = 'place_call'`) also deletes the
// companies and jobs of another test run on the shared database, or of the dev login's workspace.
const DELETES_SHARED =
  /\b(?:delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\.)?(?:orgs|pgboss\.\w+)\b|\bdrop\s+schema\s+(?:if\s+exists\s+)?pgboss\b/i;
// In a test, a trigger dropped. On the local stack Supabase's supautils extension (its drop_trigger_grants setting)
// makes every DROP TRIGGER by the postgres login take the strongest lock on all of auth's tables, so it deadlocks
// with a sign-up in another test run going at the same moment. A test installs its trigger once per database and
// leaves it (services/worker/test/scheduler-apply-poison.test.ts).
const DROPS_TRIGGER = /\bdrop\s+trigger\b/i;
// Its policy_grants setting does the same for a policy created, changed or dropped: policies belong in migrations.
const POLICY_DDL = /\b(?:create|alter|drop)\s+policy\b/i;
const SKIP =
  /(?<![\w$.!])(it|test|describe)(?:\s*\.\s*[\w$]+)*?\s*(?:\.\s*|\[\s*["'`])(?:skip|only|todo|skipIf|runIf|todoIf|if|fixme|fail|failing)\b|\bx(?:it|test|describe)\b/g;

/** A `done-gate: allow` exception: the line it marks and the reason written after it. */
export type Exception = { file: string; line: number; why: string };

/**
 * PURE: the change's added and removed lines (and the files it deletes) → problems that block a stop, notes Devesh
 * should see, and the exceptions the PR body must show (pr-quotes.ts). `usersOf(name, file)` lists the files that use
 * an export: other files, plus `file` itself when the name is used there beyond its declaration.
 */
export function checkRules(
  files: string[],
  added: Added[],
  usersOf: (name: string, file: string) => string[],
  removed: Added[] = [],
  deleted: string[] = [],
): { problems: string[]; notes: string[]; exceptions: Exception[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const exceptions: Exception[] = [];
  // A placeholder passes only when a Stub row the change adds or edits names its own file (by path, or by file
  // name alone), so rewording an unrelated Stub row lets nothing through.
  const stubRows = added
    .filter((a) => a.file === "STATE.md" && /\|\s*Stub\s*\|/.test(a.text))
    .map((a) => a.text);
  const stubListed = (file: string) => {
    const name = file.split("/").pop() ?? file;
    return stubRows.some(
      (row) =>
        row.includes(file) ||
        row.split(/[\s|`(),;:]+/).some((word) => word === name),
    );
  };
  // A test that reads files AND names a source path (outside its imports) is reading code as text.
  const readsSource = new Set(
    added
      .filter(
        (a) =>
          TEST.test(a.file) &&
          SOURCE_PATH.test(a.text) &&
          !/^\s*(import|export)\b|\bfrom\s+["'`]|\b(require|import)\s*\(|mock\.module\s*\(/.test(
            a.text,
          ),
      )
      .map((a) => a.file),
  );
  for (const [i, a] of added.entries()) {
    if (!CODE.test(a.file) || a.file.startsWith("scripts/done-gate")) continue; // this file quotes what it bans
    const explained = a.text.match(
      /(?:biome-ignore\S*|@ts-expect-error)\s*:?\s*(.*)$/,
    );
    if (explained)
      notes.push(
        `checker silenced at ${a.file}:${a.line}: ${explained[1] || "(no reason given)"}`,
      );
    const stmt = statementAt(added, i);
    const problem = lineProblem(
      a,
      stmt.code,
      stubListed,
      readsCode(added, i, readsSource.has(a.file)),
      usersOf,
    );
    if (!problem) continue;
    // The reason after the marker, on any line of the statement (the formatter may move it past a wrapped
    // throw); a ")" it didn't open closed "(done-gate: allow …)" around it.
    const raw = (stmt.lines.find((l) => l.includes(ALLOW)) ?? a.text)
      .split(ALLOW)[1]
      ?.replace(/\*\/\s*$/, "")
      .trim();
    const why =
      raw && raw.split(")").length > raw.split("(").length
        ? raw.slice(0, raw.lastIndexOf(")")).trim()
        : raw;
    if (why === undefined) problems.push(`${a.file}:${a.line} ${problem}`);
    else if (!/[\p{L}\p{N}]/u.test(why))
      problems.push(
        `${a.file}:${a.line} ${problem}, and its \`${ALLOW}\` gives no reason: write why after it, on the same line`,
      );
    else {
      exceptions.push({ file: a.file, line: a.line, why });
      notes.push(`exception at ${a.file}:${a.line} (${why})`);
    }
  }
  const entries = entriesOf(added);
  problems.push(
    ...removalProblems(
      added,
      removed,
      deleted,
      entries,
      (f) => CODE.test(f) && TEST.test(f),
    ),
  );
  notes.push(...entries.map((e) => `removed test: ${e}`));
  const moved = movedNote(files, added, removed);
  if (moved) notes.push(moved);
  notes.push(...markNotes(added)); // each line no test runs on purpose, which Devesh sees
  notes.push(...breakMarkNotes(added)); // each guarded line whose break no test notices, on purpose
  const rules = files.filter((f) => RULE_FILES.test(f));
  if (rules.length)
    notes.push(`changed what "done" means: ${rules.join(", ")}`);
  return { problems, notes, exceptions };
}

function lineProblem(
  { file, text }: Added,
  stmt: string,
  stubListed: (file: string) => boolean,
  readsCodeAsText: boolean,
  usersOf: (name: string, file: string) => string[],
) {
  if (/@ts-(ignore|nocheck)\b/.test(text))
    return "switches the type checker off without a reason; fix the cause instead";
  if (TEST.test(file) && skips(text))
    return "skips or singles out a test; every test must run";
  if (
    TEST.test(file) &&
    file !== "tests/test-companies.ts" &&
    DELETES_SHARED.test(stmt) &&
    !/\bpgboss\.\w+\s+where\s+id\s*=\s*\$\d/i.test(stmt)
  )
    return "deletes companies or queued jobs other than through tests/test-companies.ts, which deletes only what this test made; a broader delete removes another test run's (delete a job only by its id)";
  if (TEST.test(file) && DROPS_TRIGGER.test(stmt))
    return "drops a trigger, which on the local stack locks every auth table and deadlocks another test run's sign-ups; install a test's trigger once per database and leave it (as services/worker/test/scheduler-apply-poison.test.ts does)";
  if (TEST.test(file) && POLICY_DDL.test(stmt))
    return "creates, changes or drops a policy, which on the local stack locks every auth table and deadlocks another test run's sign-ups; policies belong in a migration";
  if (TEST.test(file))
    return readsCodeAsText
      ? "reads source code as text; test what the code does (render it, call it, drive it), not what it says"
      : undefined;
  if (!APP_CODE.test(file)) return;
  if (
    !stubListed(file) &&
    /\bthrow\b.*\b(not (yet )?(implemented|wired)|unimplemented|stub)\b|\bnot(Wired|Implemented)\s*\(|\bthrow\s+(new\s+)?NotImplemented\w*/i.test(
      stmt,
    )
  )
    return `adds a placeholder that throws; build the real thing, or list it as Stub in STATE.md → What works today in this same change, naming its file (${file})`;
  const name = exportsOf(stmt).find(
    (n) => !usersOf(n, file).some((f) => !TEST.test(f)),
  );
  if (name?.startsWith("* from "))
    return `passes on everything ${name.slice(7)} exports, but nothing outside tests imports any of it through this file; land it together with the code that calls it`;
  if (name)
    return `exports ${name === "default" ? "a default" : name}, but nothing outside tests uses it; land it together with the code that calls it`;
}

/** PURE: does this added line switch a test off? A line that starts with "*" is inside a comment, up to its end. */
const skips = (line: string) => {
  const code = uncommented(line.replace(/^\s*(?=\*).*?(?:\*\/|$)/, ""));
  return [...code.matchAll(SKIP)].some(
    ([, runner]) =>
      !runner ||
      !new RegExp(
        `\\b(?:const|let|var)\\s+${runner}\\b|\\b${runner}\\s*\\)?\\s*=>`,
      ).test(code),
  );
};

/** Is this changed file product code, which needs the verifier's PASS? Every file is, but those NOT_PRODUCT names. */
export const isProduct = (f: string) =>
  f !== "" && !NOT_PRODUCT.test(f) && !MARKDOWN.test(f) && !TEST.test(f);
export const isTest = (f: string) => TEST.test(f);

export const rulesOn = (snap: Snap) => {
  const r = checkRules(
    snap.files,
    snap.added,
    (name, file) => snap.users.get(`${file} ${name}`) ?? [],
    snap.removed,
    snap.deleted,
  );
  r.notes.push(...changeMarks(snap).map(markNote)); // tests that pass on main, and why (tests-proven.ts)
  const ci =
    snap.files.includes(CI) &&
    gitAnswer(snap.repo, ["cat-file", "blob", `${snap.tree}:${CI}`]);
  if (ci && ci.status === 0) r.problems.push(...ciJobProblems(ci.stdout));
  return r;
};
export const listed = (problems: string[]) =>
  `${problems.map((p) => `- ${p}`).join("\n")}\nFix each one. For a deliberate exception, add \`${ALLOW} <why>\` to that line, or, for a removed test, the line given above to docs/removed-tests.md; Devesh sees every exception.`;
