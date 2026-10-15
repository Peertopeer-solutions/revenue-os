// What main's copy of the rules judges about a pull request (`bun run gate pr`, which rules-from-main runs on
// every pull request with --head): the body's first line, the done rules, each rule change explained and recorded,
// each fix-when-touched entry it touches answered, each `done-gate: allow` exception and removed test shown in the
// body (pr-quotes.ts), each coverage mark the change adds quoted in the body (pr-coverage-marks.ts), no other
// workflow able to report a check named rules-from-main or checks (the two main's ruleset requires), no migration
// on main changed or its number reused (migrations.ts), and each slice it sets to done proved by a passing proof run
// on main, whose report its body carries (proof-link.ts). Each test the change marks as checking behaviour main
// already has is copied into the body (already-on-main.ts). A change to STATE.md adds no format problem the
// tracker's reader names (a Where / why cell over its length, a record or decision line in STATE.md), and no record
// file it writes holds a line a second file of its folder holds word for word (record-files.ts).

import { parseState } from "../../docs/tracker/parse.js";
import { changeMarks, markBodyProblems } from "./already-on-main";
import { fixWhenTouchedProblems, TABLE, unreadTable } from "./fix-when-touched";
import { git, gitAnswer } from "./git";
import { migrationProblems } from "./migrations";
import { unquotedBreakMarks } from "./pr-break-marks";
import { unquotedMarks } from "./pr-coverage-marks";
import { firstLineProblems } from "./pr-first-line";
import { quoteProblems } from "./pr-quotes";
import { proofLinks } from "./proof-link";
import { DECISIONS, recordFileProblems, repeatedRecords } from "./record-files";
import { entriesOf } from "./removed-tests";
import { RECORDS, ruleChangeProblems, shown } from "./rule-changes";
import { rulesOn } from "./rules";
import { GREP, type Snap } from "./snapshot";

const WORKFLOWS = ".github/workflows/";
const OURS = `${WORKFLOWS}rules-from-main.yml`;
const NAME = "rules-from-main";
const CI = `${WORKFLOWS}ci.yml`; // its job `checks` is the only one that may report a check named checks
type Job = { name?: unknown; permissions?: unknown };

/** Can a job's token write checks or statuses? `write-all`, either scope at write, or no permissions anywhere. */
const writesChecks = (permissions: unknown) =>
  permissions === undefined ||
  permissions === "write-all" ||
  (typeof permissions === "object" &&
    permissions !== null &&
    ["checks", "statuses"].some(
      (k) => (permissions as Record<string, unknown>)[k] === "write",
    ));

/**
 * PURE: the pull request's workflow files → problems when any besides ours could report a check named
 * rules-from-main, which main's ruleset requires: a job of that id or name (read as YAML, so quoting, anchors and
 * folded text change nothing), a job whose name is an expression, which can't be read until it runs, or a job whose
 * token can write checks or statuses. Ours must hold exactly one job, of that id. Likewise for `checks`, the other
 * required check, which scripts/staging-migrations.ts also trusts: only ci.yml's job `checks` may carry that name.
 */
