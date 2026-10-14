// A pull request that sets a slice to done links, after "Proof passed:", a run of the proof workflow for that slice
// that GitHub's API reports concluded success with every step passed, on a commit already on main; every item of
// the slice is ticked; and its body shows that run's report, as rules-from-main reads it: the report's heading and
// its "Run: <link>" line (AGENTS.md → Definition of done). A slice main already has done keeps what its proof ran
// on: while its "Proof passed:" stays, its title, goal, Proof line, blocker and items stay too. GitHub is asked with
// plain GETs and no login: the repository is public and rules-from-main holds no token. Were it made private,
// GitHub would answer 404 and every such pull request would be refused, saying so, until rules-from-main's job is
// given `actions: read` and its token. Setting Slice 0 to done also needs main's record of its two AI steps, which run
// on Devesh's Mac, to have passed them on main's files as they are (scripts/done-gate/mac-record.ts).

import { spawnSync } from "node:child_process";
import { parseRoadmap, type Slice } from "../../docs/tracker/parse.js";
import { git } from "./git";
import {
  AGAIN,
  AI_SLICE,
  type Judged,
  judgedAt,
  MAC_COMMAND,
} from "./mac-record";
import {
  ALL_PASSED,
  type Job,
  PROOF_WORKFLOW,
  reportHeading,
  sliceOutcome,
  unlinkable,
} from "./proof-run";
import { shown } from "./rule-changes";

/** A GET from GitHub's REST API by path ("repos/<owner>/<name>/…"): its JSON, or an error saying why not. */
type Ask = (path: string) => Promise<unknown>;
type Run = {
  path?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  created_at?: string;
};

const RUN =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)(?![\w/])/g;
const HINT: Record<number, string> = {
  404: ": no such run here, or the repository is private (then rules-from-main needs a login: give its job `actions: read` and pass it its token)",
  403: ": most likely its limit of 60 requests an hour without a login; run the check again later",
  429: ": most likely its limit of 60 requests an hour without a login; run the check again later",
};

const askGitHub: Ask = async (path) => {
  const api = process.env.GITHUB_API_URL || "https://api.github.com"; // GitHub's runner sets it
  const r = await fetch(`${api}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "revenue-os-rules-from-main",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.ok) return r.json();
  throw new Error(
    `GitHub's API answered ${r.status} for ${path}${HINT[r.status] ?? ""}`,
  );
};

