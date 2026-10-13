// .github/workflows/proof.yml runs `bun run proof` after each deploy to main, once a day and by hand, and posts each
// report to the "Proof reports" issue; its steps that pick the slices and post the reports run here as GitHub runs
// them, the posting one with a stand-in `gh`.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { secondCheck } from "./done-gate/pr";
import { ALL_PASSED, reportHeading } from "./done-gate/proof-run";

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

type Step_ = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};
type Job = {
  if?: string;
  needs?: unknown;
  permissions?: unknown;
  strategy?: { matrix?: Record<string, unknown>; "fail-fast"?: boolean };
  outputs?: Record<string, string>;
  steps?: Step_[];
};
const WORKFLOW = join(ROOT, ".github", "workflows", "proof.yml");
/** A GitHub expression, as the workflow file writes it. */
const expr = (s: string) => `\${{ ${s} }}`;
const workflow = () =>
  Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as {
    name: string;
    "run-name": string;
    on: Record<string, unknown>;
    permissions: unknown;
    jobs: Record<string, Job>;
  };

describe("which slices a proof run proves", () => {
  it("tells the workflow as `slices=[…]`, run as its step runs it", () => {
    const step = (workflow().jobs.due?.steps ?? []).find((s) => s.id === "due");
    expect(step?.env).toEqual({ SLICE: expr("inputs.slice") });
    const output = join(scratch("proof-due-"), "out");
    writeFileSync(output, "");
    const r = spawnSync("bash", ["-e", "-c", step?.run ?? "false"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, SLICE: "0" },
    });
    expect(r.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("slices=[0]\n");
  });
});

