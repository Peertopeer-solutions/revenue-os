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
import {
  ALL_PASSED,
  ciJobProblems,
  QUEUE_ONLY,
  QUEUE_ONLY_SKIPPED,
} from "./done-gate/ci-jobs";

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

it("holds the repo's whole suite and four-runs-at-once test back from pull requests into main, and nothing else", () => {
  const text = readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const ci = Bun.YAML.parse(text) as Ci & { on: Record<string, unknown> };
  expect(
    Object.entries(ci.jobs).flatMap(([id, job]) =>
      job.if === QUEUE_ONLY ? [id] : [],
    ),
  ).toEqual(["suite", "at-once"]);
  expect(ciJobProblems(text)).toEqual([]);
  expect(Object.keys(ci.jobs)).toEqual(["quick", "suite", "at-once", "checks"]);
  expect(ci.jobs.checks.steps).toEqual([QUEUE_ONLY_SKIPPED]);
  expect(ci.on).toEqual({
    pull_request: { branches: ["main"] },
    push: { branches: ["main"] },
    merge_group: { types: ["checks_requested"] },
  });
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
  const said = `\`checks\` must hold exactly one step, ${JSON.stringify(ALL_PASSED)}, which fails unless every job it waits for passed, or ${JSON.stringify(QUEUE_ONLY_SKIPPED)}, which also lets a job held back from pull requests be skipped on one`;
  for (const edit of [
    (s: Step) => (s.run = "true"),
    (s: Step) =>
      Object.assign(s, structuredClone(QUEUE_ONLY_SKIPPED), {
        env: { ...QUEUE_ONLY_SKIPPED.env, HELD_BACK: "skipped" },
      }),
    (s: Step) =>
      Object.assign(s, structuredClone(QUEUE_ONLY_SKIPPED), {
        run: QUEUE_ONLY_SKIPPED.run.replace('"$HELD_BACK"', "skipped"),
      }),
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

/** b runs only in the merge queue and on main, and `checks` holds the step that lets it be skipped on a pull request. */
const queueOnly = (ci: Ci) => {
  ci.jobs.b.if = QUEUE_ONLY;
  ci.jobs.checks.steps = [structuredClone(QUEUE_ONLY_SKIPPED)];
};

it("passes a job held back from pull requests, with the step that accepts it skipped only on a pull request", () => {
  expect(QUEUE_ONLY).toBe("github.event_name != 'pull_request'");
  expect(QUEUE_ONLY_SKIPPED.env.HELD_BACK).toBe(
    `\${{ github.event_name == 'pull_request' && 'skipped' || 'none' }}`,
  );
  expect(ciJobProblems(ciYml(queueOnly))).toEqual([]);
  expect(
    ciJobProblems(
      ciYml((ci) => {
        queueOnly(ci);
        ci.jobs.b.if = `\${{ ${QUEUE_ONLY} }}`;
        ci.jobs.c = {
          if: QUEUE_ONLY,
          needs: ["a", "b"],
          "runs-on": "ubuntu-latest",
          steps: [{ run: "y" }],
        };
        (ci.jobs.checks.needs as string[]).push("c");
      }),
    ),
  ).toEqual([]);
  // The step that accepts no skip at all still passes beside a held-back job: there `checks` fails on a pull request.
  expect(ciJobProblems(ciYml((ci) => (ci.jobs.b.if = QUEUE_ONLY)))).toEqual([]);
});

it("refuses a job `checks` waits for that runs on any other condition, which could skip it in the merge queue", () => {
  for (const cond of [
    "false",
    "github.event_name == 'pull_request'",
    "github.event_name != 'merge_group'",
    "github.event_name != 'pull_request' || always()",
  ])
    expect(
      ciJobProblems(
        ciYml((ci) => {
          queueOnly(ci);
          ci.jobs.b.if = cond;
        }),
      ),
    ).toEqual([
      `the job b runs only when \`${cond}\`; a job \`checks\` waits for may be held back only from pull requests, by \`if: ${QUEUE_ONLY}\``,
    ]);
});

it("refuses a job that runs on pull requests but waits for a held-back one, which skips it there too", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        queueOnly(ci);
        ci.jobs.a.needs = "b";
      }),
    ),
  ).toEqual([
    "the job a runs on pull requests but waits for b, which is held back from them, so a would be skipped there too and `checks` would pass without it",
  ]);
});

it("refuses a ci.yml whose every job is held back from pull requests, where `checks` would pass having run nothing", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        queueOnly(ci);
        ci.jobs.a.if = QUEUE_ONLY;
      }),
    ),
  ).toEqual([
    "every job `checks` waits for is held back from pull requests, so there `checks` would pass having run none",
  ]);
});

