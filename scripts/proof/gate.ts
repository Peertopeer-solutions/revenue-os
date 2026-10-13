// The proved checkout's done gate, driven in a scratch copy the way agents' tools and CI drive it: its hook before a
// command and at a stop, as Claude Code runs it; main's copy of the pull request check, as rules-from-main runs it;
// a stand-in GitHub for its merge check, which the gate's own tests use too; and its record of checks that passed, as
// a passing `bun run gate` leaves it.

import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "../done-gate/snapshot";
import { Store, stateDir } from "../done-gate/store";
import { git, plainEnv, sh, write } from "./scratch";
import { timeLeft } from "./time-limit";

export type Told = {
  refused: boolean; // a command or edit refused before it ran
  sentBack: boolean; // a stop sent back to work
  why: string; // what the agent is told
  told: string; // what Devesh is told
  context: string; // what a session is shown when it starts
};

/**
 * The gate's hook in `dir`, as Claude Code runs it for `event`: the input on stdin, for session `o.session`, started
 * with `o.bun` (and its options `o.args`) and the PATH and home folder only (plus `o.env`), stopped when the step's
 * time is up.
 */
export function hook(
  dir: string,
  event: string,
  input: Record<string, unknown> = {},
  o: {
    env?: Record<string, string>;
    session?: string;
    bun?: string;
    args?: string[];
  } = {},
): Told {
  const r = spawnSync(
    o.bun ?? "bun",
    [...(o.args ?? []), join(dir, "scripts", "done-gate.ts"), "hook"],
    {
      cwd: dir,
      env: plainEnv(o.env),
      input: JSON.stringify({
        hook_event_name: event,
        session_id: o.session ?? "proof-1",
        cwd: dir,
        ...input,
      }),
      encoding: "utf8",
      timeout: timeLeft(),
    },
  );
  let out: {
    decision?: string;
    reason?: string;
    systemMessage?: string;
    hookSpecificOutput?: Record<string, string>;
  } = {};
  try {
    out = r.stdout?.trim() ? JSON.parse(r.stdout) : {};
  } catch {
    out = { systemMessage: r.stdout };
  }
  return {
    refused: out.hookSpecificOutput?.permissionDecision === "deny",
    sentBack: out.decision === "block" || r.status === 2,
    why:
      out.hookSpecificOutput?.permissionDecisionReason ??
      out.reason ??
      r.stderr ??
      "",
    told: out.systemMessage ?? "",
    context: out.hookSpecificOutput?.additionalContext ?? "",
  };
}

/** A shell command, as an agent's Bash tool hands it to the hook. */
export const bash = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
});

/** What a refusal says, in one line for the report. */
export const said = (t: Told) =>
  (t.told || t.why || "(nothing)").split("\n")[0] ?? "";

/**
 * Main's copy of the pull request check (`bun scripts/done-gate.ts pr`), run from `dir` with main checked out, on
 * `head` as data, with `body` as the pull request's body and 9999 as its number.
 */
export const judged = (dir: string, body: string, head = "feat") =>
  sh(
    dir,
    ["bun", "scripts/done-gate.ts", "pr", "--base", "main", "--head", head],
    {
      PR_BODY: body,
      PR_NUMBER: PR,
    },
  );
export const PR = "9999";

/** The done rules alone on `head`, as CI's `bun run gate rules` and every stop run them. */
export const rules = (dir: string, head = "feat") =>
  sh(dir, [
    "bun",
    "scripts/done-gate.ts",
    "rules",
    "--base",
    "main",
    "--head",
    head,
  ]);

/** Records that every check passed on `dir`'s code as it is (`partial`: all but the database ones, as without Docker). */
export function checksPassed(dir: string, kind = "checked") {
  new Store(stateDir(dir)).put(
    kind,
    snapshot(dir, false).tree,
    "typecheck, lint, guards, tests (recorded as passed by the proof)",
  );
}

/** A check run as GitHub's API lists it. */
export type Run = {
  name?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  app?: { id?: number };
};
/** `checks` completed with success by GitHub Actions (the app main's ruleset requires) on `sha`, `over` changed. */
export const checksRun = (sha: string, over: Run = {}): Run => ({
  name: "checks",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  app: { id: 15368 },
  ...over,
});

/**
 * A stand-in GitHub in `bin` for `dir`'s merge check, and the settings its hook needs to reach it: `gh pr view` names
 * `head`; `gh api` answers `runs` (by default `checks` passed on `head`; null: GitHub can't be asked) and, for main's
 * rules, whether they hold a merge queue (`queue`; by default not; null: GitHub can't be asked); `git ls-remote
 * origin` reads `main` (a commit of `dir`; by default its main) as main's tip, from a local copy at the origin's
 * owner/name, where `dir`'s origin address leads. `dir` gets an origin at an address that never resolves when it has
 * none. Nothing reaches the network. `calls` lists every gh call.
 */
export function standInGitHub(
  dir: string,
  bin: string,
  head: string,
  o: { runs?: Run[] | null; main?: string; queue?: boolean | null } = {},
) {
  const named = sh(dir, ["git", "remote", "get-url", "origin"]);
  const origin =
    named.status === 0
      ? named.stdout.trim()
      : "https://example.invalid/o/r.git";
  if (named.status !== 0) git(dir, "remote", "add", "origin", origin);
  const copy = join(bin, "github", ...origin.split("/").slice(-2));
  git(dir, "init", "-q", "--bare", copy);
  git(dir, "push", "-q", copy, `${o.main ?? "main"}:refs/heads/main`);
  const runs = o.runs === undefined ? [checksRun(head)] : o.runs;
  write(bin, "answer.json", JSON.stringify({ check_runs: runs ?? [] }));
  const rules = o.queue
    ? [{ type: "pull_request" }, { type: "merge_queue" }]
    : [{ type: "pull_request" }];
  write(bin, "rules.json", JSON.stringify(rules));
  const failed = "echo 'HTTP 502' >&2; exit 1";
  const log = join(bin, "calls.txt");
  write(
    bin,
    "gh",
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  pr*) echo ${head} ;;\n  api*/rules/branches/*) ${o.queue === null ? failed : `cat "${join(bin, "rules.json")}"`} ;;\n  api*) ${runs ? `cat "${join(bin, "answer.json")}"` : failed} ;;\nesac\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${copy}.insteadOf`,
      GIT_CONFIG_VALUE_0: origin,
    },
    calls: () =>
      sh(bin, ["cat", log]).stdout.trim().split("\n").filter(Boolean),
  };
}
