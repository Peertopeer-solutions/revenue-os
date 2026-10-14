// Migrations on main never change (AGENTS.md hard rail 4): main's copy of the gate (`bun run gate pr`, which the
// required rules-from-main check runs) refuses a branch that edits, renames or deletes a migration main already
// has, gives a new one a number another migration has, or numbers it so it would run before one main has. Each
// case runs the gate as the Slice 0 proof does: from main's checkout, judging a scratch branch as data with `--head`.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

setDefaultTimeout(30_000); // each case starts git and bun several times
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = (
  dir: string,
  cmd: string[],
  env: Record<string, string> = {},
  input?: string,
) =>
  spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
  });
const write = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
const GIT = ["git", "-c", "user.email=t@t", "-c", "user.name=t"];
const commit = (dir: string) => {
  sh(dir, ["git", "add", "-A"]);
  sh(dir, [...GIT, "commit", "-qm", "x"]);
};

const M = "supabase/migrations";
/**
 * A scratch repo whose main holds a copy of the gate and two migrations (or `migrations`, file → SQL), with a
 * branch `feat` cut from it.
 */
function project(
  migrations: Record<string, string> = {
    "001_contacts.sql": "create table contacts (id int);\n",
    "002_calls.sql": "create table calls (id int);\n",
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "done-gate-migrations-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(import.meta.dir, "done-gate.ts"),
    join(dir, "scripts", "done-gate.ts"),
  );
  cpSync(
    join(import.meta.dir, "done-gate"),
    join(dir, "scripts", "done-gate"),
    { recursive: true },
  );
  // The gate reads ROADMAP.md with the tracker's parser.
  mkdirSync(join(dir, "docs", "tracker"), { recursive: true });
  copyFileSync(
    join(import.meta.dir, "..", "docs", "tracker", "parse.js"),
    join(dir, "docs", "tracker", "parse.js"),
  );
  write(dir, "STATE.md", "# State\n");
  write(
    dir,
    "docs/fix-when-touched.md",
    "# Fix when touched\n\n## Find your area\n\n| If your PR touches… | Fix this too |\n|---|---|\n| `docs/runbooks/` | 5. Runbooks |\n",
  ); // a table that asks about nothing these tests change
  for (const [file, sql] of Object.entries(migrations))
    write(dir, `${M}/${file}`, sql);
  write(dir, `${M}/README.md`, "How migrations are written.\n");
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  commit(dir);
  sh(dir, ["git", "checkout", "-qb", "feat"]);
  return dir;
}
const BODY = "Roadmap: off-roadmap — a migration test\n"; // a first line main's copy accepts with no ROADMAP.md
/** Go back to main and judge the branch from main's checkout as data: the exit code and each problem listed. */
const judge = (dir: string) => {
  sh(dir, ["git", "checkout", "-q", "main"]);
  const r = sh(
    dir,
    ["bun", "scripts/done-gate.ts", "pr", "--base", "main", "--head", "feat"],
    { PR_BODY: BODY, PR_NUMBER: "7" },
  );
  const out = r.stdout + r.stderr;
  return {
    status: r.status,
    out,
    problems: out
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2)),
  };
};
/** Commit the branch, then judge it. */
const judged = (dir: string) => {
  commit(dir);
  return judge(dir);
};
const PASSED =
  "Pull request ✓ its first line names what it is, nothing in the change in feat since main breaks the done rules, every rule change is explained and recorded, and every fix-when-touched entry it touches is answered\n";
const ON_MAIN = (file: string, how: string) =>
  `${M}/${file} is already on main, and this change ${how} it: a migration on main never changes (AGENTS.md hard rail 4); put the change in a new migration instead`;
const REUSES = (file: string, n: string, twin: string) =>
  `${M}/${file} reuses migration number ${n}, which ${M}/${twin} already has: give it the next free number`;
const BEFORE = (file: string, newest: string) =>
  `${M}/${file} sorts before ${M}/${newest}, which main already has, so the cloud test database would run it after that one while every local database and test runs it before: number it after ${newest}`;

