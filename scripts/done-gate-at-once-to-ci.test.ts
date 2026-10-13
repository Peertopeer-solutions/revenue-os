// The Mac's gate runs the whole suite once and leaves the four-runs-at-once test (four whole-suite runs and a demo
// started together) to CI: its tests check leaves that one file out by its path, never by skipping it, and its summary
// says so. CI's required `checks` and Slice 0's proof still run it; proof.yml runs a proof ready or done slice's proof
// after each deploy to main and daily (scripts/proof-workflow.test.ts), and every agent merge waits for `checks` to
// pass on its exact commit (scripts/done-gate-guards.test.ts).
import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CHECKS } from "./done-gate/checks";
import { ciJobProblems } from "./done-gate/ci-jobs";
import { AT_ONCE, AT_ONCE_ALONE, LEAVE_AT_ONCE } from "./done-gate/tests-ran";
import { twoRunsAtOnce } from "./proof/slice-0-tests";
import { SLICES } from "./proof/slices";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};
const write = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
const sh = (dir: string, cmd: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
const GIT = ["git", "-c", "user.email=t@t", "-c", "user.name=t"];

// behaviour already on main: the gate's files are the same in both copies, which differ only in product code; main's gate refuses the switch (exit 2)
it("its tests command leaves out that one file by its path, never by skipping it, and only when told to", () => {
  // A repository holding the gate, that test file, a test of the same name in another folder, and another test.
  const dir = scratch("at-once-to-ci-");
  cpSync(
    join(ROOT, "scripts", "done-gate"),
    join(dir, "scripts", "done-gate"),
    {
      recursive: true,
    },
  );
  copyFileSync(
    join(ROOT, "scripts", "done-gate.ts"),
    join(dir, "scripts", "done-gate.ts"),
  );
  cpSync(join(ROOT, "docs", "tracker"), join(dir, "docs", "tracker"), {
    recursive: true,
  });
  write(dir, AT_ONCE, ranTest("four runs at once"));
  write(
    dir,
    "packages/p/test/test-runs-at-once.test.ts",
    ranTest("same name elsewhere"),
  );
  write(dir, "services/worker/test/other.test.ts", ranTest("another test"));
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "add", "-A"]);
  sh(dir, [...GIT, "commit", "-qm", "x"]);
  sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
  const tests = (...args: string[]) => {
    rmSync(join(dir, "ran.txt"), { force: true });
    const r = sh(dir, ["bun", "scripts/done-gate.ts", "tests", ...args], {
      RAN: join(dir, "ran.txt"),
    });
    const ran = sh(dir, ["sort", join(dir, "ran.txt")]).stdout;
    return { status: r.status, ran: ran.trim().split("\n").filter(Boolean) };
  };
  expect(tests(LEAVE_AT_ONCE)).toEqual({
    status: 0, // nothing reported skipped
    ran: ["another test", "same name elsewhere"],
  });
  expect(tests()).toEqual({
    status: 0,
    ran: ["another test", "four runs at once", "same name elsewhere"],
  });
  // No other file can be left out from the command line.
  expect(tests(`--path-ignore-patterns=${AT_ONCE}`).status).toBe(2);
  expect(tests(LEAVE_AT_ONCE, "e2e").status).toBe(2);
});

// behaviour already on main: the gate's files are the same in both copies, which differ only in product code; main's tests check runs the whole suite and says nothing of CI
it("only the gate's tests check sets the switch, and its summary says the file was left to CI, never that it passed", () => {
  expect(
    CHECKS.filter((c) => c.cmd.includes(LEAVE_AT_ONCE)).map((c) => c.name),
  ).toEqual(["tests"]);
  const tests = CHECKS.find((c) => c.name === "tests");
  expect(tests?.cmd).toEqual([
    "bun",
    "run",
    "local",
    "bun",
    "run",
    "gate",
    "tests",
    LEAVE_AT_ONCE,
  ]);
  const out =
    "bun test v1.3.11\n\n 1234 pass\n 0 fail\nRan 1234 tests across 140 files.";
  expect(tests?.said?.(out, ROOT)).toBe(
    `1234 tests (not run here, left to CI: ${AT_ONCE})`,
  );
  // A checkout without that test has nothing left out, and its summary says nothing of it.
  expect(tests?.said?.(out, scratch("at-once-none-"))).toBe("1234 tests");
});

it("in CI only the whole-suite job leaves it out, the at-once job runs it alone, and the required `checks` waits for both", () => {
  const text = readFileSync(
    join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const ci = Bun.YAML.parse(text) as {
    jobs: Record<string, { needs?: string[]; steps?: { run?: string }[] }>;
  };
  // Each job's id with every run line that names the file, the switch or bun's leave-out.
  const naming = Object.entries(ci.jobs).flatMap(([id, j]) =>
    (j.steps ?? [])
      .map((s) => s.run?.trim() ?? "")
      .filter((r) =>
        [LEAVE_AT_ONCE, AT_ONCE_ALONE, "path-ignore-patterns", AT_ONCE].some(
          (w) => r.includes(w),
        ),
      )
      .map((r) => [id, r]),
  );
  expect(naming).toEqual([
    ["suite", `bun run gate tests ${LEAVE_AT_ONCE}`],
    ["at-once", `bun run gate tests ${AT_ONCE_ALONE}`],
  ]);
  expect(ci.jobs.checks?.needs).toEqual(["quick", "suite", "at-once"]);
  expect(ciJobProblems(text)).toEqual([]);
});

// behaviour already on main: Slice 0's proof already runs it; this fails if the proof ever leaves it out
it("Slice 0's proof still runs it, alone, on the local stack", async () => {
  expect(SLICES[0]).toContain(twoRunsAtOnce);
  // The step's check, with a stand-in bun first on the PATH: what it asks bun to run.
  const bin = scratch("at-once-bun-");
  write(
    bin,
    "bun",
    `#!/bin/sh\necho "$*" >> "${bin}/asked.txt"\necho ' 1 pass'\necho ' 0 fail'\n`,
  );
  sh(bin, ["chmod", "+x", "bun"]);
  const root = scratch("at-once-root-");
  sh(root, ["git", "init", "-q", "-b", "main"]);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await twoRunsAtOnce.check({ root, env: {}, file: (n) => join(root, n) });
  } finally {
    process.env.PATH = path;
  }
  expect(
    readFileSync(join(bin, "asked.txt"), "utf8").trim().split("\n")[0],
  ).toBe(`run local bun test ${AT_ONCE}`);
});

/**
 * A test file whose one test writes `name` to ran.txt when it runs. It sits below the tests: above them, Bun 1.3.11
 * reported this file's first test on this function's line, where tests proven (tests-proven.ts) found no mark.
 */
function ranTest(name: string) {
  return `import { appendFileSync } from "node:fs";\nimport { test as one } from "bun:test";\none("${name}", () => appendFileSync(process.env.RAN as string, "${name}\\n"));\n`;
}
