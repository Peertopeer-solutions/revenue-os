// Every check the gate runs on the code as it stands: typecheck, lint, guards, tests (all but the four-runs-at-once
// test, left to CI), tests proven (tests-proven.ts), the break check (break-check.ts), database policies and the
// browser checks, the database ones one run at a time and only while no worker runs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { join } from "node:path";
import { noWorkerRunning } from "./running-workers";
import { onSharedStack } from "./shared-stack";
import { AT_ONCE, LEAVE_AT_ONCE } from "./tests-ran";

type Check = {
  name: string;
  cmd: [string, ...string[]];
  db?: true;
  browser?: true;
  /** What the gate's summary line says of it, from what it printed in `repo`; `tally` without one. */
  said?: (out: string, repo: string) => string;
};

export const CHECKS: Check[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"] },
  { name: "lint", cmd: ["bun", "run", "lint"] },
  { name: "guards", cmd: ["bun", "run", "guards"] },
  {
    name: "tests",
    // Four whole-suite runs and a demo at once would load the Mac five times over: CI's required `checks` runs that
    // test before every merge, which waits for it (merge-gate.ts). The summary says so wherever the checkout holds that
    // test, and never counts it passed.
    cmd: ["bun", "run", "local", "bun", "run", "gate", "tests", LEAVE_AT_ONCE],
    db: true,
    said: (out, repo) =>
      existsSync(join(repo, AT_ONCE))
        ? `${tally("tests", out)} (not run here, left to CI: ${AT_ONCE})`
        : tally("tests", out),
  },
  {
    name: "tests proven",
    cmd: ["bun", "run", "local", "bun", "run", "gate", "proven"],
    db: true,
  },
  {
    name: "break check",
    cmd: ["bun", "run", "local", "bun", "run", "gate", "broken"],
    db: true,
    // How many lines it broke, or just its name when it broke none.
    said: (out) =>
      out.match(/^Break check ✓ (\d+ line\(s\) broken.+?) \(\d+ break/m)?.[1] ??
      "break check",
  },
  { name: "database policies", cmd: ["bun", "run", "rls:check"], db: true },
  {
    name: "browser checks",
    cmd: ["bun", "run", "local", "bun", "run", "gate", "tests", "e2e"],
    db: true,
    browser: true,
  },
];

const reachable = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createConnection({ port, host: "127.0.0.1", timeout: 500 });
    const end = (up: boolean) => {
      s.destroy();
      done(up);
    };
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
    s.once("timeout", () => end(false));
  });

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => done(port));
    });
  });

export function run(
  repo: string,
  [bin, ...args]: [string, ...string[]],
  env: Record<string, string> = {},
) {
  const r = spawnSync(bin, args, {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });
  return {
    status: r.status ?? 1,
    out: Bun.stripANSI(`${r.stdout ?? ""}${r.stderr ?? ""}`),
  };
}

/** Browser runs start fresh servers (CI=1) and put the worker on a free port. */
export const browserEnv = async () => ({
  PORT: String(await freePort()),
  CI: "1",
});

export const tail = (out: string, lines = 60) =>
  out.trimEnd().split("\n").slice(-lines).join("\n");
export const tally = (name: string, out: string) => {
  const n = out.match(/(\d+) pass(ed)?\b/)?.[1];
  return n ? `${n} ${name}` : name;
};

// Docker is looked up on the PATH scripts/done-gate.ts sets, which only a call handing over `env` uses.
const docker = (arg: string) =>
  spawnSync("docker", [arg], { stdio: "ignore", env: process.env });
/** No Docker on this machine: `docker` is missing, or can't even say its version. */
export const noDocker = () => {
  const r = docker("--version");
  return r.error !== undefined || r.status !== 0;
};

/**
 * `complete`: every check ran. With `db` false (no Docker here, or background work running) the checks on the
 * database are left out; not-run.ts says why.
 */
export async function runChecks(
  repo: string,
  db = true,
): Promise<{ ok: boolean; text: string; complete?: boolean }> {
  if (db && !(await reachable(54322)))
    return {
      ok: false,
      text:
        docker("info").status === 0
          ? "the local database is not running, so the tests can't run. Start it with `supabase start`, then stop again."
          : "Docker is installed but not running, so the tests can't run. Start Docker Desktop, then `supabase start`, then stop again.",
    };
  const passed: string[] = [];
  /** The first failure, or nothing when every check passes. */
  const runEach = async (checks: Check[]) => {
    for (const c of checks) {
      const r = run(repo, c.cmd, c.browser ? await browserEnv() : {});
      if (r.status !== 0)
        return `${c.name} failed (\`${c.cmd.join(" ")}\`):\n${tail(r.out)}`;
      passed.push(c.said?.(r.out, repo) ?? tally(c.name, r.out));
    }
  };
  const onDb = CHECKS.filter((c) => c.db);
  const failed =
    (await runEach(CHECKS.filter((c) => !c.db))) ??
    (db
      ? await onSharedStack(repo, () => {
          noWorkerRunning(); // within the lock: the browser checks of another checkout's gate start one
          return runEach(onDb);
        }).catch(
          (e: Error) =>
            `${onDb.map((c) => c.name).join(", ")} did not run: ${e.message}`,
        )
      : undefined);
  if (failed) return { ok: false, text: failed };
  return { ok: true, text: passed.join(", "), complete: db };
}
