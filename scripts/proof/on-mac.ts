// `bun run proof 0 --on-my-mac`: Slice 0's two AI steps (the scripted fresh agent session and the verifier's run),
// run by Devesh in his own terminal with his own Claude login: the token `claude setup-token` makes, which he puts in
// that terminal as CLAUDE_CODE_OAUTH_TOKEN, so no agent ever sees it. The steps run as GitHub ran them before, on
// the checkout's commit, with the local stack up (the verifier runs the gate). It writes docs/proof/slice-0-ai/: the
// record (scripts/done-gate/mac-record.ts), each step's transcript and the report, for a pull request to commit.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../done-gate/git";
import {
  AI_STEPS,
  fingerprints,
  type MacRecord,
  RECORD,
  RECORD_DIR,
} from "../done-gate/mac-record";
import { reportText } from "./report";
import { overall, runSteps } from "./run";
import { onMac } from "./slice-0-agents";

export const NO_TOKEN = `The AI steps run with your own Claude login, and this terminal has none. In this terminal:
  1. claude setup-token   (sign in; it prints a token)
  2. export CLAUDE_CODE_OAUTH_TOKEN=<that token>
  3. bun run proof 0 --on-my-mac
Keep the token to yourself: never paste it into a chat with an agent.`;

/** Runs the two steps, writes the record, transcripts and report into `root`'s docs/proof/slice-0-ai/. */
export async function proveOnMac(o: {
  root: string;
  env: NodeJS.ProcessEnv;
  state: string;
  dir: string; // the report folder the steps write their files to
}): Promise<{ text: string; code: number }> {
  if (!o.env.CLAUDE_CODE_OAUTH_TOKEN) return { text: NO_TOKEN, code: 2 };
  const commit = git(o.root, ["rev-parse", "HEAD"]);
  const files = fingerprints(o.root, "HEAD");
  const results = await runSteps(
    AI_STEPS.map((name) => onMac[name]),
    o,
  );
  const date = new Date().toISOString().slice(0, 10);
  const out = join(o.root, RECORD_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const r of results)
    for (const f of r.files.filter((f) => f.endsWith(".txt")))
      copyFileSync(join(o.dir, f), join(out, f.replace(/^\d+-/, "")));
  const record: MacRecord = {
    commit,
    date,
    claude:
      spawnSync("claude", ["--version"], {
        encoding: "utf8",
        env: { PATH: o.env.PATH },
      }).stdout?.match(/^\d[\w.-]*/)?.[0] ?? "unknown",
    steps: AI_STEPS.map((name, i) => ({
      name,
      outcome: results[i]?.outcome ?? "failed",
      seen: results[i]?.seen ?? "it did not run",
    })),
    files,
  };
  writeFileSync(join(o.root, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  const report = reportText(0, results, { commit, date });
  writeFileSync(join(out, "report.md"), report);
  const passed = overall(results) === "passed";
  return {
    text: `${report}\n${passed ? "Both AI steps passed." : "Not every AI step passed: GitHub's proof run reports what this record says."} Written to ${RECORD_DIR}/ (the record, the transcripts and this report): ask an agent to commit that folder in a pull request.`,
    code: passed ? 0 : 1,
  };
}