it("refuses a step condition that could skip a step while its job passes, but not one that also runs it after a failure", () => {
  for (const cond of [
    QUEUE_ONLY,
    "false",
    "failure()",
    "success() && github.event_name != 'pull_request'",
  ])
    expect(
      ciJobProblems(ciYml((ci) => (ci.jobs.a.steps[0].if = cond))),
    ).toEqual([
      `a step of the job a (bun run lint) runs only when \`${cond}\`, so the job could pass without it; a step may only set \`if: always()\` or \`if: !cancelled()\``,
    ]);
  for (const cond of ["always()", "!cancelled()", `\${{ always() }}`])
    expect(
      ciJobProblems(ciYml((ci) => (ci.jobs.a.steps[0].if = cond))),
    ).toEqual([]);
});

it("refuses a job that calls another workflow, whose steps the rule can't see", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        ci.jobs.b = { uses: "./.github/workflows/suite.yml", steps: [] };
      }),
    ),
  ).toEqual([
    "the job b calls another workflow (./.github/workflows/suite.yml), whose steps this rule can't see",
  ]);
});

it("passes GitHub's own default condition, success(), on a job or a step, and the fixed env in any order", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        queueOnly(ci);
        ci.jobs.a.if = `\${{ success() }}`;
        ci.jobs.a.steps[0].if = "success()";
        ci.jobs.a.steps.push({ run: "x", if: "success() || failure()" });
        const { RESULTS, HELD_BACK } = QUEUE_ONLY_SKIPPED.env;
        ci.jobs.checks.steps[0].env = { HELD_BACK, RESULTS };
      }),
    ),
  ).toEqual([]);
});

it("refuses a shell that carries on past a failing command, and a local action, whose steps it can't see", () => {
  expect(
    ciJobProblems(
      ciYml((ci) => {
        ci.jobs.a.defaults = { run: { shell: "python" } };
        ci.jobs.a.steps[0].shell = "bash {0}";
        ci.jobs.b.steps.push({ uses: "./.github/actions/suite" });
      }),
    ),
  ).toEqual([
    'the job a runs its steps in the shell "python", which may carry on past a failing command; only bash or sh may be named',
    'a step of the job a (bun run lint) runs in the shell "bash {0}", which may carry on past a failing command; only bash or sh may be named',
    "a step of the job b runs a local action (./.github/actions/suite), whose steps this rule can't see",
  ]);
  expect(
    ciJobProblems(ciYml((ci) => (ci.jobs.a.steps[0].shell = "bash"))),
  ).toEqual([]);
});

it("refuses a lone `checks` that a condition or continue-on-error could let pass without its work", () => {
  const lone = (edit: (job: Job) => void) =>
    ciYml((ci) => {
      ci.jobs = {
        checks: { "runs-on": "ubuntu-latest", steps: [{ run: "x" }] },
      };
      edit(ci.jobs.checks);
    });
  expect(
    ciJobProblems(
      lone((job) => {
        job.if = "github.event_name == 'pull_request'";
        job.steps[0]["continue-on-error"] = true;
      }),
    ),
  ).toEqual([
    "the job checks runs only when `github.event_name == 'pull_request'`, and a skipped check can pass",
    "a step of the job checks (x) sets continue-on-error, which turns its failure into a pass",
  ]);
});

it("refuses a ci.yml it reads differently from GitHub: no jobs it can find, or a key in YAML's `?` form", () => {
  const unread =
    ".github/workflows/ci.yml has no `jobs` this rule can read, or a key written in YAML's `?` form, so whether `checks` waits for every job can't be told";
  expect(ciJobProblems("name: ci\n")).toEqual([unread]);
  expect(
    ciJobProblems(
      "on:\n  ? pull_request\n  : null\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n",
    ),
  ).toEqual([unread]);
  // A byte-order mark is read past, as GitHub does, so the jobs behind it are still judged.
  expect(
    ciJobProblems(`\uFEFF${ciYml((ci) => (ci.jobs.checks.needs = ["a"]))}`),
  ).toEqual(["`checks` does not wait for the job b (its `needs`)"]);
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
  write(".github/workflows/ci.yml", ciYml(queueOnly));
  expect(rules()).toMatchObject({ status: 0 });
  write(
    ".github/workflows/ci.yml",
    ciYml((ci) => {
      queueOnly(ci);
      ci.jobs.b.if = "github.event_name == 'pull_request'";
    }),
  );
  const skippedInQueue = rules();
  expect(skippedInQueue.status).toBe(1);
  expect(skippedInQueue.out).toContain(
    "the job b runs only when `github.event_name == 'pull_request'`",
  );
});
