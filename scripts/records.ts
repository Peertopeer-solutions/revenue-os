// `bun run records` — every decision in force (docs/decisions-in-force/) and every rule change (docs/rule-changes/,
// then the older ones STATE.md → Rule changes keeps), newest first, printed as the records.md the tracker page reads
// (AGENTS.md → The loop, step 6). One file per record, so two pull requests that each add one never edit the same
// lines. `bun run cycle --check` reports a record file that is not written as its folder's README says.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseState } from "../docs/tracker/parse.js";
import { RECORDED, RECORDS } from "./done-gate/rule-changes";

export const DECISIONS = "docs/decisions-in-force/";
const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** The record files of `dir` under `root`, newest first by their dated names → each one's line, and what is wrong. */
function folder(root: string, dir: string, shape: RegExp, how: string) {
  const lines: string[] = [];
  const problems: string[] = [];
  const files = readdirSync(join(root, dir))
    .filter((f) => f !== "README.md")
    .sort()
    .reverse();
  for (const f of files) {
    const text = readFileSync(join(root, dir, f), "utf8")
      .trim()
      .split(/\r?\n/);
    if (!NAME.test(f))
      problems.push(`${dir}${f}: name it YYYY-MM-DD-<what>.md, in lower case`);
    else if (text.length !== 1 || !shape.test(text[0] ?? ""))
      problems.push(`${dir}${f}: hold one line, ${how}`);
    else lines.push((text[0] ?? "").slice(2));
  }
  return { lines, problems };
}

/** PURE apart from reading the files: the checkout at `root` → its decisions and rule changes, and what is wrong. */
export function records(root: string) {
  const d = folder(root, DECISIONS, /^- \S/, "`- <the decision>`");
  const r = folder(
    root,
    RECORDS,
    RECORDED,
    "`- YYYY-MM-DD · [#N](link) · <rule> · tighter | looser | neutral | mixed`",
  );
  const older = parseState(readFileSync(join(root, "STATE.md"), "utf8"));
  return {
    decisions: d.lines,
    ruleChanges: [...new Set([...r.lines, ...older.ruleChanges])],
    problems: [...d.problems, ...r.problems],
  };
}

/** The records as the Markdown file the tracker page reads with parseRecords (docs/tracker/parse.js). */
export const markdown = (r: ReturnType<typeof records>) =>
  [
    "## Decisions in force",
    ...r.decisions.map((l) => `- ${l}`),
    "",
    "## Rule changes",
    ...r.ruleChanges.map((l) => `- ${l}`),
    "",
  ].join("\n");

if (import.meta.main) {
  const r = records(join(import.meta.dir, ".."));
  for (const p of r.problems) console.error(p);
  if (r.problems.length) process.exit(1);
  process.stdout.write(markdown(r));
}