describe("proof.yml: the proof runs on GitHub after each deploy to main, once a day and by hand", () => {
  // behaviour already on main: main's copy carries .github/workflows/proof.yml over (it is not product code), so it passes there
  it("starts after deploy finishes on a push to main, on a daily schedule and by hand with a slice; never for a pull request", () => {
    const w = workflow();
    expect(Object.keys(w.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
      "workflow_run",
    ]);
    expect(w.on.workflow_run).toEqual({
      workflows: ["deploy"],
      types: ["completed"],
      branches: ["main"],
    });
    expect(w.on.schedule).toEqual([{ cron: expect.any(String) }]);
    expect(
      (w.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs
        .slice,
    ).toMatchObject({ required: true });
    expect(w.jobs.due?.if?.replace(/\s+/g, " ").trim()).toBe(
      "github.event_name == 'schedule' || (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push' && contains(fromJSON('[\"success\",\"skipped\"]'), github.event.workflow_run.conclusion)) || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
    );
  });

  // behaviour already on main: main's copy carries .github/workflows/proof.yml over (it is not product code), so it passes there
  it("names each run so its slice can be read back", () => {
    expect(workflow()["run-name"]).toBe(
      expr(
        "github.event_name == 'workflow_dispatch' && format('Proof of Slice {0}', inputs.slice) || format('Proof of every proof-ready or done slice ({0})', github.event_name)",
      ),
    );
  });

  // behaviour already on main: main's copy carries .github/workflows/proof.yml and the gate's own code over (neither is product code), so it passes there
  it("holds the least permissions each job needs, pins every action by commit, and passes values as environment variables", () => {
    const w = workflow();
    expect(w.permissions).toEqual({});
    expect(w.jobs.due?.permissions).toEqual({ contents: "read" });
    expect(w.jobs.proof?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(w.jobs.post?.permissions).toEqual({ issues: "write" });
    for (const job of Object.values(w.jobs))
      for (const s of job.steps ?? []) {
        if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
        expect(s.run ?? "").not.toContain(`\${{`);
      }
    expect(
      secondCheck({
        ".github/workflows/proof.yml": readFileSync(WORKFLOW, "utf8"),
      }),
    ).toEqual([]);
  });

  // behaviour already on main: main's copy carries .github/workflows/proof.yml and the gate's own code over (neither is product code), so it passes there
  it("proves each due slice in its own job: the local stack for Slices 0 and 1, the AI key only where the proof runs, the report kept as the run's artifact", () => {
    const proof = workflow().jobs.proof as Job;
    expect(proof.needs).toBe("due");
    expect(proof.strategy).toEqual({
      "fail-fast": false,
      matrix: { slice: expr("fromJSON(needs.due.outputs.slices)") },
    });
    const steps = proof.steps ?? [];
    const prove = steps.find((s) => s.id === "prove") as Step_;
    expect(prove.run?.trim()).toBe(
      'bun run proof "$SLICE" --out "proof-report/slice-$SLICE"',
    );
    expect(prove.env).toEqual({
      SLICE: expr("matrix.slice"),
      ANTHROPIC_EVALS_KEY: expr("secrets.ANTHROPIC_EVALS_KEY"),
      GH_TOKEN: expr("github.token"),
    });
    for (const s of steps)
      if (s !== prove)
        expect(JSON.stringify(s.env ?? {})).not.toContain("secrets.");
    const start = steps.find((s) => s.run === "bash .github/test-stack.sh");
    expect(start?.if).toBe("matrix.slice <= 1");
    const passed = steps.find((s) => s.name === ALL_PASSED);
    expect(passed?.if).toBe("steps.prove.outputs.result == 'passed'");
    // The verifier's run in Slice 0's proof runs the whole gate, browser checks included, as ci.yml installs them.
    const browsers = steps.findIndex((s) =>
      /playwright install --with-deps chromium/.test(s.run ?? ""),
    );
    expect(browsers).toBeGreaterThan(-1);
    expect(browsers).toBeLessThan(steps.indexOf(prove));
    expect(steps[browsers]?.if).toBe("matrix.slice <= 1");
    // That the run stops its steps in time to write its report before this job's limit: scripts/proof-run.test.ts.
    const upload = steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload?.if).toBe("always()");
    expect(upload?.with).toMatchObject({
      name: `proof-slice-${expr("matrix.slice")}`,
      path: "proof-report",
    });
  });

  describe('posting each report to the one standing "Proof reports" issue', () => {
    const post = () =>
      (workflow().jobs.post?.steps ?? []).find((s) =>
        /gh issue/.test(s.run ?? ""),
      ) as Step_;
    /**
     * Each slice's report written where the prove step writes it, inside the folder the upload step uploads, then
     * unpacked into `dir` as actions/download-artifact does with the post job's settings: merged, every artifact's
     * files go straight into its path; unmerged, a lone artifact's do too (as GitHub did with Slice 0's first run),
     * and several each go into a folder named after the artifact.
     */
    const unpack = (dir: string, reports: Record<number, string>) => {
      const steps = workflow().jobs.proof?.steps ?? [];
      const out = steps
        .find((s) => s.id === "prove")
        ?.run?.match(/--out "?([^"\s]+)"?/)?.[1];
      const root = String(
        steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with
          ?.path,
      );
      const get = (workflow().jobs.post?.steps ?? []).find((s) =>
        s.uses?.startsWith("actions/download-artifact@"),
      )?.with;
      const slices = Object.keys(reports);
      for (const [n, text] of Object.entries(reports)) {
        const inArtifact = relative(root, (out ?? "").replace("$SLICE", n));
        const at = join(
          dir,
          String(get?.path),
          get?.["merge-multiple"] || slices.length === 1
            ? ""
            : `proof-slice-${n}`,
          inArtifact,
        );
        mkdirSync(at, { recursive: true });
        writeFileSync(join(at, "report.md"), text);
      }
    };
    /** Runs the posting step as GitHub would, in a folder holding the downloaded reports, with a stand-in gh. */
    const posted = (
      issues: string,
      reports: Record<number, string>,
      slices = "[0,1]",
    ) => {
      const dir = scratch("proof-post-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/bash
echo "gh $*" >> "$LOG"
case "$1 $2" in
  "issue list") printf '%s' "$ISSUES" ;;
  "issue create") echo "https://github.com/o/r/issues/42" ;;
  "issue comment") shift 2; while [ $# -gt 0 ]; do [ "$1" = --body-file ] && { grep -q UNPOSTABLE "$2" && exit 1; echo "--- comment"; cat "$2"; } >> "$LOG"; shift; done ;;
esac
`,
        { mode: 0o755 },
      );
      unpack(dir, reports);
      const log = join(dir, "log");
      const r = spawnSync("bash", ["-e", "-c", post().run ?? ""], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LOG: log,
          ISSUES: issues,
          SLICES: slices,
          RUN_URL: "https://github.com/o/r/actions/runs/9",
          OWNER: "devesh911",
        },
      });
      return {
        status: r.status,
        log: existsSync(log) ? readFileSync(log, "utf8") : "",
      };
    };

    // behaviour already on main: main's copy carries .github/workflows/proof.yml and the gate's own code over (neither is product code), so it passes there
    it("comments each report on the existing issue, and says so when a slice's job wrote none", () => {
      const r = posted("12", {
        0: "## Proof report: Slice 0 — passed\nall good\n",
      });
      expect(r.status).toBe(0);
      expect(r.log).not.toContain("gh issue create");
      expect(r.log).toContain("gh issue comment 12");
      expect(r.log).toContain("all good");
      expect(r.log).toContain(
        `${reportHeading(1, "failed")}\nRun: https://github.com/o/r/actions/runs/9`,
      );
    });

    // behaviour already on main: main's copy carries .github/workflows/proof.yml over (it is not product code), so it passes there
    it("posts the report of a run that proved one slice, whose lone artifact the download unpacks straight into its folder", () => {
      const r = posted(
        "141",
        { 0: "## Proof report: Slice 0 — waiting\nslice zero's report\n" },
        "[0]",
      );
      expect(r.status).toBe(0);
      expect(r.log).toContain("gh issue comment 141");
      expect(r.log).toContain("slice zero's report");
      expect(r.log).not.toContain("stopped before it wrote a report");
    });

    // behaviour already on main: main's copy carries .github/workflows/proof.yml over (it is not product code), so it passes there
    it("still posts the other slices' reports when one can't be posted, then fails the step", () => {
      const r = posted("12", {
        0: "## Proof report: Slice 0 — failed\nUNPOSTABLE\n",
        1: "## Proof report: Slice 1 — passed\nslice one's report\n",
      });
      expect(r.status).not.toBe(0);
      expect(r.log).toContain("slice one's report");
    });

    // behaviour already on main: main's copy carries .github/workflows/proof.yml over (it is not product code), so it passes there
    it("creates the issue when it is missing, mentioning Devesh so GitHub notifies him of every report", () => {
      const r = posted("", { 0: "r0\n", 1: "r1\n" });
      expect(r.status).toBe(0);
      expect(r.log).toMatch(
        /gh issue create --title Proof reports --body .*@devesh911/,
      );
      expect(r.log).toContain("gh issue comment 42");
    });
  });
});
