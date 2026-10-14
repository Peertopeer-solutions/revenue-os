// `bun run cycle --banner` shows each `proof ready` or `done` slice's latest proof run (its result and link, read
// with `gh run list` and `gh run view` on the proof workflow, or that it could not read them) and tells the session
// what to do about it. The slice field the passing run's date and link go in is `Proof passed:` (how the tracker's
// parser reads that field is in tracker-proof-passed.test.ts).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoadmap } from "../docs/tracker/parse.js";
import { banner, type Cycle } from "./cycle";
import { proofLinkProblems } from "./done-gate/proof-link";
import { reportHeading } from "./done-gate/proof-run";
import { proofLines, readLatest } from "./proof/latest";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const URL0 = "https://github.com/devesh911/revenue-os/actions/runs/555";
const slice = (n: number, status: string, passed = "—") =>
  `## Slice ${n}: Title ${n}\nStatus: ${status}\nGoal: g\nProof: p\nBlocked by: nothing\nProof passed: ${passed}\n\n- [x] A (agent) · evidence: [#1](https://example.com)\n`;
const STATE =
  "PHASE: SETUP\n\n## What works today\n| Area | Capability | Status | Where / why |\n|---|---|---|---|\n| Data | x | Works | y |\n## Waiting on Devesh\n## Decisions in force\n";
const cycle = (roadmap: string, proofRuns: Cycle["proofRuns"]): Cycle => ({
  roadmap: `# Roadmap\n\n${roadmap}`,
  state: STATE,
  branch: "feat/x",
  item: "A",
  from: "origin/main",
  proofRuns,
});

describe("the field a passing proof run is written in", () => {
  it("is what the banner names", () => {
    const b = banner(cycle(slice(0, "in progress"), undefined));
    expect(b).toContain('"Proof passed:"');
    expect(b).not.toContain("Seen by Devesh");
  });
});

describe("the banner's proof lines", () => {
  const latest = (outcome: string, n = 0) => [
    { n, outcome, url: URL0, id: "555", date: "2026-10-05" },
  ];

  it("tells the session to set a passing proof-ready slice to done, with the run's date and link and its report", () => {
    const b = banner(
      cycle(slice(0, "proof ready"), latest("passed") as Cycle["proofRuns"]),
    );
    expect(b).toContain(
      `Slice 0 (proof ready): its latest proof run passed on 2026-10-05: ${URL0}.`,
    );
    expect(b).toContain(`"Proof passed: 2026-10-05 · [run 555](${URL0})"`);
    expect(b).toContain("Proof reports");
  });

  it("tells it to add an item naming a failure and set the slice to in progress, even a done one", () => {
    const b = banner(
      cycle(
        slice(0, "done", `2026-10-01 · [run 1](${URL0})`),
        latest("failed") as Cycle["proofRuns"],
      ),
    );
    expect(b).toContain(
      `Slice 0 (done): its latest proof run FAILED on 2026-10-05: ${URL0}.`,
    );
    expect(b).toContain("add an item to Slice 0 naming the failure");
    expect(b).toContain("set the slice to in progress");
  });

  it("leaves a waiting slice as it is, says a run is still going, and says when a slice has no run yet", () => {
    expect(
      banner(
        cycle(slice(0, "proof ready"), latest("waiting") as Cycle["proofRuns"]),
      ),
    ).toContain("leave the slice and its items as they are");
    expect(
      banner(
        cycle(slice(0, "proof ready"), latest("running") as Cycle["proofRuns"]),
      ),
    ).toContain("still going");
    expect(banner(cycle(slice(0, "proof ready"), []))).toContain(
      "Slice 0 (proof ready): no proof run yet",
    );
  });

  it("says it could not read the runs, and says nothing about runs when no slice is proof ready or done", () => {
    expect(
      banner(
        cycle(slice(0, "proof ready"), "gh run list failed: not logged in"),
      ),
    ).toContain("could not read them (gh run list failed: not logged in)");
    const none = banner(cycle(slice(0, "in progress"), []));
    expect(none).not.toContain("latest proof run");
    expect(none).not.toContain("no proof run yet");
  });
});

