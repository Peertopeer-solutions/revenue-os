// The cloud test database (staging) changes only after the tests pass: .github/workflows/staging-migrations.yml
// starts when ci finishes on a push to main (or by hand on main), checks out that exact commit, asks GitHub
// whether `checks` passed on it, and applies migrations only when the commit changed one or the cloud lacks one.
// Its steps run here as GitHub runs them (bash -e, in the checkout), with fake `gh` and `supabase` programs that
// answer as the real ones do (supabase 2.109.1's JSON listing, GitHub's check-runs reply).
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import { isLocalUrl } from "./local-url";

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
};
const write = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
const git = (dir: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();

type Step = {
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
  if?: string;
};
type Job = {
  name?: string;
  if?: string;
  environment?: string;
  concurrency?: unknown;
  permissions?: unknown;
  env?: unknown;
  steps?: Step[];
};
type Workflow = {
  name?: string;
  on?: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};
const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const workflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(join(WORKFLOWS, `${name}.yml`), "utf8"),
  ) as Workflow;

const SHA = `\${{ github.event.workflow_run.head_sha || github.sha }}`; // the commit ci passed, or main's tip by hand
const job = () =>
  workflow("staging-migrations").jobs["staging-migrations"] as Job;
const stepOf = (find: (s: Step) => boolean) => job().steps?.find(find) as Step;
const decideStep = () => stepOf((s) => s.id === "decide");
const applyStep = () =>
  stepOf((s) => /^\s*supabase db push\b/m.test(s.run ?? ""));

describe("staging-migrations.yml: the cloud test database changes only after `checks` passed on the same commit", () => {
  it("starts when ci finishes on a push to main, or by hand on main, and never for a pull request", () => {
    const w = workflow("staging-migrations");
    expect(w.on).toEqual({
      workflow_run: {
        workflows: ["ci"],
        types: ["completed"],
        branches: ["main"],
      },
      workflow_dispatch: null,
    });
    const ci = workflow("ci"); // the workflow it follows, and the check it asks GitHub about
    expect(ci.name).toBe("ci");
    expect(ci.jobs.checks?.name).toBeUndefined();
    expect(Object.keys(w.jobs)).toEqual(["staging-migrations"]);
    expect(job().if?.replace(/\s+/g, " ").trim()).toBe(
      "(github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
    );
    // One job at a time, never cancelled half-way through a push to the database. Set on the job, not the run, so
    // a run whose job is skipped (ci failed or was cancelled) never replaces a run waiting to apply.
    expect(w.concurrency).toBeUndefined();
    expect(job().concurrency).toEqual({
      group: "staging-migrations",
      "cancel-in-progress": false,
    });
  });

  it("holds the cloud secrets only where it needs them: read-only, the staging environment, two steps, no installed packages", () => {
    const w = workflow("staging-migrations");
    expect(w.permissions).toEqual({ contents: "read" });
    expect(job().permissions).toEqual({ contents: "read", checks: "read" });
    expect(job().environment).toBe("staging");
    expect(job().env).toBeUndefined();
    const steps = job().steps ?? [];
    const [checkout] = steps;
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);
    expect(checkout?.with).toEqual({
      ref: SHA,
      "fetch-depth": 2,
      "persist-credentials": false,
    });
    for (const s of steps) {
      if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/); // pinned by commit
      expect(s.run ?? "").not.toContain("${{"); // values arrive as environment variables
      expect(s.run ?? "").not.toMatch(/\bbun (install|i|add)\b/);
      const secret = Object.values(s.env ?? {}).some((v) =>
        String(v).includes("secrets."),
      );
      const needsThem = s.id === "decide" || s.run === applyStep().run;
      expect([s.id ?? s.uses, secret]).toEqual([s.id ?? s.uses, needsThem]);
    }
    expect(decideStep().env?.SHA).toBe(SHA);
    expect(decideStep().run?.trim()).toBe("bun scripts/staging-migrations.ts");
    expect(applyStep().if).toBe("steps.decide.outputs.apply == 'true'");
    expect(
      steps.map(
        (s) =>
          s.id ?? (s.run === applyStep().run ? "apply" : s.uses?.split("@")[0]),
      ),
    ).toEqual([
      "actions/checkout",
      "oven-sh/setup-bun",
      "supabase/setup-cli",
      "decide",
      "apply",
    ]);
  });

  // behaviour already on main: it checks staging-migrations.yml, which is not product code, so the gate's copy of main carries this change's switch; with main's own workflow it fails
  it("turns the CLI's usage reports off in both steps that run it, so a report it can't send never fails a command that worked", () => {
    // runJob shows the decide step failing without it, against the real CLI; agents may not run `supabase db push`.
    for (const s of [decideStep(), applyStep()])
      expect(s.env?.SUPABASE_TELEMETRY_DISABLED).toBe("1");
  });

  it("is the only workflow that applies migrations to the cloud: deploy.yml no longer does, on every push", () => {
    const appliers = readdirSync(WORKFLOWS).flatMap((file) =>
      Object.entries(workflow(file.replace(/\.yml$/, "")).jobs).flatMap(
        ([id, j]) =>
          (j.steps ?? [])
            .filter((s) =>
              /^\s*supabase\b.*\bdb push\b|staging-migrations\.ts/m.test(
                s.run ?? "",
              ),
            )
            .map(() => `${file} ${id}`),
      ),
    );
    expect(appliers).toEqual([
      "staging-migrations.yml staging-migrations",
      "staging-migrations.yml staging-migrations",
    ]);
  });
});

