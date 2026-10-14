// `bun run cycle` — where we are in ROADMAP.md, printed so no agent has to remember it. The agent
// hooks (.claude/settings.json and .codex/hooks.json, through scripts/cycle-hook.sh) show it to
// every session, so the plan survives /clear, compaction and off-topic prompts.
//   --check   (default) format problems in this checkout's ROADMAP.md, STATE.md and record files; exit 1 if any
//   --banner  session start, resume, /clear, compaction: fetch main, then the whole picture
//   --pin     every prompt: one line
// --banner and --pin read the plan from origin/main (a build branch ticks its own item before it
// merges) and always exit 0: hooks drop a failing command's output, so they print CYCLE UNKNOWN.
// The branch is the one of the folder the agent works in: Claude Code and Codex send the hook's
// input as JSON on stdin with a "cwd" field; with no usable cwd it is this script's own checkout.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentSlice,
  nextItem,
  parseRoadmap,
  parseState,
  plain,
} from "../docs/tracker/parse.js";
import { type Latest, proofLines, readLatest } from "./proof/latest";

export type Cycle = {
  roadmap: string;
  state: string;
  branch: string;
  item: string; // what this branch builds: git config branch.<name>.description (AGENTS.md → The loop, step 2)
  from: string;
  branchRoadmap?: string; // ROADMAP.md in the agent's folder: a replan adds its line there before it merges
  proofRuns?: Latest[] | string; // --banner: each proof-ready or done slice's latest proof run, or why gh could not read them
};

const ROOT = join(import.meta.dir, "..");
const unknown = (why: string) =>
  `CYCLE UNKNOWN: ${why}. Read ROADMAP.md and fix it before any other work.`;
const cut = (s: string, n = 100) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

// A branch description is a roadmap item's text, "Side track: <what>" or "Off-roadmap: <what>"
// (near misses such as "Side-track -" or "off roadmap:" count). Anything else: undefined. The
// item's text matches ignoring case, spacing, Markdown marks and quotes: in the documented
// `git config … "<text>"` the shell runs a backticked command, so agents leave backticks out.
function kindOf(c: Cycle) {
  const m = c.item.match(/^(side[\s-]*track|off[\s-]*roadmap)\s*[:—–-]\s*/i);
  if (m) {
    const what = c.item.slice(m[0].length);
    const kind = /^side/i.test(c.item) ? "Side-track work" : "off-roadmap work";
    return what ? { kind, what, onRoadmap: false } : undefined;
  }
  const known = [c.roadmap, c.branchRoadmap ?? ""].some((md) =>
    parseRoadmap(md).slices.some((s) =>
      s.items.some((i) => plain(i.text) === plain(c.item)),
    ),
  );
  return known
    ? { kind: "roadmap item", what: c.item, onRoadmap: true }
    : undefined;
}
const record = (name: string) =>
  `git config branch.${name}.description "<roadmap item text>" (without its backticks, which the shell would run; or "Side track: <what>" for marketing-site work, "Off-roadmap: <what>" for an off-roadmap PR)`;

export const problems = (roadmap: string, state: string) => [
  ...parseRoadmap(roadmap).problems,
  ...parseState(state).problems,
];

function where(c: Cycle) {
  const { slices } = parseRoadmap(c.roadmap);
  const cur = currentSlice(slices);
  return { slices, cur, next: nextItem(cur) };
}

export function pin(c: Cycle): string {
  const { slices, cur, next } = where(c);
  if (!slices.length) return unknown("no slices found in ROADMAP.md");
  const k = kindOf(c);
  const mine = !c.item
    ? `${c.branch || "this checkout"} has no roadmap item`
    : k
      ? `this branch builds ${k.kind} "${cut(k.what)}"`
      : `this branch's description "${cut(c.item, 40)}" matches no roadmap item (fix: AGENTS.md step 2)`;
  const now = !cur
    ? "no slice can be built now (each waits on Devesh)"
    : `current: Slice ${cur.n} (${cur.title}), ${next ? `next item "${cut(next.text)}"` : "no agent items left"}`;
  return `CYCLE: ${mine} · ${now}. New ask: AGENTS.md → The loop, step 1 (question: answer only; not repo work: outside the repo, never committed; marketing site: Side track; item in a later slice: replan it into this one; other build: ask "off-roadmap PR, or replan?" unless Devesh already picked; one off-roadmap PR open at most).`;
}