export function secondCheck(workflows: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, text] of Object.entries(workflows)) {
    try {
      const doc = Bun.YAML.parse(text) as {
        jobs?: Record<string, Job>;
        permissions?: unknown;
      } | null;
      const jobs = doc?.jobs ?? {};
      if (file !== OURS)
        for (const [id, job] of Object.entries(jobs)) {
          const name = String(job?.name ?? id);
          const named = (check: string) =>
            [id, name].some((n) => n.toLowerCase() === check);
          if (named(NAME) || /\$\{\{/.test(name))
            problems.push(
              `${file}, job ${id}: its check could be named ${NAME}, the name only ${OURS} may report (a job's name must be plain text)`,
            );
          if (
            named("checks") &&
            !(file === CI && id === "checks" && name === id)
          )
            problems.push(
              `${file}, job ${id}: its check could be named checks, the name only ${CI}'s job checks may report`,
            );
          if (writesChecks(job?.permissions ?? doc?.permissions))
            problems.push(
              `${file}, job ${id}: its token could write checks or statuses, and so report a check named ${NAME}; give it permissions without checks or statuses write`,
            );
        }
      else if (
        Object.keys(jobs).join() !== NAME ||
        String(jobs[NAME]?.name ?? NAME) !== NAME // a name of its own would report as that name instead
      )
        problems.push(`${OURS} must hold exactly one job, ${NAME}`);
    } catch (e) {
      problems.push(
        `${file} can't be read as YAML (${String(e).split("\n")[0]}), so its checks can't be judged`,
      );
    }
  }
  return problems;
}

/**
 * Each line that a record file among `files` shares word for word with a second file of its folder in `tree`
 * (record-files.ts). Every record file is read whole by one `git grep` of every line, `<tree>:<path>\0<line>`: one git
 * call per file took seconds for some 350 of them. A grep that fails is named, never taken for "no records".
 */
export function repeatProblems(repo: string, tree: string, files: string[]) {
  const r = gitAnswer(repo, [
    ...GREP,
    "-I",
    "-e",
    "",
    tree,
    "--",
    DECISIONS,
    RECORDS,
  ]);
  if (r.status !== 0 && r.status !== 1)
    // 1: no line matched, as when the folders hold no file
    return [
      `the record files could not be read (git grep: ${r.stderr.trim() || `ended by ${r.signal}`}), so a line two of them hold can't be ruled out`,
    ];
  const texts = new Map<string, string>();
  for (const l of r.stdout.split("\n")) {
    const end = l.indexOf("\0");
    if (end < 0) continue;
    const f = l.slice(tree.length + 1, end);
    texts.set(f, `${texts.get(f) ?? ""}${l.slice(end + 1)}\n`);
  }
  return repeatedRecords([...texts], (f) => files.includes(f));
}

/** The snapshot's code, read from git: a file the change leaves (empty when it has none). */
const at = (snap: Snap, file: string) =>
  git(snap.repo, ["cat-file", "blob", `${snap.tree}:${file}`], {}, true);

/** `base` is main: its fix-when-touched table judges, never the branch's, and its ROADMAP.md says what is finished. */
export async function judgePr(
  snap: Snap,
  body: string,
  pr?: string,
  base = "origin/main",
) {
  const { problems, notes, exceptions } = rulesOn(snap);
  const onBase = (file: string) =>
    git(snap.repo, ["cat-file", "blob", `${base}:${file}`], {}, true);
  const table = onBase(TABLE);
  // Does the change leave `file` in place (a file it deletes is not read as an empty one)? Names are read with -z, as
  // git writes them, so one with a non-ASCII letter is not quoted and missed.
  const left = (file: string) =>
    git(
      snap.repo,
      ["ls-tree", "-z", "--name-only", snap.tree, "--", file],
      {},
      true,
    )
      .split("\0")
      .includes(file);
  // The format problems a change to STATE.md adds: one main already has is not this change's to fix.
  const stateProblems = () => {
    const had = new Set(parseState(onBase("STATE.md")).problems);
    return parseState(at(snap, "STATE.md")).problems.filter((p) => !had.has(p));
  };
  const workflows = Object.fromEntries(
    git(
      snap.repo,
      ["ls-tree", "-r", "-z", "--name-only", snap.tree, "--", WORKFLOWS],
      {},
      true,
    )
      .split("\0")
      .filter((f) => /\.ya?ml$/i.test(f))
      .map((f) => [f, at(snap, f)]),
  );
  return {
    problems: [
      ...firstLineProblems(
        body,
        at(snap, "ROADMAP.md"),
        onBase("ROADMAP.md"),
        snap.files.includes("ROADMAP.md"),
      ),
      ...problems,
      ...ruleChangeProblems(snap.files, snap.added, body, pr, snap.removed),
      ...recordFileProblems(snap.files, (f) =>
        left(f) ? at(snap, f) : undefined,
      ),
      ...repeatProblems(snap.repo, snap.tree, snap.files),
      ...(snap.files.includes("STATE.md") ? stateProblems() : []),
      ...fixWhenTouchedProblems(snap.files, body, table),
      ...quoteProblems(exceptions, entriesOf(snap.added), body),
      ...secondCheck(workflows),
      ...migrationProblems(snap),
      ...unquotedMarks(snap.added, body),
      ...unquotedBreakMarks(snap.added, body),
      ...markBodyProblems(changeMarks(snap), shown(body)), // each "behaviour already on main" mark, copied into the body
      ...(await proofLinks(
        snap.repo,
        at(snap, "ROADMAP.md"),
        onBase("ROADMAP.md"),
        body,
        base,
      )),
    ],
    notes: [...notes, ...unreadTable(table)],
  };
}
