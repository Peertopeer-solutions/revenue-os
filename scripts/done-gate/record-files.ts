// The record files: one decision in force per file in docs/decisions-in-force/, one rule-change record per file in
// docs/rule-changes/, each folder's README aside, so two pull requests that each add one never edit the same lines.
// `bun run gate pr` (rules-from-main) refuses a file the change leaves badly named or badly written, and
// `bun run records` (scripts/records.ts) prints them for the tracker page. STATE.md's two sections of the same names
// only point at the folders; the tracker's reader (docs/tracker/parse.js) names a line written there.

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

/**
 * PURE: record files' paths and texts → each well-written one whose line an earlier-named file of the same folder
 * holds word for word, which `bun run records`, and so the tracker page, would list twice. `counts` picks the files
 * whose repeats are named (those a pull request writes); a record moved word for word leaves one file holding it.
 */
export function repeatedRecords(
  texts: [path: string, text: string][],
  counts = (_path: string) => true,
) {
  const holders = new Map<string, string[]>();
  for (const [path, text] of texts) {
    const r = readRecord(path, text);
    if (!("line" in r)) continue;
    // The folder leads the key: the same line in both folders is listed once in each section.
    const key = `${path.slice(0, path.lastIndexOf("/"))}\n${r.line}`;
    holders.set(key, [...(holders.get(key) ?? []), path]);
  }
  return [...holders.values()].flatMap((paths) => {
    const [first = "", ...rest] = paths.sort();
    return rest
      .filter((p) => counts(p) || counts(first))
      .map(
        (p) =>
          `${p} holds the line of ${first} word for word, so the tracker page would list it twice: keep it in one file`,
      );
  });
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
