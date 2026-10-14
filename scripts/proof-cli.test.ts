// `bun run proof <slice>` (scripts/proof/cli.ts) writes a slice's short report, tells the proof workflow the result
// and exits 1 only when a step failed; it refuses a slice ROADMAP.md does not have. Slice 0's steps are the ones it
// runs for `bun run proof 0`.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportHeading } from "./done-gate/proof-run";
import { prove, toProve } from "./proof/cli";
import { steps as slice0 } from "./proof/slice-0";
import { SLICES } from "./proof/slices";
import type { Step } from "./proof/step";

setDefaultTimeout(30_000);
const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
};

const KEY = "A second Anthropic key for the automatic test conversations";
const STATE = `PHASE: SETUP\n\n## What works today\n| Area | Capability | Status | Where / why |\n|---|---|---|---|\n| Data | x | Works | y |\n## Waiting on Devesh\n- [ ] **${KEY}**: a key saved in GitHub as ANTHROPIC_EVALS_KEY\n- [x] **Pin the required checks** (done 2026-10-02)\n## Decisions in force\n`;
const needsKey = { item: KEY, arrived: (env: NodeJS.ProcessEnv) => !!env.KEY };

describe("bun run proof <slice>", () => {
  const steps = (failing: boolean): Step[] => [
    { does: "passes", check: () => "fine" },
    { does: "needs the key", needs: [needsKey], check: () => "x" },
    ...(failing
      ? [
          {
            does: "fails",
            check: () => {
              throw new Error("saw the wrong thing");
            },
          },
        ]
      : []),
  ];
  /** Proves slice `n` as the command does, into a scratch folder, with GITHUB_OUTPUT as the proof workflow sets it. */
  const proved = async (n: number, list: Step[] | undefined) => {
    const dir = scratch("proof-cli-");
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const r = await prove(n, list, {
      root: dir,
      env: {
        GITHUB_OUTPUT: output,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "9",
      },
      state: STATE,
      dir: join(dir, "report"),
    });
    return {
      ...r,
      report: readFileSync(join(dir, "report", "report.md"), "utf8"),
      output: readFileSync(output, "utf8"),
    };
  };

  it("exits 1 when a step failed, writes report.md naming the run, and tells the workflow the result", async () => {
    const r = await proved(0, steps(true));
    expect(r.code).toBe(1);
    expect(r.report).toBe(r.text);
    expect(r.report.split("\n").slice(0, 2)).toEqual([
      reportHeading(0, "failed"),
      expect.stringMatching(
        /^Run: https:\/\/github\.com\/o\/r\/actions\/runs\/9 · commit \w+ · \d{4}-\d{2}-\d{2}$/,
      ),
    ]);
    expect(r.report).toContain("saw the wrong thing");
    expect(r.output).toBe("result=failed\n");
  });

  it("exits 0 when the only steps not passed wait on Devesh, listing them", async () => {
    const r = await proved(0, steps(false));
    expect(r.code).toBe(0);
    expect(r.report).toContain(KEY);
    expect(r.output).toBe("result=waiting\n");
  });

  it("fails a slice that has no steps yet", async () => {
    const r = await proved(1, undefined);
    expect(r.code).toBe(1);
    expect(r.report).toContain("has no proof steps");
    expect(r.output).toBe("result=failed\n");
  });

  it("refuses a slice ROADMAP.md does not have, and anything but a slice number", () => {
    const run = (...args: string[]) =>
      spawnSync("bun", ["run", "proof", ...args], {
        cwd: ROOT,
        encoding: "utf8",
      });
    const unknown = run("99");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("ROADMAP.md has no Slice 99");
    expect(run().status).toBe(2);
    expect(run("0", "--elsewhere").status).toBe(2);
    // the same answers, from the check the command runs before it proves anything
    expect(toProve(["99"], ROOT)).toEqual({
      refused: "ROADMAP.md has no Slice 99",
    });
    const usage =
      "usage: bun run proof <slice number> [--out <folder>] | bun run proof 0 --on-my-mac [--out <folder>]";
    for (const args of [
      [],
      ["0", "--elsewhere"],
      ["0", "--out"],
      ["x1"],
      ["0", "--on-my-mac", "--on-my-mac"],
      ["0", "--out", "a", "--out", "b"],
    ])
      expect(toProve(args, ROOT)).toEqual({ refused: usage });
  });

  it("takes --on-my-mac for Slice 0 alone, before or after --out, and refuses it for any other slice without running a step", () => {
    for (const args of [
      ["0", "--on-my-mac"],
      ["0", "--out", "r", "--on-my-mac"],
      ["0", "--on-my-mac", "--out", "r"],
    ])
      expect(toProve(args, ROOT)).toMatchObject({ n: 0, onMac: true });
    expect(toProve(["0", "--on-my-mac", "--out", "r"], ROOT)).toMatchObject({
      out: "r",
    });
    expect(toProve(["0"], ROOT)).not.toHaveProperty("onMac");
    const other = spawnSync("bun", ["run", "proof", "1", "--on-my-mac"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(other.status).toBe(2);
    expect(other.stderr).toContain(
      "--on-my-mac runs Slice 0's two AI steps only",
    );
  });

  it("with --on-my-mac and no Claude login in the terminal, says how to make one and exits 2", () => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const r = spawnSync("bun", ["run", "proof", "0", "--on-my-mac"], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("claude setup-token");
    expect(r.stderr).toContain("export CLAUDE_CODE_OAUTH_TOKEN=");
    expect(r.stdout).not.toContain("The report and its files");
  });
});

describe("Slice 0's steps", () => {
  it("are the ones `bun run proof 0` runs", () => {
    expect(SLICES[0]).toBe(slice0);
    expect(toProve(["0", "--out", "r"], ROOT)).toEqual({
      n: 0,
      steps: slice0,
      out: "r",
    });
  });
});