describe("bun run gate pr: a migration already on main never changes, and no two share a number", () => {
  it("refuses a branch that edits a migration already on main, even by only adding a line", () => {
    const dir = project();
    write(dir, `${M}/001_contacts.sql`, "create table contacts (id bigint);\n");
    const r = judged(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [ON_MAIN("001_contacts.sql", "edits")],
    ]);
    sh(dir, ["git", "checkout", "-q", "feat"]);
    sh(dir, ["git", "checkout", "-q", "main", "--", M]);
    write(
      dir,
      `${M}/002_calls.sql`,
      "create table calls (id int);\nalter table calls add note text;\n",
    );
    const appended = judged(dir);
    expect([appended.status, appended.problems]).toEqual([
      1,
      [ON_MAIN("002_calls.sql", "edits")],
    ]);
  });

  it("refuses a branch that deletes or renames a migration already on main", () => {
    const dir = project();
    rmSync(join(dir, M, "001_contacts.sql"));
    sh(dir, ["git", "mv", `${M}/002_calls.sql`, `${M}/003_calls.sql`]);
    const r = judged(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [
        ON_MAIN("001_contacts.sql", "deletes or renames"),
        ON_MAIN("002_calls.sql", "deletes or renames"),
      ],
    ]);
  });

  it("refuses a migration on main turned into a link to other SQL", () => {
    const dir = project();
    write(dir, "other.sql", "drop table contacts;\n");
    rmSync(join(dir, M, "001_contacts.sql"));
    symlinkSync("../../other.sql", join(dir, M, "001_contacts.sql"));
    const r = judged(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [ON_MAIN("001_contacts.sql", "edits")],
    ]);
  });

  it("refuses a new migration that reuses a number, whether main's or another new one's", () => {
    const dir = project();
    write(dir, `${M}/002_notes.sql`, "create table notes (id int);\n");
    write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n");
    write(dir, `${M}/003_tags.sql`, "create table tags (id int);\n");
    const r = judged(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [
        REUSES("002_notes.sql", "002", "002_calls.sql"),
        REUSES("003_tags.sql", "003", "003_tasks.sql"),
        REUSES("003_tasks.sql", "003", "003_tags.sql"),
      ],
    ]);
  });

  it("reads a number as a person does: 2 is the number 002 already has", () => {
    const dir = project();
    write(dir, `${M}/2_notes.sql`, "create table notes (id int);\n");
    const r = judged(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [REUSES("2_notes.sql", "2", "002_calls.sql")],
    ]);
  });

  it("refuses a migration in a folder spelled like supabase/migrations/ in another letter case, which a Mac reads as one", () => {
    const dir = project();
    const blob = sh(
      dir,
      ["git", "hash-object", "-w", "--stdin"],
      {},
      "create table evil (id int);\n",
    ).stdout.trim();
    // Straight into git: on a Mac, writing the file would land it in supabase/migrations/ itself.
    sh(dir, [
      "git",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},supabase/Migrations/002_evil.sql`,
    ]);
    sh(dir, [...GIT, "commit", "-qm", "x"]);
    const r = judge(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [
        "supabase/Migrations/002_evil.sql is in a folder spelled differently from supabase/migrations/: a Mac reads it as a migration and Linux doesn't; put it in supabase/migrations/",
      ],
    ]);
  });

  it("passes a new migration with a fresh number, and an edit to the migrations folder's README", () => {
    const dir = project();
    write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n");
    write(
      dir,
      `${M}/README.md`,
      "How migrations are written, and never edited.\n",
    );
    expect(judged(dir)).toEqual({ status: 0, out: PASSED, problems: [] });
  });

  it("doesn't blame a branch for two migrations main itself already numbers alike", () => {
    const dir = project({
      "001_contacts.sql": "create table contacts (id int);\n",
      "002_calls.sql": "create table calls (id int);\n",
      "002_notes.sql": "create table notes (id int);\n",
    });
    write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n");
    expect(judged(dir)).toEqual({ status: 0, out: PASSED, problems: [] });
  });

  it("judges a branch against where it left main, and again once it catches up, as main's ruleset makes it", () => {
    for (const [ours, theirs, problem] of [
      ["003_b.sql", "003_a.sql", REUSES("003_b.sql", "003", "003_a.sql")],
      [
        "003_tasks.sql",
        "004_notes.sql",
        BEFORE("003_tasks.sql", "004_notes.sql"),
      ],
    ] as const) {
      const dir = project();
      write(dir, `${M}/${ours}`, "create table ours (id int);\n");
      commit(dir);
      sh(dir, ["git", "checkout", "-q", "main"]);
      write(dir, `${M}/${theirs}`, "create table theirs (id int);\n");
      commit(dir); // main moves on after the branch left it
      sh(dir, ["git", "checkout", "-q", "feat"]);
      // Behind main: not blamed for main's newer migration, which the branch's code lacks.
      expect([ours, judge(dir)]).toEqual([
        ours,
        { status: 0, out: PASSED, problems: [] },
      ]);
      sh(dir, ["git", "checkout", "-q", "feat"]);
      sh(dir, [...GIT, "merge", "-q", "--no-edit", "main"]);
      const caughtUp = judge(dir);
      expect([ours, caughtUp.status, caughtUp.problems]).toEqual([
        ours,
        1,
        [problem],
      ]);
    }
  });

  it("refuses a new migration numbered to run before one main already has", () => {
    const dir = project({
      "001_contacts.sql": "create table contacts (id int);\n",
      "005_calls.sql": "create table calls (id int);\n",
    });
    write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n");
    write(dir, `${M}/006_tags.sql`, "create table tags (id int);\n");
    const r = judged(dir);
    expect([r.status, r.problems]).toEqual([
      1,
      [BEFORE("003_tasks.sql", "005_calls.sql")],
    ]);
  });

  it("runs locally on the worktree too, before anything is committed", () => {
    const dir = project();
    write(dir, `${M}/001_contacts.sql`, "create table contacts (id bigint);\n");
    const r = sh(dir, ["bun", "scripts/done-gate.ts", "pr", "--base", "main"], {
      PR_BODY: BODY,
    });
    expect(r.stdout).toContain(ON_MAIN("001_contacts.sql", "edits"));
    expect(r.status).toBe(1);
  });
});

describe("bun run gate pr: the script that makes the cloud test database wait for `checks` is a rule file", () => {
  // behaviour already on main: main's copy carries scripts/done-gate/rule-changes.ts over (gate code is not product code), so it passes there; on main's own rule-changes.ts it names STATE.md, not docs/rule-changes/, and fails
  it("refuses a change to it, or to its test, that the PR body doesn't explain and no file in docs/rule-changes/ records", () => {
    const dir = project();
    write(dir, "scripts/staging-migrations.ts", "console.log('apply');\n");
    write(dir, "scripts/staging-migrations.test.ts", "// no test\n");
    const r = judged(dir);
    expect(r.status).toBe(1);
    expect(r.problems).toEqual([
      expect.stringContaining(
        "the PR body explains no change to scripts/staging-migrations.test.ts, scripts/staging-migrations.ts",
      ),
      expect.stringContaining(
        "docs/rule-changes/ gains no record of #7 naming scripts/staging-migrations.test.ts, scripts/staging-migrations.ts",
      ),
    ]);
  });
});
