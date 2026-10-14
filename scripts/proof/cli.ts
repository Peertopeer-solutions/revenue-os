// `bun run proof <slice> [--out <folder>]`: runs that slice's proof steps against the real product in order, writes
// its short report (report.md, beside the files the steps wrote) into the folder (a new temporary one without
// --out), and prints it. Exit 1 when a step failed or the slice has no steps yet; exit 0 when every step passed, or
// when the only steps not passed wait on Devesh: waiting is no failure, but only a run whose every step passed can
// set a slice to done, so the report and `result=passed|waiting|failed` (in GITHUB_OUTPUT, for the proof workflow)
// say which. A slice ROADMAP.md does not have, or other arguments: exit 2. `bun run proof 0 --on-my-mac` runs Slice
// 0's two AI steps instead, with Devesh's own Claude login (scripts/proof/on-mac.ts).

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRoadmap } from "../../docs/tracker/parse.js";
import { AI_SLICE } from "../done-gate/mac-record";
import type { Outcome } from "../done-gate/proof-run";
import { proveOnMac } from "./on-mac";
import { reportText } from "./report";
import { overall, type Result, runSteps } from "./run";
import { SLICES } from "./slices";
import type { Step } from "./step";

/**
 * Proves slice `n` with `steps` (none: the slice has no proof yet, which fails), writes report.md into `o.dir`,
 * tells GITHUB_OUTPUT the result when `o.env` names it, and gives the report, the result and the exit code.
 */
export async function prove(
  n: number,
  steps: Step[] | undefined,
  o: { root: string; env: NodeJS.ProcessEnv; state: string; dir: string },
): Promise<{ text: string; result: Outcome; code: number }> {
  mkdirSync(o.dir, { recursive: true });
  const results: Result[] = steps
    ? await runSteps(steps, o)
    : [
        {
          does: `Runs Slice ${n}'s proof steps`,
          outcome: "failed",
          seen: `Slice ${n} has no proof steps yet: write them in scripts/proof/slice-${n}.ts and list them in scripts/proof/slices.ts`,
          files: [],
        },
      ];
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_OUTPUT } =
    o.env;
  const text = reportText(n, results, {
    run:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : undefined,
    // the checkout's commit: a run after a deploy checks out the deployed one, while GITHUB_SHA is main's newest
    commit:
      spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: o.root,
        encoding: "utf8",
      }).stdout?.trim() || "unknown",
    date: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(join(o.dir, "report.md"), text);
  const result = overall(results);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `result=${result}\n`);
  return { text, result, code: result === "failed" ? 1 : 0 };
}

export const USAGE =
  "usage: bun run proof <slice number> [--out <folder>] | bun run proof 0 --on-my-mac [--out <folder>]";

/**
 * What `bun run proof` was asked (its arguments), checked against `root`'s ROADMAP.md: the slice, its steps, the
 * --out folder and whether it is Devesh's Mac run of Slice 0's AI steps (--on-my-mac), or why the command refuses
 * them (exit 2).
 */
export function toProve(
  args: string[],
  root: string,
):
  | { n: number; steps: Step[] | undefined; out?: string; onMac?: true }
  | { refused: string } {
  const [slice = "", ...flags] = args;
  let out: string | undefined;
  let onMac = false;
  for (let i = 0; i < flags.length; i++)
    if (flags[i] === "--out" && flags[i + 1] && out === undefined)
      out = flags[++i];
    else if (flags[i] === "--on-my-mac" && !onMac) onMac = true;
    else return { refused: USAGE };
  if (!/^\d+$/.test(slice)) return { refused: USAGE };
  const n = Number(slice);
  if (onMac && n !== AI_SLICE)
    return {
      refused: `--on-my-mac runs Slice ${AI_SLICE}'s two AI steps only: bun run proof ${AI_SLICE} --on-my-mac`,
    };
  const roadmap = readFileSync(join(root, "ROADMAP.md"), "utf8");
  if (!parseRoadmap(roadmap).slices.some((s) => s.n === n))
    return { refused: `ROADMAP.md has no Slice ${n}` };
  return { n, steps: SLICES[n], out, ...(onMac ? { onMac: true } : {}) };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const asked = toProve(process.argv.slice(2), root);
  if ("refused" in asked) {
    console.error(asked.refused);
    process.exit(2);
  }
  const { n, steps, out, onMac } = asked;
  const dir = out
    ? resolve(out)
    : mkdtempSync(join(tmpdir(), `proof-slice-${n}-`));
  const o = {
    root,
    env: process.env,
    state: readFileSync(join(root, "STATE.md"), "utf8"),
    dir,
  };
  const { text, code } = onMac ? await proveOnMac(o) : await prove(n, steps, o);
  console.log(`${text}\nThe report and its files: ${dir}`);
  process.exit(code); // a step still running past its time must not hold the run open
}
