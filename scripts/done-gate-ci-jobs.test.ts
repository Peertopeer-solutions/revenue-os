// CI's required check is the job `checks`. When ci.yml splits the work into other jobs, a done rule
// (scripts/done-gate/ci-jobs.ts) refuses a ci.yml whose `checks` could pass while one of them did not. Pure cases call
// the rule; the last case runs the gate's rules as CI runs them, in a throwaway repo holding a copy of the gate.
import { afterAll, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_PASSED, ciJobProblems } from "./done-gate/ci-jobs";

setDefaultTimeout(30_000); // the last case starts git and bun several times
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Step = {
  [key: string]: unknown;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  [key: string]: unknown;
  needs?: string[] | string;
  steps: Step[];
};
type Ci = { [key: string]: unknown; jobs: Record<string, Job> };

/** A ci.yml with the jobs a and b and a `checks` that waits for both; `edit` changes the parsed workflow first. */
const ciYml = (edit: (ci: Ci) => void = () => {}) => {
  const ci: Ci = {
    name: "ci",
    on: { pull_request: null },
    jobs: {
      a: { "runs-on": "ubuntu-latest", steps: [{ run: "bun run lint" }] },
      b: { "runs-on": "ubuntu-latest", steps: [{ run: "bun run gate tests" }] },
      checks: {
        needs: ["a", "b"],
        if: "always()",
        "runs-on": "ubuntu-latest",
        steps: [structuredClone(ALL_PASSED)],
      },
    },
  };
  edit(ci);
  return JSON.stringify(ci); // JSON is YAML
};

it("passes a `checks` that waits for every job, runs whatever happened to them and holds only the fixed step", () => {
  expect(ciJobProblems(ciYml())).toEqual([]);
  expect(
    ciJobProblems(ciYml((ci) => (ci.jobs.checks.if = `\${{ always() }}`))),
  ).toEqual([]);
});

it("passes the repo's own ci.yml", () => {
  const text = readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
  expect(ciJobProblems(text)).toEqual([]);
});

it("says nothing of a ci.yml with no job besides `checks`", () => {
  const one = (ci: Ci) => {
    ci.jobs = { checks: { "runs-on": "ubuntu-latest", steps: [{ run: "x" }] } };
  };
  expect(ciJobProblems(ciYml(one))).toEqual([]);
});

it("refuses jobs with none named `checks`", () => {
  expect(ciJobProblems(ciYml((ci) => delete ci.jobs.checks))).toEqual([
    ".github/workflows/ci.yml has jobs (a, b) but none named `checks`, the check main's ruleset requires",
  ]);
});

it("refuses a `checks` that misses a job, naming it", () => {
  expect(ciJobProblems(ciYml((ci) => (ci.jobs.checks.needs = ["a"])))).toEqual([
    "`checks` does not wait for the job b (its `needs`)",
  ]);
  expect(ciJobProblems(ciYml((ci) => (ci.jobs.checks.needs = "a")))).toEqual([
    "`checks` does not wait for the job b (its `needs`)",
  ]);
});

it("refuses a `checks` without `if: always()`, which a failed job would skip", () => {
  for (const cond of [undefined, "success()", "!cancelled()"])
    expect(ciJobProblems(ciYml((ci) => (ci.jobs.checks.if = cond)))).toEqual([
      "`checks` lacks `if: always()`, so a job that fails would skip it, and a skipped check can pass",
    ]);
});

it("refuses a `checks` whose one step is not the fixed step, or holds more", () => {
  const said = `\`checks\` must hold exactly one step, ${JSON.stringify(ALL_PASSED)}, which fails unless every job it waits for passed`;
  for (const edit of [
    (s: Step) => (s.run = "true"),
    (s: Step) => (s.env = { RESULTS: "success" }),
    (s: Step) => (s.if = "false"),
    (s: Step) => (s.shell = "python"),
  ])
    expect(
      ciJobProblems(ciYml((ci) => edit(ci.jobs.checks.steps[0] as Step))),
    ).toEqual([said]);
  for (const steps of [[], [ALL_PASSED, { run: "true" }]])
    expect(
      ciJobProblems(ciYml((ci) => (ci.jobs.checks.steps = steps))),
    ).toEqual([said]);
});

it("refuses settings on `checks` that could change what it reports, and a name other than checks", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        ci.jobs.checks.defaults = { run: { shell: "python" } };
        ci.jobs.checks.name = "all good";
      }),
    ),
  ).toEqual([
    "`checks` sets `defaults`, which could change what it reports",
    '`checks` is named "all good", not checks',
  ]);
});

it("refuses continue-on-error on any job or step, workflow-wide env or defaults, and another job named checks", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        ci.env = { RESULTS: "success" };
        ci.jobs.a["continue-on-error"] = true;
        ci.jobs.b.steps[0]["continue-on-error"] = true;
        ci.jobs.b.name = "checks";
      }),
    ),
  ).toEqual([
    "ci.yml sets `env` or `defaults` for every job, which could change how `checks` runs its step",
    "the job a sets continue-on-error, which turns its failure into a pass",
    "the job b is named checks, as the required check is",
    "a step of the job b (bun run gate tests) sets continue-on-error, which turns its failure into a pass",
  ]);
});

it("refuses a ci.yml that can't be read, rather than passing it", () => {
  expect(ciJobProblems("jobs: [unclosed")[0]).toStartWith(
    ".github/workflows/ci.yml can't be read as YAML",
  );
});

it("binds a change to ci.yml through the gate's rules, as CI runs them", () => {
  const dir = mkdtempSync(join(tmpdir(), "done-gate-ci-jobs-"));
  dirs.push(dir);
  const sh = (cmd: string[]) =>
    spawnSync(cmd[0] as string, cmd.slice(1), { cwd: dir, encoding: "utf8" });
  const write = (file: string, body: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  };
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
  write(
    "docs/tracker/parse.js",
    readFileSync(
      join(import.meta.dir, "..", "docs", "tracker", "parse.js"),
      "utf8",
    ),
  );
  write(".github/workflows/ci.yml", ciYml());
  sh(["git", "init", "-q", "-b", "main"]);
  sh(["git", "add", "-A"]);
  sh([
    "git",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "x",
  ]);
  sh(["git", "checkout", "-qb", "feat"]);
  const rules = () => {
    const r = sh(["bun", "scripts/done-gate.ts", "rules", "--base", "main"]);
    return { status: r.status, out: r.stdout + r.stderr };
  };
  write(
    ".github/workflows/ci.yml",
    ciYml((ci) => (ci.jobs.checks.needs = ["a"])),
  );
  const missed = rules();
  expect(missed.status).toBe(1);
  expect(missed.out).toContain(
    "`checks` does not wait for the job b (its `needs`)",
  );
  write(
    ".github/workflows/ci.yml",
    ciYml((ci) => (ci.jobs.c = { "runs-on": "x", steps: [{ run: "y" }] })),
  );
  expect(rules().out).toContain("`checks` does not wait for the job c");
  write(
    ".github/workflows/ci.yml",
    ciYml((ci) => (ci.jobs.checks.steps[0].run = "echo fine")),
  );
  expect(rules().status).toBe(1);
  write(
    ".github/workflows/ci.yml",
    ciYml((ci) => {
      ci.jobs.c = { "runs-on": "x", steps: [{ run: "y" }] };
      ci.jobs.checks.needs.push("c");
    }),
  );
  expect(rules()).toMatchObject({ status: 0 });
});