/** Why slice `n`'s "Proof passed:" value does not prove it, or nothing when it does. */
async function unproven(
  n: number,
  passed: string,
  body: string,
  repo: string | undefined,
  ask: Ask,
  onMain: (sha: string) => boolean,
): Promise<string | undefined> {
  const date = passed.match(/^\d{4}-\d{2}-\d{2}\b/)?.[0];
  const links = [...new Set([...passed.matchAll(RUN)].map((m) => m[0]))];
  const form = `"Proof passed: <the run's date> · [run <id>](https://github.com/<owner>/<name>/actions/runs/<id>)"`;
  if (!date || !links.length)
    return `its "Proof passed:" has no ${date ? "link to a proof run" : "date"}: write ${form}`;
  if (links.length > 1)
    return `its "Proof passed:" links ${links.length} runs; it takes exactly one`;
  const link = links[0] ?? "";
  const [, owner, name, id] = [...link.matchAll(RUN)][0] ?? [];
  if (!repo)
    return "which repository this is can't be told (no GITHUB_REPOSITORY, and origin is not on github.com)";
  if (`${owner}/${name}`.toLowerCase() !== repo.toLowerCase())
    return `its link is a run of ${owner}/${name}, not this one (${repo})`;
  let run: Run;
  let jobs: Job[];
  try {
    run = (await ask(`repos/${repo}/actions/runs/${id}`)) as Run;
    if (run.path?.split("@")[0] !== PROOF_WORKFLOW)
      return `${link} is a run of ${run.path}, not of the proof workflow (${PROOF_WORKFLOW})`;
    const whole = unlinkable(run);
    if (whole) return `${link} ${whole}`;
    const sha = run.head_sha ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha) || !onMain(sha))
      return `${link} ran on ${sha || "an unknown commit"}, which is not on main`;
    const started = run.created_at?.slice(0, 10);
    if (started !== date)
      return `its date ${date} is not the run's: ${link} started on ${started}`;
    jobs =
      (
        (await ask(
          `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
        )) as { jobs?: Job[] }
      ).jobs ?? [];
  } catch (e) {
    return `GitHub could not be asked about ${link}: ${(e as Error).message}`;
  }
  const outcome = sliceOutcome(jobs, n);
  if (!outcome)
    return `${link} did not prove Slice ${n} (it has no job "proof (${n})")`;
  if (outcome === "waiting")
    return `${link} left a step waiting on Devesh (its job "proof (${n})" skipped "${ALL_PASSED}"), so not every step passed`;
  if (outcome !== "passed") return `${link}'s job "proof (${n})" ${outcome}`;
  const heading = reportHeading(n, "passed");
  const lines = shown(body)
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  if (
    !lines.includes(heading) ||
    !lines.some((l) => l === `Run: ${link}` || l.startsWith(`Run: ${link} `))
  )
    return `the pull request's body carries no report of ${link}: paste the run's report (its comment on the "Proof reports" issue), whose first lines are "${heading}" and "Run: ${link} …"`;
}

/**
 * ROADMAP.md as the pull request leaves it (`now`) and as main has it → a problem for each slice it sets to done,
 * or whose "Proof passed:" it changes on a done slice, that its link does not prove. `onMain` says whether a commit
 * is on main. GitHub is asked only about such slices.
 */
export async function proofLinkProblems(o: {
  now: string;
  main: string;
  body: string;
  repo: string | undefined;
  ask: Ask;
  onMain: (sha: string) => boolean;
  aiRecord: () => Judged; // what main's record of Slice 0's AI steps says about main's files
}): Promise<string[]> {
  const before = new Map(parseRoadmap(o.main).slices.map((s) => [s.n, s]));
  const problems: string[] = [];
  for (const s of parseRoadmap(o.now).slices) {
    const was = before.get(s.n);
    const passed = s["Proof passed"] ?? "";
    if (s.Status !== "done") continue;
    if (was?.Status === "done" && was["Proof passed"] === passed) {
      if (asProved(was) !== asProved(s))
        problems.push(
          `ROADMAP.md changes Slice ${s.n}, which is done, while it keeps its "Proof passed:" (its title, goal, Proof line, blocker or items differ from main's), so no proof ran on what it now says: set it back to proof ready, so its proof runs again after the merge, or leave it as main has it`,
        );
      continue;
    }
    for (const i of s.items.filter((i) => !i.done))
      problems.push(
        `ROADMAP.md sets Slice ${s.n} to done, but its item "${i.text} (${i.owner})" is not ticked: a slice is done only when every item is`,
      );
    const why = await unproven(s.n, passed, o.body, o.repo, o.ask, o.onMain);
    if (why) problems.push(`ROADMAP.md sets Slice ${s.n} to done, but ${why}`);
    const ai = s.n === AI_SLICE ? o.aiRecord() : undefined;
    if (ai && ai.outcome !== "passed")
      problems.push(
        `ROADMAP.md sets Slice ${s.n} to done, but its two AI steps, which run on Devesh's Mac, have no record on main that passed them and matches main's files (${ai.seen}): ${AGAIN} (\`${MAC_COMMAND}\`) and commit its record first`,
      );
  }
  return problems;
}

/** PURE: what a slice's proof stands for: everything but its "Proof passed:" and its items' evidence. */
const asProved = (s: Slice) =>
  JSON.stringify([
    s.title,
    s.Goal,
    s.Proof,
    s["Blocked by"],
    s.items.map((i) => [i.text, i.owner, i.done]),
  ]);

/** This repository as "owner/name": GitHub's runner says it; a checkout reads it from origin. */
const thisRepo = (dir: string) => {
  const given = process.env.GITHUB_REPOSITORY ?? "";
  if (/^[\w.-]+\/[\w.-]+$/.test(given)) return given;
  return git(dir, ["remote", "get-url", "origin"], {}, true).match(
    /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
  )?.[1];
};

/** The check as `bun run gate pr` runs it: `base` is main, and a commit is on main when `base` holds it. */
export const proofLinks = (
  dir: string,
  now: string,
  main: string,
  body: string,
  base: string,
) =>
  proofLinkProblems({
    now,
    main,
    body,
    repo: thisRepo(dir),
    ask: askGitHub,
    onMain: (sha) =>
      spawnSync("git", ["merge-base", "--is-ancestor", sha, base], {
        cwd: dir,
      }).status === 0,
    aiRecord: () => judgedAt(dir, base),
  });