export function banner(c: Cycle): string {
  const { slices, cur, next } = where(c);
  if (!slices.length) return unknown("no slices found in ROADMAP.md");
  const { phase } = parseState(c.state);
  const found = problems(c.roadmap, c.state);
  const name = c.branch && c.branch !== "main" ? c.branch : "<name>";
  const k = kindOf(c);
  const lines = [
    `CURRENT CYCLE, read from ROADMAP.md on ${c.from}. The plan lives in the repo, not in this chat.`,
    `Phase: ${phase} (${phase === "SETUP" ? "agents may merge on observed-green checks" : "only humans merge"}; STATE.md line 1).`,
    cur
      ? `Current slice: Slice ${cur.n}: ${cur.title} (${cur.Status}, ${cur.items.filter((i) => i.done).length} of ${cur.items.length} items done).\nProof (a script runs it; the slice is done when every step passes): ${cur.Proof ?? ""}\nNext item: ${next ? next.text : "none left for agents. Set the slice to proof ready and run its proof (AGENTS.md → Definition of done)."}`
      : "No slice can be built now: each unfinished slice is proof ready (run its proof: when every step passes, set it to done; when one fails, add an item naming the failure) or blocked. Tell Devesh what blocks it; do not start other work.",
    ...proofLines(slices, c.proofRuns),
    !c.item
      ? `${c.branch ? `This branch (${c.branch})` : "This checkout"} has no roadmap item. Build only on a branch made for one item, off origin/main, and record it: ${record(name)}.`
      : !k
        ? `This branch (${c.branch}) records "${c.item}", which is neither the text of an item in ROADMAP.md nor "Side track: <what>" or "Off-roadmap: <what>". Fix the record before building: ${record(name)}.`
        : k.onRoadmap
          ? `This branch (${c.branch}) builds the roadmap item: ${c.item}`
          : `This branch (${c.branch}) builds ${k.kind}: ${k.what}. It has no roadmap line to tick; the PR body's what / why / evidence is the record.`,
    'New asks (AGENTS.md → The loop, step 1). A question or look-up: answer it; no branch switch, no code. Work that does not belong in the repo (prospect lists, videos, research, naming, data about real people; fake seed and test data is fine): do it in a scratch folder outside the repo, never commit it, no branch. Marketing-site work: the Side track, no replan, one open PR at most. An item already on the roadmap in a later slice: a replan that moves its line into the current slice in the same PR. Any other build ask: reply "off-roadmap PR, or replan?" and build nothing until Devesh picks; a message that already starts with "off-roadmap" or "replan" has picked. At most one off-roadmap PR is open at a time: if one is open, link it and ask Devesh to merge or close it, or to replan.',
    'Every PR body starts with "Roadmap: Slice N — <item>", "Roadmap: Slice N — replan: <what>", "Roadmap: Side track — <what>" or "Roadmap: off-roadmap — <what>" (AGENTS.md → The loop, step 4), and answers each docs/fix-when-touched.md entry whose area it touches with `Fix-when-touched: <entry number> · fixed | not applicable · <how or why>`; `rules-from-main` refuses it otherwise.',
    'Done means seen working (AGENTS.md → Definition of done). A slice is done when its proof runs and passes: the agent writes the date and the passing run\'s link after "Proof passed:", and `rules-from-main` checks that link.',
  ];
  if (found.length)
    lines.push(
      "Format problems in ROADMAP.md or STATE.md; fix them first:",
      ...found.slice(0, 5).map((p) => `- ${p}`),
    );
  return lines.join("\n");
}

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

