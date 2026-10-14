// `bun run cycle --banner` (scripts/cycle.ts) reads main's record of Slice 0's two AI steps, run on Devesh's Mac
// (scripts/done-gate/mac-record.ts), and names "run the AI steps again on Devesh's Mac" while it does not hold.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiStepsOnMain, banner } from "./cycle";
import { AI_STEPS, fingerprints, RECORD } from "./done-gate/mac-record";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const record = (files: { [path: string]: string }) =>
  JSON.stringify({
    commit: "c".repeat(40),
    date: "2026-10-14",
    claude: "2.1.299",
    steps: AI_STEPS.map((name) => ({ name, outcome: "passed", seen: "ok" })),
    files,
  });

describe("what `bun run cycle --banner` says about main's record", () => {
  it("reads main's record and files from git, and the banner shows the line", () => {
    const dir = mkdtempSync(join(tmpdir(), "mac-record-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd: dir,
        encoding: "utf8",
      }).stdout.trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    git("add", "-A");
    git("commit", "-qm", "main");
    const line = aiStepsOnMain(dir, "HEAD");
    expect(line).toContain(`${RECORD} is not committed`);
    const roadmap =
      "# Roadmap\n\n## Slice 0: Ground\nStatus: proof ready\nGoal: g\nProof: p\nBlocked by: nothing\nProof passed: —\n\n- [x] A (agent) · evidence: x\n";
    expect(
      banner({
        roadmap,
        state: "PHASE: SETUP\n",
        branch: "",
        item: "",
        from: "origin/main",
        aiSteps: line,
      }),
    ).toContain(line as string);
    mkdirSync(join(dir, "docs/proof/slice-0-ai"), { recursive: true });
    writeFileSync(join(dir, RECORD), record(fingerprints(dir, "HEAD")));
    git("add", "-A");
    git("commit", "-qm", "the record");
    expect(aiStepsOnMain(dir, "HEAD")).toBeUndefined();
    expect(aiStepsOnMain(dir, "no-such-rev")).toContain("could not be read");
  });
});
