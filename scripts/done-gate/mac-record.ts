// Slice 0's two AI steps (the scripted fresh agent session and the verifier's run) run on Devesh's Mac with his own
// Claude login (`bun run proof 0 --on-my-mac`), never on GitHub with an Anthropic key. That run writes a record:
// the commit, the date, each step's result and a fingerprint of every file those steps test (git's id of each
// file's content), committed with the transcripts by a pull request. GitHub's proof run, `bun run cycle --banner`
// and rules-from-main all judge that record against the files as a commit has them, by this file.

import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { git, gitAnswer } from "./git";
import type { Outcome } from "./proof-run";

export const AI_SLICE = 0;
export const RECORD_DIR = "docs/proof/slice-0-ai";
export const RECORD = `${RECORD_DIR}/record.json`;
/** The two steps, by the names the record and their transcripts use. */
export const AI_STEPS = ["agent-session", "verifier"] as const;
export type AiStep = (typeof AI_STEPS)[number];
/** What a step waits on when no record holds: the proof report and the banner both say it. */
export const AGAIN = "run the AI steps again on Devesh's Mac";
export const MAC_COMMAND = "bun run proof 0 --on-my-mac";

// The files those steps test: the law files the session reads, the hooks' settings, the verifier's instructions and
// the steps' own code; then every script those name (the banner's and the done gate's), each file of the done gate's
// folder, and every file any of them imports, followed at the commit itself, so the list cannot fall behind the code.
// Tests change nothing a session sees, so they are left out.
const START = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/agents/verifier.md",
  "scripts/proof/slice-0-agents.ts",
];
const GATE = /^scripts\/done-gate\/[^/]+$/;
const SCRIPT = /\bscripts\/[\w./-]+\.(?:ts|sh)\b/g;
const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["'](\.{1,2}\/[^"']+)["']/gm;
const TEST = /\.test\.[jt]sx?$/;

export type MacRecord = {
  commit: string;
  date: string; // YYYY-MM-DD
  claude: string; // `claude --version` on the Mac
  steps: { name: AiStep; outcome: Outcome; seen: string }[];
  files: { [path: string]: string }; // each tested file → git's id of its content
};

/** The text of each blob `ids` names, read in one `git cat-file --batch` (asked again if the answer comes back empty). */
function blobs(root: string, ids: string[]) {
  const ask = () =>
    spawnSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: `${ids.join("\n")}\n`,
      maxBuffer: 256 << 20,
    });
  let r = ask();
  if (r.status === 0 && !r.stdout.length) r = ask();
  if (r.status !== 0 || !r.stdout.length)
    throw new Error(`git cat-file failed: ${String(r.stderr).trim()}`);
  const out: Buffer = r.stdout;
  const text = new Map<string, string>();
  for (let at = 0; at < out.length; ) {
    const nl = out.indexOf(10, at);
    const [id = "", , size = "0"] = out.subarray(at, nl).toString().split(" ");
    text.set(id, out.subarray(nl + 1, nl + 1 + Number(size)).toString());
    at = nl + 2 + Number(size);
  }
  return text;
}

