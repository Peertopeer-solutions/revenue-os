// Scratch copies of the checkout being proved, for the proof steps that change code or run the gate on it: a clone
// whose `main` and origin/main are the proved commit, or a small repository holding only that commit's gate. Each
// step makes its own and removes it, whatever happens. Nothing in them can reach GitHub: their origin is an address
// that never resolves. Commands in them get only the PATH and home folder, never a token or key the run holds,
// except the scripted Claude Code session on Devesh's Mac, which gets his Claude login token alone, kept from the
// commands it runs (claude.ts).

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { timeLeft } from "./time-limit";

export const ORIGIN = "https://example.invalid/proof/revenue-os.git";

/** What a scratch command runs with: the PATH and home folder (plus `extra`), never a token or key. */
export const plainEnv = (extra: Record<string, string | undefined> = {}) =>
  Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...extra,
    }).filter((e): e is [string, string] => e[1] !== undefined),
  );

/** Runs `cmd` in `dir`, stopped when the step's time is up: its exit status and what it printed, both streams together. */
export function sh(
  dir: string,
  cmd: string[],
  env: Record<string, string | undefined> = {},
  input?: string,
) {
  const r = spawnSync(cmd[0] ?? "", cmd.slice(1), {
    cwd: dir,
    env: plainEnv(env),
    input,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    timeout: timeLeft(),
  });
  return {
    status: r.status ?? 1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
    stdout: r.stdout ?? "",
  };
}

/**
 * git in `dir`; its output, or an error saying what failed. git's automatic clean-up is off: newer git runs it in
 * the background after a fetch or commit, and a clone of that repository a moment later failed copying the lock
 * file the clean-up held (seen on GitHub's runner, git 2.55).
 */
export function git(dir: string, ...args: string[]) {
  const r = sh(dir, [
    "git",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    ...args,
  ]);
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.out.trim()}`);
  return r.stdout.trim();
}

export const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

/** Commits everything in `dir`, as the proof; the new commit's id. */
export const commit = (dir: string, message: string) => {
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.email=proof@example.invalid",
    "-c",
    "user.name=Slice 0 proof",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  );
  return git(dir, "rev-parse", "HEAD");
};

export type Scratch = { dir: string; main: string; base: string };

/** A clone of `root` as committed, its `main` and origin/main at the proved commit, inside a folder of its own. */
function cloneOf(root: string): Scratch {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "proof-")));
  const dir = join(base, "repo");
  git(base, "init", "-q", "-b", "main", dir);
  git(dir, "fetch", "-q", "--no-tags", root, "+HEAD:refs/proof/proved"); // a ref of its own, not FETCH_HEAD
  git(dir, "checkout", "-q", "-B", "main", "refs/proof/proved");
  git(dir, "remote", "add", "origin", ORIGIN);
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { dir, main: git(dir, "rev-parse", "HEAD"), base };
}

/**
 * A repository holding only the gate of `root` as committed (scripts/done-gate.ts, scripts/done-gate/ and the
 * tracker's parser it reads ROADMAP.md with) plus `files`, committed as `main` and origin/main: for a step that
 * runs the whole test suite, which in a clone of the product would take minutes.
 */
function gateOf(root: string, files: Record<string, string>): Scratch {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "proof-gate-")));
  const dir = join(base, "repo");
  mkdirSync(dir);
  const archive = sh(root, [
    "git",
    "archive",
    "--format=tar",
    "-o",
    join(base, "gate.tar"),
    "HEAD",
    "scripts/done-gate.ts",
    "scripts/done-gate",
    "docs/tracker",
  ]);
  if (archive.status !== 0)
    throw new Error(`could not copy the gate: ${archive.out.trim()}`);
  sh(dir, ["tar", "-xf", join(base, "gate.tar")]);
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", ORIGIN);
  const main = commit(dir, "main");
  git(dir, "update-ref", "refs/remotes/origin/main", main);
  return { dir, main, base };
}

/** Runs `work` in a fresh scratch copy (a clone of `root`, or with `gate` its gate alone), then removes it. */
export async function inScratch<T>(
  root: string,
  work: (s: Scratch) => T | Promise<T>,
  gate?: Record<string, string>,
): Promise<T> {
  const s = gate ? gateOf(root, gate) : cloneOf(root);
  try {
    return await work(s);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
}