const M = "supabase/migrations";
const PASSED = [
  {
    id: 2,
    name: "checks",
    conclusion: "success",
    app: { slug: "github-actions" },
  },
];
// What CLI 2.109.1 printed on stdout, after its listing, when it exited 1 on a loaded Mac (2026-10-13).
const CLI_ERROR = `{"_tag":"Error","error":{"code":"UnknownError","message":"Timeout while shutting down PostHog. Some events may not have been sent."}}`;

/**
 * One run of the job as GitHub runs it: a checkout whose main holds two migrations and then `change`, fake `gh` and
 * `supabase` that answer with `checks` (GitHub's check runs on the commit) and `cloud` (the versions the cloud test
 * database has), the decide step, then the apply step when the decide step said so. With `cloudUrl`, the real
 * Supabase CLI lists the migrations against that database instead, its usage reports (telemetry) sent to a closed
 * port: when it can't send them in time, CLI 2.109.1 prints a listing that worked and then exits 1 (a loaded Mac,
 * 2026-10-13), so the run works only because the workflow turns them off, as GitHub's runs need it to.
 */
function runJob(
  change: (dir: string) => void,
  cloud: string[],
  {
    checks = PASSED as unknown[],
    listFails = false,
    pushFails = false,
    listed,
    cloudUrl,
  }: {
    checks?: unknown[];
    listFails?: boolean;
    pushFails?: boolean;
    listed?: string[];
    cloudUrl?: string;
  } = {},
) {
  const dir = scratch("staging-migrations-");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(import.meta.dir, "staging-migrations.ts"),
    join(dir, "scripts", "staging-migrations.ts"),
  );
  write(dir, `${M}/001_contacts.sql`, "create table contacts (id int);\n");
  write(dir, `${M}/002_calls.sql`, "create table calls (id int);\n");
  write(dir, `${M}/README.md`, "How migrations are written.\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "main");
  change(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the commit ci passed", "--allow-empty");
  const sha = git(dir, "rev-parse", "HEAD");

  const bin = scratch("staging-fakes-");
  const local = readdirSync(join(dir, M)).flatMap(
    (f) => f.match(/^(\d+)_.*\.sql$/)?.[1] ?? [],
  );
  const versions = [...new Set([...(listed ?? local), ...cloud])].sort();
  const listing = {
    migrations: versions.map((v) => ({
      local: (listed ?? local).includes(v) ? v : "",
      remote: cloud.includes(v) ? v : "",
      time: v,
    })),
    message: "Migrations listed",
  };
  write(
    bin,
    "checks.json",
    JSON.stringify({ total_count: checks.length, check_runs: checks }),
  );
  write(bin, "list.json", JSON.stringify(listing));
  write(
    bin,
    "gh",
    `#!/bin/sh\necho "gh $*" >> "${bin}/calls.txt"\ncat "${bin}/checks.json"\n`,
  );
  write(
    bin,
    "supabase",
    `#!/bin/sh\necho "supabase $*" >> "${bin}/calls.txt"\nif [ "$1 $2" = "migration list" ]; then ${
      cloudUrl
        ? `exec env SUPABASE_TELEMETRY_POSTHOG_HOST=http://127.0.0.1:9 "${Bun.which("supabase")}" "$@" --db-url "${cloudUrl}"`
        : `echo "Connecting to remote database..." >&2; cat "${bin}/list.json"; ${listFails ? `echo; echo '${CLI_ERROR}'; exit 1` : "exit 0"}`
    }; fi\nif [ "$1 $2" = "db push" ]; then exit ${pushFails ? 1 : 0}; fi\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "supabase"), 0o755);
  const values: Record<string, string> = {
    SHA: sha,
    GH_TOKEN: "fake",
    SUPABASE_ACCESS_TOKEN: "fake",
    SUPABASE_DB_PASSWORD: "fake",
  };
  const run = (s: Step) =>
    spawnSync("bash", ["-e", "-c", s.run ?? ""], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(s.env ?? {}).map(([k, v]) => [
            k,
            String(v).includes("${{") ? (values[k] ?? "") : String(v),
          ]),
        ),
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "devesh911/revenue-os",
        GITHUB_OUTPUT: join(bin, "output.txt"),
        GITHUB_STEP_SUMMARY: join(bin, "summary.txt"),
      },
    });
  const decided = run(decideStep());
  const said = (f: string) =>
    existsSync(join(bin, f)) ? readFileSync(join(bin, f), "utf8") : ""; // output.txt, calls.txt…
  const apply = said("output.txt").includes("apply=true");
  const applied = apply ? run(applyStep()) : undefined;
  return {
    sha,
    status: decided.status,
    out: decided.stdout + decided.stderr,
    output: said("output.txt"),
    summary: said("summary.txt"),
    calls: said("calls.txt").trim().split("\n").filter(Boolean),
    applied: applied?.status,
  };
}

