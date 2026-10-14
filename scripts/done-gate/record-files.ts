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
    const text = read(f);
    if (text === undefined || !SHAPES.some(([d]) => f.startsWith(d))) return [];
    if (SHAPES.some(([d]) => f === `${d}README.md`)) return [];
    const r = readRecord(f, text);
    return "problem" in r ? [r.problem] : [];
  });
