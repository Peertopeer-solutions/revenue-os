// Runs git for the gate: its output trimmed, and a clear error when git fails unless failing is allowed.

import { spawnSync } from "node:child_process";

/**
 * git's own answer, untrimmed. Under load Bun 1.3.11's synchronous spawn can hand back a git that succeeded with no
 * output at all (oven-sh/bun#34069; the fix, oven-sh/bun#40078, is in no release yet), and the gate would read that
 * as "nothing there": no change, no file, no product code. So an answer that comes back empty is asked for once
 * more; every lost answer asked again at once under load came back whole. (A full memory clean-up before each
 * spawn, as tests/setup.local.ts does against the freeze, lost about 3.5 times as many answers.) Remove the second ask
 * once the pinned Bun has the fix.
 */
export function gitAnswer(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeout?: number, // milliseconds, for a question that goes over the network
) {
  const ask = () =>
    spawnSync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 256 << 20,
      timeout,
    });
  const r = ask();
  return r.status === 0 && !r.stdout ? ask() : r;
}

export function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  mayFail = false,
): string {
  const r = gitAnswer(cwd, args, env);
  if (r.status !== 0 && !mayFail)
    throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.status === 0 ? r.stdout.trim() : "";
}