// Scratch databases on the real local Postgres, each recording applied migrations as a Supabase project does.
const ADMIN = new URL(
  process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
const databases: string[] = [];
afterAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN.href });
  await admin.connect();
  for (const name of databases)
    await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});
/** A new database holding `applied` as its applied migrations (none recorded at all without it); its address. */
async function cloudOf(applied?: string[]) {
  if (!isLocalUrl(ADMIN.href))
    throw new Error("scratch databases only on the local stack");
  const name = `staging_migrations_test_${process.pid}_${databases.length}`;
  const admin = new pg.Client({ connectionString: ADMIN.href });
  await admin.connect();
  await admin.query(`create database ${name}`);
  databases.push(name);
  await admin.end();
  const url = new URL(ADMIN.href);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  if (applied) {
    await db.query(
      "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)",
    );
    for (const v of applied)
      await db.query(
        "insert into supabase_migrations.schema_migrations (version) values ($1)",
        [v],
      );
  }
  await db.end();
  return url.href;
}

const ASKED = (sha: string) =>
  `gh api repos/devesh911/revenue-os/commits/${sha}/check-runs?check_name=checks&filter=latest`;
const LISTED = [
  "supabase link --project-ref ajtfillmkjhoffxllqja",
  "supabase migration list --output-format json",
];