/** PURE: the files `path`'s text names: the scripts it runs and the files it imports, as paths in the repository. */
export function named(path: string, text: string, has: (p: string) => boolean) {
  // the scripts a hook command runs: named in the settings and the shell scripts, never in a comment in code
  const found = /\.(json|sh)$/.test(path)
    ? [...text.matchAll(SCRIPT)].map((m) => m[0])
    : [];
  for (const [, rel = ""] of text.matchAll(IMPORT)) {
    const base = posix.normalize(posix.join(posix.dirname(path), rel));
    const file = [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`].find(
      (f) => /\.[jt]s$/.test(f) && has(f),
    );
    if (file) found.push(file);
  }
  return found.filter((f) => has(f) && !TEST.test(f));
}

/** Each file the AI steps test at `rev` in `root` → git's id of its content. */
export function fingerprints(root: string, rev: string) {
  const ids = new Map<string, string>();
  for (const line of git(root, ["ls-tree", "-r", "-z", rev]).split("\0")) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s);
    if (m?.[1] && m[2]) ids.set(m[2], m[1]);
  }
  const has = (p: string) => ids.has(p);
  const files: { [path: string]: string } = {};
  let next = [
    ...START,
    ...[...ids.keys()].filter((p) => GATE.test(p) && !TEST.test(p)),
  ].filter(has);
  while (next.length) {
    for (const p of next) files[p] = ids.get(p) ?? "";
    const text = blobs(
      root,
      next.map((p) => ids.get(p) ?? ""),
    );
    next = [
      ...new Set(
        next.flatMap((p) => named(p, text.get(ids.get(p) ?? "") ?? "", has)),
      ),
    ].filter((p) => !(p in files));
  }
  if (!Object.keys(files).length)
    throw new Error(`${rev} holds none of the files the AI steps test`);
  return files;
}

const listed = (paths: string[]) =>
  `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}`;

export type Judged = { outcome: Outcome; seen: string };

/**
 * PURE: what `record` (the record file's text, or nothing when there is none) says about `step` (every step when none
 * is named) on `files` (fingerprints of the commit judged). It waits on Devesh's Mac when there is no record, when a
 * file it tests changed since, or when the step is missing or waited there; it fails when the step failed there.
 */
export function judged(
  record: string | undefined,
  files: { [path: string]: string },
  step?: AiStep,
): Judged {
  const waiting = (seen: string): Judged => ({ outcome: "waiting", seen });
  if (record === undefined) return waiting(`${RECORD} is not committed`);
  let r: Partial<MacRecord>;
  try {
    r = JSON.parse(record);
  } catch {
    return { outcome: "failed", seen: `${RECORD} is not JSON` };
  }
  const had = r.files ?? {};
  const changed = Object.keys({ ...had, ...files })
    .filter((p) => had[p] !== files[p])
    .sort();
  if (changed.length)
    return waiting(
      `${changed.length} file(s) those steps test changed since its run on ${r.date} at ${String(r.commit).slice(0, 7)}: ${listed(changed)}`,
    );
  const seen: string[] = [];
  for (const name of step ? [step] : AI_STEPS) {
    const got = r.steps?.find((s) => s.name === name);
    if (!got) return waiting(`${RECORD} has no ${name} step`);
    if (got.outcome !== "passed")
      return {
        outcome: got.outcome,
        seen: `the ${name} step ${got.outcome} on Devesh's Mac on ${r.date} at ${String(r.commit).slice(0, 7)}: ${got.seen}`,
      };
    seen.push(got.seen);
  }
  return {
    outcome: "passed",
    seen: `passed on Devesh's Mac on ${r.date} at ${String(r.commit).slice(0, 7)} (Claude Code ${r.claude}; ${RECORD}, transcripts in ${RECORD_DIR}/), and every file it tests is as that run had it: ${seen.join("; ")}`,
  };
}

/** What `rev`'s committed record says about its own files (for `step`, or both steps). */
export function judgedAt(root: string, rev: string, step?: AiStep) {
  const shown = gitAnswer(root, ["show", `${rev}:${RECORD}`]);
  return judged(
    shown.status === 0 ? shown.stdout : undefined,
    fingerprints(root, rev),
    step,
  );
}

/** The first line of the pull request that commits a run's record: off-roadmap work, as it builds nothing. */
export const RECORD_PR =
  "Roadmap: off-roadmap — Slice 0's AI steps, run on Devesh's Mac";

/** PURE: what `bun run cycle --banner` says about main's record, when it does not stand for main's files. */
export const bannerLine = ({ outcome, seen }: Judged) =>
  outcome === "passed"
    ? undefined
    : `Slice ${AI_SLICE}'s two AI steps (the scripted agent session and the verifier's run): ${outcome === "failed" ? "one FAILED on Devesh's Mac" : AGAIN}: ${seen}. Ask Devesh to run \`${MAC_COMMAND}\` in his own terminal with the local stack up, signed in through the token \`claude setup-token\` makes (he keeps it out of every chat); then commit what it writes in ${RECORD_DIR}/ in a pull request whose first line is "${RECORD_PR}".`;