describe("reading the latest proof runs with gh", () => {
  /** A stand-in gh: `run list` answers `list`, `run view <id>` answers views[id]. */
  const gh = (list: unknown, views: Record<string, unknown>, fail = false) => {
    const bin = mkdtempSync(join(tmpdir(), "cycle-gh-"));
    dirs.push(bin);
    writeFileSync(join(bin, "list.json"), JSON.stringify(list));
    for (const [id, v] of Object.entries(views))
      writeFileSync(join(bin, `${id}.json`), JSON.stringify(v));
    writeFileSync(
      join(bin, "gh"),
      fail
        ? "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n"
        : `#!/bin/sh\nif [ "$2" = list ]; then cat "${bin}/list.json"; else cat "${bin}/$3.json"; fi\n`,
      { mode: 0o755 },
    );
    return { PATH: `${bin}:${process.env.PATH}` };
  };
  const job = (n: number, conclusion: string, allPassed = "success") => ({
    name: `proof (${n})`,
    status: "completed",
    conclusion,
    steps: [{ name: "Every step passed", conclusion: allPassed }],
  });
  const list = [
    {
      databaseId: 3,
      displayTitle: "Proof of Slice 4",
      status: "completed",
      conclusion: "success",
      createdAt: "2026-10-06T03:00:00Z",
      url: "u3",
    },
    {
      databaseId: 2,
      displayTitle: "Proof of every proof-ready or done slice (schedule)",
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-10-05T03:00:00Z",
      url: "u2",
    },
    {
      databaseId: 1,
      displayTitle: "Proof of every proof-ready or done slice (schedule)",
      status: "completed",
      conclusion: "success",
      createdAt: "2026-10-04T03:00:00Z",
      url: "u1",
    },
  ];

  it("finds each slice's newest run that proved it, newest first, skipping a run by hand of another slice", () => {
    const env = gh(list, {
      2: { jobs: [job(0, "failure")] },
      1: { jobs: [job(0, "success"), job(1, "success", "skipped")] },
    });
    expect(readLatest(process.cwd(), [0, 1], env)).toEqual([
      {
        n: 0,
        outcome: "failed",
        url: "u2",
        id: "2",
        date: "2026-10-05",
        unlinkable: "concluded failure, not success",
      },
      { n: 1, outcome: "waiting", url: "u1", id: "1", date: "2026-10-04" },
    ]);
  });

  it("says why when gh can't read them", () => {
    expect(readLatest(process.cwd(), [0], gh([], {}, true))).toContain(
      "not logged in",
    );
  });

  it("gives up within its time, so a slow GitHub never holds a session's start past its hook's 20 seconds", () => {
    const slow = gh(
      [0, 1, 2, 3, 4].map((id) => ({ ...list[1], databaseId: id })),
      Object.fromEntries([0, 1, 2, 3, 4].map((id) => [id, { jobs: [] }])),
    );
    // Each answer takes a second: the stand-in sleeps before it runs.
    const bin = slow.PATH.split(":")[0] ?? "";
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nsleep 1\nif [ "$2" = list ]; then cat "${bin}/list.json"; else cat "${bin}/$3.json"; fi\n`,
      { mode: 0o755 },
    );
    const started = Date.now();
    const r = readLatest(process.cwd(), [0], slow, 2500);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(String(r)).toContain("in time");
  });
});

describe("the banner and rules-from-main judge a run alike", () => {
  const URL42 = "https://github.com/devesh911/revenue-os/actions/runs/42";
  const twoSlices = parseRoadmap(
    `# Roadmap\n\n${slice(0, "proof ready")}\n${slice(1, "proof ready")}`,
  ).slices;
  const job = (n: number, conclusion: string) => ({
    name: `proof (${n})`,
    status: "completed",
    conclusion,
    steps: [
      {
        name: "Every step passed",
        conclusion: conclusion === "success" ? "success" : "skipped",
      },
    ],
  });
  /** gh and GitHub's API both answering with run 42, whose run as a whole concluded `whole`. */
  const run42 = (whole: string, jobs: unknown[]) => {
    const bin = mkdtempSync(join(tmpdir(), "cycle-gh-"));
    dirs.push(bin);
    const listed = {
      databaseId: 42,
      displayTitle: "Proof of every proof-ready or done slice (schedule)",
      status: "completed",
      conclusion: whole,
      createdAt: "2026-10-05T03:23:11Z",
      url: URL42,
    };
    writeFileSync(join(bin, "list.json"), JSON.stringify([listed]));
    writeFileSync(join(bin, "42.json"), JSON.stringify({ jobs }));
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$2" = list ]; then cat "${bin}/list.json"; else cat "${bin}/42.json"; fi\n`,
      { mode: 0o755 },
    );
    const api = async (path: string) =>
      path.endsWith("/jobs?filter=latest&per_page=100")
        ? { jobs }
        : {
            path: ".github/workflows/proof.yml",
            status: "completed",
            conclusion: whole,
            head_sha: "a".repeat(40),
            created_at: "2026-10-05T03:23:11Z",
          };
    return { env: { PATH: `${bin}:${process.env.PATH}` }, api };
  };
  /** What the banner says about Slice 0, and what rules-from-main says of the pull request its line asks for. */
  const both = async (whole: string, jobs: unknown[]) => {
    const r = run42(whole, jobs);
    const line =
      proofLines(twoSlices, readLatest(process.cwd(), [0, 1], r.env))[0] ?? "";
    const passed = line.match(/"Proof passed: ([^"]+)"/)?.[1];
    const problems = passed
      ? await proofLinkProblems({
          now: `# Roadmap\n\n${slice(0, "done", passed)}`,
          main: `# Roadmap\n\n${slice(0, "proof ready")}`,
          body: `Roadmap: Slice 0 — replan: its proof passed\n\n${reportHeading(0, "passed")}\nRun: ${URL42} · commit aaaaaaa · 2026-10-05\n`,
          repo: "devesh911/revenue-os",
          ask: r.api,
          onMain: () => true,
          aiRecord: () => ({ outcome: "passed", seen: "a record that holds" }),
        })
      : undefined;
    return { line, problems };
  };

  it("does not ask for a slice to be set done with a run whose run as a whole failed, which rules-from-main refuses", async () => {
    const { line, problems } = await both("failure", [
      job(0, "success"),
      job(1, "failure"),
    ]);
    expect(problems).toBeUndefined();
    expect(line).not.toContain("Set it to done");
    expect(line).toContain("concluded failure");
  });

  it("when it asks for a slice to be set done, rules-from-main lets that pull request through", async () => {
    const { line, problems } = await both("success", [
      job(0, "success"),
      job(1, "success"),
    ]);
    expect(line).toContain("Set it to done");
    expect(problems).toEqual([]);
  });
});
