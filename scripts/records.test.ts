// The decisions in force and rule changes are one file each (scripts/records.ts), so two pull requests that each add
// one merge with no conflict, and the tracker page still lists every record, newest first.
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRecords } from "../docs/tracker/parse.js";
import { markdown, records } from "./records";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "records-"));
  dirs.push(d);
  return d;
};
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const git = (dir: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
const rule = (pr: number, what: string, day = "2026-10-14") =>
  `- ${day} · [#${pr}](https://github.com/Peertopeer-solutions/revenue-os/pull/${pr}) · ${what} · tighter`;
const STATE = (...older: string[]) =>
  [
    "PHASE: SETUP",
    "",
    "## Decisions in force",
    "",
    "One file per decision, in docs/decisions-in-force/.",
    "",
    "## Rule changes",
    "",
    "The records written before 2026-10-14.",
    "",
    ...older,
    "",
  ].join("\n");

describe("one file per record", () => {
  it("two branches off the same main that each add a decision and a rule-change record merge with no conflict, and both are listed", () => {
    const dir = scratch();
    git(dir, "init", "-q", "-b", "main");
    write(dir, "STATE.md", STATE(rule(100, "AGENTS.md", "2026-10-01")));
    write(dir, "docs/decisions-in-force/README.md", "# Decisions in force\n");
    write(dir, "docs/rule-changes/README.md", "# Rule changes\n");
    write(
      dir,
      "docs/decisions-in-force/2026-10-01-old.md",
      "- 2026-10-01 · **An old decision** (Devesh): kept.\n",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "main");
    for (const [branch, pr] of [
      ["a", 201],
      ["b", 202],
    ] as const) {
      git(dir, "checkout", "-qb", branch, "main");
      write(
        dir,
        `docs/decisions-in-force/2026-10-14-decision-of-${branch}.md`,
        `- 2026-10-14 · **Decision ${branch}** (Devesh): made in #${pr}.\n`,
      );
      write(
        dir,
        `docs/rule-changes/2026-10-14-pr-${pr}-biome.md`,
        `${rule(pr, `biome.json (${branch})`)}\n`,
      );
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", branch);
    }
    git(dir, "checkout", "-q", "main");
    const a = git(dir, "merge", "-q", "--no-edit", "a");
    const b = git(dir, "merge", "-q", "--no-edit", "b");
    expect([a.status, b.status, a.stderr + b.stderr]).toEqual([0, 0, ""]);
    expect(records(dir)).toEqual({
      decisions: [
        "2026-10-14 · **Decision b** (Devesh): made in #202.",
        "2026-10-14 · **Decision a** (Devesh): made in #201.",
        "2026-10-01 · **An old decision** (Devesh): kept.",
      ],
      ruleChanges: [
        rule(202, "biome.json (b)").slice(2),
        rule(201, "biome.json (a)").slice(2),
        rule(100, "AGENTS.md", "2026-10-01").slice(2),
      ],
      problems: [],
    });

    // The same two records written the old way, the decision and the rule change each at the top of its list in
    // STATE.md, conflict.
    for (const [branch, pr] of [
      ["c", 301],
      ["d", 302],
    ] as const) {
      git(dir, "checkout", "-qb", branch, "main");
      write(
        dir,
        "STATE.md",
        STATE(
          rule(pr, "biome.json"),
          rule(100, "AGENTS.md", "2026-10-01"),
        ).replace(
          "One file per decision, in docs/decisions-in-force/.\n",
          `- 2026-10-14 · **Decision ${branch}** (Devesh): made in #${pr}.\n`,
        ),
      );
      git(dir, "commit", "-qam", branch);
    }
    git(dir, "checkout", "-q", "main");
    expect(git(dir, "merge", "-q", "--no-edit", "c").status).toBe(0);
    const d = git(dir, "merge", "-q", "--no-edit", "d");
    expect(d.status).toBe(1);
    expect(d.stdout).toContain(
      "CONFLICT (content): Merge conflict in STATE.md",
    );
  });

  it("lists the folders newest first, the README aside, then the rule changes STATE.md kept, each once", () => {
    const dir = scratch();
    const kept = rule(150, "ci.yml", "2026-10-02");
    write(dir, "STATE.md", STATE(kept, rule(100, "AGENTS.md", "2026-09-25")));
    write(dir, "docs/decisions-in-force/README.md", "# How\n- not a record\n");
    write(dir, "docs/decisions-in-force/2026-09-25-a.md", "- first\n");
    write(dir, "docs/decisions-in-force/2026-10-14-b.md", "- second\r\n");
    write(dir, "docs/rule-changes/README.md", "# How\n");
    write(dir, "docs/rule-changes/2026-10-02-moved.md", `${kept}\n`);
    write(dir, "docs/rule-changes/2026-10-14-new.md", `${rule(175, "x.ts")}\n`);
    const r = records(dir);
    expect(r).toEqual({
      decisions: ["second", "first"],
      ruleChanges: [
        rule(175, "x.ts").slice(2),
        kept.slice(2),
        rule(100, "AGENTS.md", "2026-09-25").slice(2),
      ],
      problems: [],
    });
    // The tracker page reads what `bun run records` prints as the same two lists.
    expect(parseRecords(markdown(r))).toEqual({
      decisions: r.decisions,
      ruleChanges: r.ruleChanges,
      problems: [],
    });
    // An empty records.md (the printer refused a bad file) is named, never shown as no records.
    expect(parseRecords("").problems).toEqual([
      'records.md: missing the "## Decisions in force" heading (publish the output of `bun run records`)',
      'records.md: missing the "## Rule changes" heading (publish the output of `bun run records`)',
    ]);
  });

  it("names a records folder that is missing, and a folder where a record file should be, instead of failing", () => {
    const dir = scratch();
    write(dir, "STATE.md", STATE(rule(100, "AGENTS.md", "2026-09-25")));
    write(dir, "docs/rule-changes/2026-10-14-nested/x.md", "- one\n");
    const r = records(dir);
    expect(r.decisions).toEqual([]);
    expect(r.ruleChanges).toEqual([
      rule(100, "AGENTS.md", "2026-09-25").slice(2),
    ]);
    expect(r.problems).toEqual([
      "docs/decisions-in-force/ is missing: it holds the records",
      "docs/rule-changes/2026-10-14-nested: a record is a file, not a folder",
    ]);
  });

  it("names a record file that is badly named, holds more than one line or, for a rule change, is not a record", () => {
    const dir = scratch();
    write(dir, "STATE.md", STATE());
    write(dir, "docs/decisions-in-force/a-decision.md", "- undated\n");
    write(dir, "docs/decisions-in-force/2026-10-14-two.md", "- one\n- two\n");
    write(dir, "docs/decisions-in-force/2026-10-14-Upper.md", "- one\n");
    write(dir, "docs/decisions-in-force/2026-10-14-ok.md", "- fine\n");
    write(
      dir,
      "docs/rule-changes/2026-10-14-loose.md",
      "- ci.yml got looser\n",
    );
    write(dir, "docs/rule-changes/2026-10-14-empty.md", "");
    const r = records(dir);
    expect(r.decisions).toEqual(["fine"]);
    expect(r.ruleChanges).toEqual([]);
    expect(r.problems).toEqual([
      "docs/decisions-in-force/a-decision.md: name it YYYY-MM-DD-<what>.md, in lower case",
      "docs/decisions-in-force/2026-10-14-two.md: hold one line, `- <the decision>`",
      "docs/decisions-in-force/2026-10-14-Upper.md: name it YYYY-MM-DD-<what>.md, in lower case",
      "docs/rule-changes/2026-10-14-loose.md: hold one line, `- YYYY-MM-DD · [#N](link) · <rule> · tighter | looser | neutral | mixed`",
      "docs/rule-changes/2026-10-14-empty.md: hold one line, `- YYYY-MM-DD · [#N](link) · <rule> · tighter | looser | neutral | mixed`",
    ]);
  });
});
