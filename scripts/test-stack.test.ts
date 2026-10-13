// CI's jobs and the proof workflow start the local Supabase stack with .github/test-stack.sh: only the database,
// sign-in, data interface and gateway, failing unless exactly those four run. Driven here with a stand-in `supabase`
// and `docker` first on the PATH, never the real stack, which another checkout may be using.
import { afterAll, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A test starts bash, and through it sed, sort and the stand-ins, up to four times; under load that passed bun's 5 s.
setDefaultTimeout(60_000);
const SCRIPT = join(import.meta.dir, "..", ".github", "test-stack.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * The script in a scratch checkout whose project is "p", with `running` the container names docker lists. GITHUB_ENV
 * is always set here (`githubEnv`, or empty): on GitHub's runner the test itself runs with the job's own.
 */
function start(
  running: string[],
  startFails = false,
  githubEnv = "",
  loginFails = false,
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "test-stack-")));
  dirs.push(dir);
  mkdirSync(join(dir, "supabase"));
  writeFileSync(join(dir, "supabase", "config.toml"), 'project_id = "p"\n');
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "supabase"),
    `#!/bin/sh\necho "$*" >> "${bin}/asked.txt"\ncase "$1" in status) printf 'API_URL="http://127.0.0.1:54321"\\nANON_KEY="anon-key"\\n' ;; esac\n${startFails ? "exit 1" : "exit 0"}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\ncase "$1" in\n  exec) echo "docker $*" >> "${bin}/asked.txt"; exit ${loginFails ? 1 : 0} ;;\n  *) printf '%s\\n' ${running.map((n) => `'${n}'`).join(" ")} ;;\nesac\n`,
    { mode: 0o755 },
  );
  const r = spawnSync("bash", [SCRIPT], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_ENV: githubEnv,
    },
    encoding: "utf8",
  });
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    asked: readFileSync(join(bin, "asked.txt"), "utf8").trim(),
  };
}

const START =
  "start -x edge-runtime,imgproxy,logflare,mailpit,postgres-meta,realtime,storage-api,studio,vector";
const LOGIN =
  "docker exec supabase_db_p psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c alter role app_service with login password 'app_service_local'";
const FOUR = [
  "supabase_db_p",
  "supabase_auth_p",
  "supabase_rest_p",
  "supabase_kong_p",
];

it("starts the stack without the nine services the tests don't use, and passes when exactly the four run", () => {
  const r = start([...FOUR, "supabase_db_other", "juice-shop"]);
  expect(r.asked.split("\n")[0]).toBe(START);
  expect([r.status, r.out.trim()]).toEqual([
    0,
    "the local stack runs exactly: auth db kong rest",
  ]);
});

it("then lets the worker's role log in with its local password, and fails when it can't", () => {
  expect(start(FOUR).asked.split("\n")).toEqual([START, LOGIN]);
  const failed = start(FOUR, false, "", true);
  expect(failed.status).toBe(1);
  // Not before the four are known to run, and not at all when they aren't.
  expect(start([...FOUR, "supabase_studio_p"]).asked).toBe(START);
});

it("fails, naming what runs, when another service runs too, one of the four is missing, or none runs", () => {
  for (const [running, said] of [
    [[...FOUR, "supabase_studio_p"], "auth db kong rest studio"],
    [[...FOUR, "supabase_pg_meta_p"], "auth db kong pg_meta rest"],
    [FOUR.filter((n) => n !== "supabase_rest_p"), "auth db kong"],
    [[], "nothing"],
  ] as [string[], string][]) {
    const r = start(running);
    expect([r.status, r.out.trim()]).toEqual([
      1,
      `the local stack runs: ${said}; the tests need exactly: auth db kong rest`,
    ]);
  }
});

it("fails when the stack does not start", () => {
  expect(start(FOUR, true).status).toBe(1);
});

it("is how each of CI's three jobs and the proof workflow start the stack, and no workflow starts it another way", () => {
  const starts: string[] = [];
  for (const file of ["ci.yml", "proof.yml"]) {
    const wf = Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, "..", ".github", "workflows", file),
        "utf8",
      ),
    ) as { jobs: Record<string, { steps?: { run?: string }[] }> };
    for (const [id, job] of Object.entries(wf.jobs))
      for (const s of job.steps ?? [])
        if (/supabase (start|init)|test-stack\.sh/.test(s.run ?? ""))
          starts.push(`${file} ${id}: ${s.run?.trim()}`);
  }
  expect(starts).toEqual([
    "ci.yml quick: bash .github/test-stack.sh",
    "ci.yml suite: bash .github/test-stack.sh",
    "ci.yml at-once: bash .github/test-stack.sh",
    "proof.yml proof: bash .github/test-stack.sh",
  ]);
});

it("in a GitHub job, hands the job's later steps the settings the tests read, from the stack's own status", () => {
  const env = join(
    realpathSync(mkdtempSync(join(tmpdir(), "test-stack-env-"))),
    "env",
  );
  dirs.push(dirname(env));
  const r = start(FOUR, false, env);
  expect(r.status).toBe(0);
  expect(r.asked.split("\n")).toEqual([START, LOGIN, "status -o env"]);
  expect(readFileSync(env, "utf8").trim().split("\n")).toEqual([
    "SUPABASE_URL=http://127.0.0.1:54321",
    "SUPABASE_ANON_KEY=anon-key",
    "DATABASE_URL=postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
    "LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "VAPI_WEBHOOK_SECRET=local-test-secret",
  ]);
});
