// The record files: one decision in force per file in docs/decisions-in-force/, one rule-change record per file in
// docs/rule-changes/, each folder's README aside, so two pull requests that each add one never edit the same lines.
// `bun run gate pr` (rules-from-main) refuses a file the change leaves badly named or badly written, and
// `bun run records` (scripts/records.ts) prints them for the tracker page.

import { RECORDED, RECORDS } from "./rule-changes";

export const DECISIONS = "docs/decisions-in-force/";
const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SHAPES: [string, RegExp, string][] = [
  [DECISIONS, /^- \S/, "`- <the decision>`"],
  [
    RECORDS,
    RECORDED,
    "`- YYYY-MM-DD · [#N](link) · <rule> · tighter | looser | neutral | mixed`",
  ],
];

/** PURE: a record file's path and text → its one line without the "- ", or what is wrong with it. */
export function readRecord(
  path: string,
  text: string,
): { line: string } | { problem: string } {
  const [dir, shape, how] = SHAPES.find(([d]) => path.startsWith(d)) ?? [];
  const name = path.slice((dir ?? "").length);
  if (!dir || !shape || name.includes("/"))
    return {
      problem: `${path}: a record is a file directly in ${DECISIONS} or ${RECORDS}`,
    };
  if (!NAME.test(name))
    return { problem: `${path}: name it YYYY-MM-DD-<what>.md, in lower case` };
  const lines = text.trim().split(/\r?\n/);
  const line = lines[0] ?? "";
  return lines.length === 1 && shape.test(line)
    ? { line: line.slice(2) }
    : { problem: `${path}: hold one line, ${how}` };
}

/** PURE: the change's files and a reader of the files as it leaves them → each record file it leaves badly written. */
export const recordFileProblems = (
  files: string[],
  read: (path: string) => string | undefined,
) =>
  files.flatMap((f) => {
    if (!SHAPES.some(([d]) => f.startsWith(d) && f !== `${d}README.md`))
      return [];
    const text = read(f);
    if (text === undefined) return [];
    const r = readRecord(f, text);
    return "problem" in r ? [r.problem] : [];
  });

/**
 * PURE: the lines a change adds and STATE.md as it leaves it → a decision line added to STATE.md → Decisions in
 * force, which now only points at docs/decisions-in-force/: a decision written there is shared lines again, and
 * neither `bun run records` nor the tracker page would show it.
 */
export function stateDecisionProblems(
  added: { file: string; line: number; text: string }[],
  state: string,
) {
  const lines = state.split("\n");
  const from = lines.indexOf("## Decisions in force") + 1; // its line number; 0 when the heading is missing
  const to = lines.findIndex((l, i) => i >= from && /^## /.test(l));
  return added
    .filter(
      (a) =>
        from > 0 &&
        a.file === "STATE.md" &&
        a.line > from &&
        (to < 0 || a.line <= to) &&
        a.text.startsWith("- "),
    )
    .map(
      (a) =>
        `STATE.md → Decisions in force: "${a.text}" is a decision line; write it as a file of its own in ${DECISIONS} (its README says how)`,
    );
}
