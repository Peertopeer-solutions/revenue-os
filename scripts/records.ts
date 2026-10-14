// `bun run records` — every decision in force (docs/decisions-in-force/) and every rule change (docs/rule-changes/,
// then the older ones STATE.md → Rule changes keeps), newest first, printed as the records.md the tracker page reads
// (AGENTS.md → The loop, step 6). One file per record, so two pull requests that each add one never edit the same
// lines. A file not written as its folder's README says is named, here, by `bun run cycle --check` and by
// `bun run gate pr` (scripts/done-gate/record-files.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseState } from "../docs/tracker/parse.js";
import { DECISIONS, readRecord } from "./done-gate/record-files";
import { RECORDS } from "./done-gate/rule-changes";

/** The record files of `dir` under `root`, newest first by their dated names → each one's line, and what is wrong. */
function folder(root: string, dir: string) {
  const lines: string[] = [];
  const problems: string[] = [];
  if (!existsSync(join(root, dir)))
    return { lines, problems: [`${dir} is missing: it holds the records`] };
  const entries = readdirSync(join(root, dir), { withFileTypes: true })
    // The README, and a hidden file a computer leaves behind (.DS_Store), which git never commits.
    .filter((e) => e.name !== "README.md" && !e.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  for (const e of entries) {
    if (!e.isFile()) {
      problems.push(`${dir}${e.name}: a record is a file, not a folder`);
      continue;
    }
    const r = readRecord(
      `${dir}${e.name}`,
      readFileSync(join(root, dir, e.name), "utf8"),
    );
    if ("line" in r) lines.push(r.line);
    else problems.push(r.problem);
  }
  return { lines, problems };
}

/** PURE apart from reading the files: the checkout at `root` → its decisions and rule changes, and what is wrong. */
export function records(root: string) {
  const d = folder(root, DECISIONS);
  const r = folder(root, RECORDS);
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