// null when git fails, times out, or the folder does not exist
function git(cwd: string, ...args: string[]): string | null {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    env,
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The session-start fetch gets 5 s. git leaves the network to helpers (git remote-https, ssh) that
// outlive a kill of git alone, so the fetch runs in its own process group and a timeout stops the
// whole group (with SIGTERM, so git still removes its lock files). Being its own group, it misses
// a Ctrl-C at the terminal, so a Ctrl-C (or a kill) of this script stops the group first.
async function fetchMain(): Promise<boolean> {
  try {
    const p = Bun.spawn(["git", "fetch", "--quiet", "origin", "main"], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const stop = () => {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {} // already gone
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const unhook = () => {
      for (const s of signals) process.off(s, quit);
    };
    const quit = (s: NodeJS.Signals) => {
      stop();
      unhook();
      process.kill(process.pid, s); // then die of that signal, as without this handler
    };
    for (const s of signals) process.on(s, quit);
    const code = await Promise.race([
      p.exited,
      Bun.sleep(5000).then(() => null),
    ]);
    unhook();
    if (code === null) stop();
    return code === 0;
  } catch {
    return false;
  }
}

// The hook's cwd when it is a checkout of this same repository (any worktree), else ROOT. A run
// from a terminal skips stdin; a pipe that stays open is given up on after half a second.
async function workDir(): Promise<string> {
  if (process.stdin.isTTY) return ROOT;
  const input = await Promise.race([
    Bun.stdin.text(),
    Bun.sleep(500).then(() => ""),
  ]);
  let cwd: unknown;
  try {
    cwd = JSON.parse(input)?.cwd;
  } catch {
    return ROOT;
  }
  if (typeof cwd !== "string") return ROOT;
  const repo = (dir: string) =>
    git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const theirs = repo(cwd);
  return theirs !== null && theirs === repo(ROOT) ? cwd : ROOT;
}

if (import.meta.main) {
  const flag = process.argv[2] ?? "--check";
  const local = (f: string) => readFileSync(join(ROOT, f), "utf8");
  if (flag === "--check") {
    const found = [
      ...problems(local("ROADMAP.md"), local("STATE.md")),
      // Read only here: the hooks run --pin on every prompt, and need none of it.
      ...(await import("./records")).records(ROOT).problems,
    ];
    for (const p of found) console.error(p);
    console.log(
      found.length
        ? `${found.length} format problem(s) in ROADMAP.md, STATE.md or the records`
        : "ROADMAP.md, STATE.md and the records: no format problems",
    );
    process.exit(found.length ? 1 : 0);
  }
  if (flag !== "--banner" && flag !== "--pin") {
    console.error("usage: bun run cycle [--check | --banner | --pin]");
    process.exit(2);
  }
  let out: string;
  try {
    const dir = await workDir();
    const fetched = flag !== "--banner" || (await fetchMain());
    const branch = git(dir, "branch", "--show-current") ?? "";
    const top = git(dir, "rev-parse", "--show-toplevel");
    const onMain = git(ROOT, "show", "origin/main:ROADMAP.md");
    const c: Cycle = {
      roadmap: onMain || local("ROADMAP.md"),
      state: git(ROOT, "show", "origin/main:STATE.md") || local("STATE.md"),
      branch,
      item: branch
        ? (git(dir, "config", `branch.${branch}.description`) ?? "").replace(
            /\s+/g,
            " ",
          )
        : "",
      branchRoadmap:
        top && existsSync(join(top, "ROADMAP.md"))
          ? readFileSync(join(top, "ROADMAP.md"), "utf8")
          : "",
      from: !onMain
        ? "this checkout (origin/main unavailable)"
        : fetched
          ? "origin/main"
          : "origin/main as of the last fetch (fetching just now failed or timed out), so it could be out of date",
    };
    const proved = parseRoadmap(c.roadmap)
      .slices.filter((s) => s.Status === "proof ready" || s.Status === "done")
      .map((s) => s.n);
    if (flag === "--banner" && proved.length)
      c.proofRuns = readLatest(ROOT, proved);
    out = flag === "--banner" ? banner(c) : pin(c);
  } catch (e) {
    out = unknown((e as Error).message);
  }
  console.log(out);
  process.exit(0); // do not wait on a stdin pipe that is still open
}