describe("the decide step: apply only when the commit changed a migration or the cloud lacks one", () => {
  it("skips, leaving the apply step skipped, when the commit changed no migration and the cloud has every one", () => {
    const r = runJob(
      (dir) =>
        write(
          dir,
          `${M}/README.md`,
          "How migrations are written, and never edited.\n",
        ),
      ["001", "002"],
    );
    expect(r.status).toBe(0);
    expect(r.output).toBe("apply=false\n");
    expect(r.calls).toEqual([ASKED(r.sha), ...LISTED]); // `checks` asked about first, nothing pushed
    expect(r.out).toContain(`\`checks\` passed on ${r.sha}`);
    expect(r.out).toContain(
      "Skipping: it changed no migration, and the cloud test database has all 2.",
    );
    expect(r.summary).toContain("Skipping: it changed no migration");
    expect(r.applied).toBeUndefined();
  });

  it("applies a migration the commit adds", () => {
    const r = runJob(
      (dir) =>
        write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n"),
      ["001", "002"],
    );
    expect([r.status, r.output, r.applied]).toEqual([0, "apply=true\n", 0]);
    expect(r.out).toContain(
      `Applying: it changed ${M}/003_tasks.sql, and the cloud test database lacks 003.`,
    );
    expect(r.calls).toEqual([
      ASKED(r.sha),
      ...LISTED,
      "supabase db push --include-all",
      "supabase migration list",
    ]);
  });

  it("catches up when the commit changed no migration but the cloud lacks one main has (an earlier run was missed)", () => {
    const r = runJob((dir) => write(dir, "docs/x.md", "a doc\n"), ["001"]);
    expect([r.status, r.output, r.applied]).toEqual([0, "apply=true\n", 0]);
    expect(r.out).toContain("Applying: the cloud test database lacks 002.");
    expect(r.calls).toContain("supabase db push --include-all");
  });

  it("when a migration fails on the cloud, fails the run and points Devesh at the way out", () => {
    const r = runJob(
      (dir) =>
        write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n"),
      ["001", "002"],
      { pushFails: true },
    );
    expect([r.status, r.output, r.applied]).toEqual([0, "apply=true\n", 1]);
    expect(r.summary).toContain(
      "A migration failed on the cloud test database, and every later run will stop at it until it is fixed: docs/runbooks/staging-migration-failed.md says what to do",
    );
    expect(
      existsSync(
        join(
          import.meta.dir,
          "..",
          "docs",
          "runbooks",
          "staging-migration-failed.md",
        ),
      ),
    ).toBe(true);
  });

  it("never reaches the cloud when `checks` has not passed on this commit, as GitHub Actions reported it", () => {
    const by = (
      conclusion: string | null,
      id = 2,
      slug = "github-actions",
    ) => ({ id, name: "checks", conclusion, app: { slug } });
    for (const checks of [
      [by("failure")],
      [by("skipped")], // a skipped `checks` still lets ci's run pass
      [by(null)], // still running
      [],
      [by("success", 2, "someone-else")], // anyone can post a check named `checks`
      [by("success", 1), by("failure", 2)], // the latest run is the one that counts
    ]) {
      const r = runJob(
        (dir) =>
          write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n"),
        ["001", "002"],
        { checks },
      );
      expect([JSON.stringify(checks), r.status, r.output]).toEqual([
        JSON.stringify(checks),
        1,
        "",
      ]);
      expect(r.out).toContain(`\`checks\` has not passed on ${r.sha}`);
      expect(r.calls).toEqual([ASKED(r.sha)]);
    }
  });

  it("fails, never skips, when it can't tell what the cloud lacks", () => {
    const add = (dir: string) =>
      write(dir, `${M}/003_tasks.sql`, "create table tasks (id int);\n");
    const listFails = runJob(add, ["001", "002"], { listFails: true });
    expect([listFails.status, listFails.output]).toEqual([1, ""]);
    expect(listFails.out).toContain("supabase migration list failed");
    expect(listFails.out).toContain(CLI_ERROR); // the CLI's own reason, which it prints on stdout
    const misread = runJob(add, ["001", "002"], { listed: ["001", "002"] }); // a listing that misses 003_tasks.sql
    expect([misread.status, misread.output]).toEqual([1, ""]);
    expect(misread.out).toContain(
      "lists local migrations 001, 002, but the checkout holds 001, 002, 003",
    );
    const ahead = runJob(add, ["001", "002", "003", "004"]);
    expect([ahead.status, ahead.output]).toEqual([1, ""]);
    expect(ahead.out).toContain(
      `the cloud test database has 004, which ${ahead.sha} doesn't`,
    );
    for (const r of [listFails, misread, ahead])
      expect(r.calls.join("\n")).not.toContain("db push");
  });

  // behaviour already on main: its decide step runs with staging-migrations.yml's env, which is not product code, so the gate's copy of main carries this change's switch; with main's own workflow it fails, the CLI's usage reports unsent
  it("reads the real Supabase CLI's listing, with a scratch database on the local stack standing in for the cloud", async () => {
    const doc = (dir: string) => write(dir, "docs/x.md", "a doc\n");
    // What the step did, and its own words when it exited otherwise than `status`, so a failure says why.
    const did = (r: ReturnType<typeof runJob>, status: number) => [
      r.status,
      r.output,
      r.applied,
      r.status === status ? "" : r.out,
    ];
    const up = runJob(doc, [], { cloudUrl: await cloudOf(["001", "002"]) });
    expect(did(up, 0)).toEqual([0, "apply=false\n", undefined, ""]);
    expect(up.out).toContain(
      "Skipping: it changed no migration, and the cloud test database has all 2.",
    );
    const behind = runJob(doc, [], { cloudUrl: await cloudOf(["001"]) });
    expect(did(behind, 0)).toEqual([0, "apply=true\n", 0, ""]);
    expect(behind.out).toContain(
      "Applying: the cloud test database lacks 002.",
    );
    const fresh = runJob(doc, [], { cloudUrl: await cloudOf() }); // a database no migration has reached yet
    expect(did(fresh, 0)).toEqual([0, "apply=true\n", 0, ""]);
    expect(fresh.out).toContain(
      "Applying: the cloud test database lacks 001, 002.",
    );
    const ahead = runJob(doc, [], {
      cloudUrl: await cloudOf(["001", "002", "004"]),
    });
    expect(did(ahead, 1)).toEqual([1, "", undefined, ""]);
    expect(ahead.out).toContain("the cloud test database has 004");
  });
});
