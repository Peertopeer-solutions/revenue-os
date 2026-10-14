// The report `bun run proof` writes on GitHub (the one the proof workflow posts to the "Proof reports" issue) is
// the one rules-from-main takes as a slice's proof: a pull request that sets the slice to done with that run's link
// passes the check when its body carries the runner's own report, and is refused without it. GitHub's API answers
// here as a stand-in, as in scripts/done-gate-proof.test.ts.
import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofLinkProblems } from "./done-gate/proof-link";
import { prove } from "./proof/cli";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const REPO = "devesh911/revenue-os";
const ID = "18234567890";
const LINK = `https://github.com/${REPO}/actions/runs/${ID}`;
const SHA = "a".repeat(40);
const slice = (status: string, passed = "—") =>
  `# Roadmap\n\n## Slice 0: Ground\nStatus: ${status}\nGoal: g\nProof: p\nBlocked by: nothing\nProof passed: ${passed}\n\n- [x] A (agent) · evidence: [#1](https://example.com)\n`;
// The run and its jobs as GitHub's API gives them for a passing proof of Slice 0 on main.
const run = {
  id: Number(ID),
  path: ".github/workflows/proof.yml",
  status: "completed",
  conclusion: "success",
  head_sha: SHA,
  created_at: "2026-10-05T03:23:11Z",
  html_url: LINK,
};
const job = {
  name: "proof (0)",
  status: "completed",
  conclusion: "success",
  steps: [
    { name: "Prove Slice 0", conclusion: "success" },
    { name: "Every step passed", conclusion: "success" },
  ],
};

it("takes the report `bun run proof` writes on GitHub as that run's report, and refuses the body without it", async () => {
  const { text, result } = await prove(
    0,
    [{ does: "checks the four law files", check: () => "all four exist" }],
    {
      root: ROOT,
      env: {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: REPO,
        GITHUB_RUN_ID: ID,
      },
      state: "",
      dir: (() => {
        const d = mkdtempSync(join(tmpdir(), "proof-report-link-"));
        dirs.push(d);
        return d;
      })(),
    },
  );
  expect(result).toBe("passed");
  const judge = (body: string) =>
    proofLinkProblems({
      now: slice("done", `2026-10-05 · [run ${ID}](${LINK})`),
      main: slice("proof ready"),
      body,
      repo: REPO,
      ask: async (path) =>
        path.includes("/jobs") ? { total_count: 1, jobs: [job] } : run,
      onMain: (sha) => sha === SHA,
      aiRecord: () => ({ outcome: "passed", seen: "a record that holds" }),
    });
  const first = "Roadmap: Slice 0 — replan: Slice 0's proof passed";
  expect(await judge(`${first}\n\n${text}`)).toEqual([]);
  expect(await judge(first)).toEqual([
    expect.stringContaining(
      `the pull request's body carries no report of ${LINK}`,
    ),
  ]);
});
