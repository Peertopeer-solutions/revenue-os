// Two gate runs at once, in two worktrees of one repository, against the local database: both pass, and the
// database checks of one never overlap the other's. Each run is the gate's own entry (`bun run gate`, as Devesh and
// the agents run it) with its real check list, runner, record and shared-stack lock (scripts/done-gate/checks.ts and
// shared-stack.ts). What each check runs is a stand-in of under a second, from the throwaway repository's own
// package.json: the repository's real suite would run this test again inside itself, and take tens of minutes twice.
// The three database checks (tests, database policies, browser checks) work on the real local database, and the
// database itself witnesses the lock: each check takes a Postgres advisory lock without waiting, so two at the same
// moment fail one of them, and with it its gate run.
import { afterAll, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};
const sh = (dir: string, cmd: string[]) =>
  spawnSync(cmd[0] as string, cmd.slice(1), { cwd: dir, encoding: "utf8" });
const write = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};

// A check: it notes when it ran, in which checkout; a database check also holds the database alone while it runs.
const CHECK = `import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import pg from "pg";

export async function check(name: string, db: boolean) {
  const note = (what: string) =>
    appendFileSync(process.env.AT_ONCE_LOG ?? "", \`\${basename(process.cwd())} \${name} \${what} \${Date.now()}\\n\`);
  note("start");
  if (db) {
    const client = new pg.Client({
      connectionString: process.env.LOCAL_DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    await client.connect();
    const { rows } = await client.query("select pg_try_advisory_lock($1::bigint) as alone", [process.env.AT_ONCE_KEY]);
    if (!rows[0].alone) {
      console.error(\`\${name}: another gate run's database check is using the database at this same moment\`);
      process.exit(1);
    }
    await client.query("select pg_sleep(0.6)");
    await client.end(); // ends the session, which releases the lock
  }
  note("end");
}

if (import.meta.main) await check(process.argv[2] ?? "", process.argv[3] === "db");
`;

/** A throwaway repository holding a copy of the gate, whose package.json scripts are the stand-in checks. */
function repo() {
  const dir = scratch("done-gate-at-once-");
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
  mkdirSync(join(dir, "docs", "tracker"), { recursive: true });
  copyFileSync(
    join(import.meta.dir, "..", "docs", "tracker", "parse.js"),
    join(dir, "docs", "tracker", "parse.js"),
  );
  write(dir, "checks/check.ts", CHECK);
  write(
    dir,
    "checks/db.test.ts",
    `import { it } from "bun:test";\nimport { check } from "./check";\nit("uses the database alone", () => check("tests", true), 30_000);\n`,
  );
  write(
    dir,
    "package.json",
    JSON.stringify({
      name: "at-once",
      private: true,
      scripts: {
        typecheck: "bun checks/check.ts typecheck",
        lint: "bun checks/check.ts lint",
        guards: "bun checks/check.ts guards",
        local: "env", // the local stack's settings come from the test's own environment
        gate: "bun scripts/done-gate.ts",
        "rls:check": "bun checks/check.ts 'database policies' db",
        e2e: "bun checks/check.ts 'browser checks' db",
      },
    }),
  );
  write(dir, ".gitignore", "node_modules\n");
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "add", "-A"]);
  sh(dir, [
    "git",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "x",
  ]);
  // origin/main at that commit, so the "tests proven" check finds the main it compares with: no product code changed.
  sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

/** `bun run gate` in `cwd`, started now; resolves to its exit code and output. */
const gateRun = (cwd: string, env: Record<string, string>) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn("bun", ["run", "gate"], {
      cwd,
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => done({ code, out }));
  });

it("runs two real gate runs at once in two worktrees against the local database, and both pass", async () => {
  const dir = repo();
  const wt = join(scratch("done-gate-at-once-wt-"), "worktree");
  sh(dir, ["git", "worktree", "add", "-q", "-b", "other", wt]);
  for (const root of [dir, wt]) {
    symlinkSync(
      join(import.meta.dir, "..", "node_modules"),
      join(root, "node_modules"),
    );
    write(root, "which.txt", `${root}\n`); // two different codes, so neither run can reuse the other's result
  }
  const log = join(scratch("done-gate-at-once-log-"), "log");
  writeFileSync(log, "");
  const env = {
    AT_ONCE_LOG: log,
    AT_ONCE_KEY: String(Math.floor(Math.random() * 2 ** 40)), // this run's own: other runs on the database never share it
  };

  const runs = await Promise.all([gateRun(dir, env), gateRun(wt, env)]);

  for (const r of runs) {
    expect(r.out).toContain(
      "Done gate ✓ typecheck, lint, guards, tests proven, break check, database policies, 1 tests, browser checks",
    );
    expect(r.code).toBe(0);
  }
  // When each check of each run started and ended, by checkout.
  const spans = new Map<string, { start: number; end: number }>();
  for (const line of readFileSync(log, "utf8").trim().split("\n")) {
    const [, who = "", name = "", what = "", at = ""] =
      line.match(/^(\S+) (.+) (start|end) (\d+)$/) ?? [];
    const span = spans.get(`${who} ${name}`) ?? { start: 0, end: 0 };
    span[what as "start" | "end"] = Number(at);
    spans.set(`${who} ${name}`, span);
  }
  const db = ["tests", "database policies", "browser checks"];
  const of = (root: string, names: string[]) =>
    names.map((n) => spans.get(`${basename(root)} ${n}`));
  const each = [dir, wt].map((root) => ({
    all: of(root, ["typecheck", "lint", "guards", ...db]),
    db: of(root, db),
  }));
  for (const run of each) expect(run.all.every((s) => s?.end)).toBe(true);
  // At once: each run had started before the other's last check ended.
  const [a, b] = each.map((run) => ({
    first: Math.min(...run.all.map((s) => s?.start ?? 0)),
    last: Math.max(...run.all.map((s) => s?.end ?? 0)),
  }));
  expect(a && b && a.first < b.last && b.first < a.last).toBe(true);
  // One at a time on the database: no database check of one run overlaps one of the other's.
  const dbSpans = each
    .flatMap((run) => run.db)
    .sort((x, y) => (x?.start ?? 0) - (y?.start ?? 0));
  for (let i = 1; i < dbSpans.length; i++)
    expect(dbSpans[i]?.start ?? 0).toBeGreaterThanOrEqual(
      dbSpans[i - 1]?.end ?? 0,
    );
  // Each run let go of the shared stack.
  expect(existsSync(join(dir, ".git", "done-gate", "local-stack.lock"))).toBe(
    false,
  );
}, 120_000);
