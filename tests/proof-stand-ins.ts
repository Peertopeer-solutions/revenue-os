// What the proof steps' tests share (scripts/proof-slice-0*.test.ts, scripts/proof-on-mac.test.ts): scratch folders
// removed after the file's tests, the repository the steps prove (this checkout as it is on disk, as one commit),
// copies of it, the steps run as `bun run proof 0` runs them, and a stand-in `claude` that answers as Claude Code does,
// so no test uses a real model, key or login. A file using them calls removeScratch in its afterAll.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSteps } from "../scripts/proof/run";
import type { Step } from "../scripts/proof/step";

export const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
export const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};
export const KEY =
  "A second Anthropic key for the automatic test conversations";
export const STATE = `PHASE: SETUP\n\n## Waiting on Devesh\n- [ ] **${KEY}**: saved in GitHub as ANTHROPIC_EVALS_KEY\n## Decisions in force\n`;
/** git in `dir` (its background clean-up off, as scripts/proof/scratch.ts has it): its output; throws when it fails. */
export const git = (dir: string, ...args: string[]) => {
  const r = spawnSync(
    "git",
    ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
let here: string | undefined;
/** Removes every scratch folder made so far, the proved repository too: each test file calls it in its afterAll. */
export const removeScratch = () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  here = undefined;
};
/**
 * The repository the steps prove: this checkout's files as they are on disk (those git would track), as one commit,
 * which is also its origin/main. A step proves a commit (it clones it, or archives its gate), and this checkout's may
 * not hold what is on disk: the tests-proven check runs this file with a change copied over main's commit,
 * uncommitted. Nothing is fetched from this checkout, which may be shallow (on GitHub's runner the check's copy was,
 * and git then writes no fetched ref, though the fetch succeeds); its packages are this checkout's, for the tests the
 * steps run by name.
 */
export const HERE = () => {
  if (here) return here;
  const dir = scratch("proof-0-here-");
  git(dir, "init", "-q", "-b", "main");
  const listed = git(
    ROOT,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  );
  for (const f of new Set(listed.split("\0").filter(Boolean))) {
    const from = join(ROOT, f);
    const st = lstatSync(from, { throwIfNoEntry: false });
    if (!st?.isFile() && !st?.isSymbolicLink()) continue; // deleted, or another repository's folder
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), join(dir, f));
    else copyFileSync(from, join(dir, f));
  }
  git(dir, "add", "-A", "-f");
  git(
    dir,
    "-c",
    "user.email=proof@example.invalid",
    "-c",
    "user.name=proof",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "this checkout as it is on disk",
  );
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  if (existsSync(join(ROOT, "node_modules")))
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  here = dir;
  return dir;
};
export const prove = (
  steps: Step[],
  root = HERE(),
  env: NodeJS.ProcessEnv = {},
) =>
  runSteps(steps, {
    root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    state: STATE,
    dir: scratch("proof-0-report-"),
  });
export const failures = (
  results: { does: string; outcome: string; seen: string }[],
) =>
  results.flatMap((r) =>
    r.outcome === "passed" ? [] : [`${r.does}\n  ${r.seen}`],
  );
/** A scratch copy of the proved repository's commit with `edit` applied and committed, as `main`. */
export const copyOf = (
  edit: (dir: string) => void,
  message = "a changed copy",
) => {
  const dir = scratch("proof-0-copy-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "fetch", "-q", "--no-tags", HERE(), "+HEAD:refs/proof/base");
  git(dir, "checkout", "-q", "-B", "main", "refs/proof/base");
  edit(dir);
  spawnSync(
    "git",
    [
      "-c",
      "user.email=proof@example.invalid",
      "-c",
      "user.name=proof",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qam",
      message,
    ],
    { cwd: dir },
  );
  return dir;
};

export type Answer = {
  when?: string;
  first?: string;
  say: string;
  error?: boolean;
};
/**
 * A stand-in `claude` that logs each call (its arguments, key, GitHub token, home and folder) and answers as
 * `claude -p --output-format stream-json` does: the first answer whose `when` the prompt (its last argument) holds,
 * after running `first` in its folder (`error`: as Claude Code reports an error from Anthropic's API).
 */
export const standIn = (answers: Answer[]) => {
  const bin = scratch("proof-0-claude-");
  const log = join(bin, "calls.txt");
  const events = (text: string, error = false) =>
    [
      { type: "system", subtype: "init", session_id: "stand-in" },
      { type: "assistant", message: { content: [{ type: "text", text }] } },
      {
        type: "result",
        subtype: "success",
        is_error: error,
        session_id: "stand-in",
        result: text,
      },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join("");
  const cases = answers.map((a, i) => {
    writeFileSync(join(bin, `answer-${i}.txt`), events(a.say, a.error));
    return `  *"${a.when ?? ""}"*) ${a.first ?? ":"} >/dev/null 2>&1; cat "${join(bin, `answer-${i}.txt`)}" ;;`;
  });
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `{ echo "args: $*"; echo "token: $CLAUDE_CODE_OAUTH_TOKEN"; echo "api key: \${ANTHROPIC_API_KEY:-none}"; echo "scrub: \${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-off}"; echo "gh: \${GH_TOKEN:-none}"; echo "home: $HOME"; echo "cwd: $(pwd)"; } >> "${log}"`,
      "for last; do :; done",
      'case "$last" in',
      ...cases,
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    env: { PATH: `${bin}:${process.env.PATH}` },
    calls: () =>
      existsSync(log) ? readFileSync(join(bin, "calls.txt"), "utf8") : "", // the log above
  };
};
