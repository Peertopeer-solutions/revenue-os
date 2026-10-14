// "Where are we" — what every agent session is shown at start and on each prompt (scripts/cycle.ts),
// computed by the one roadmap parser the tracker page also uses (docs/tracker/parse.js).
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentSlice,
  nextItem,
  parseRoadmap,
  parseState,
} from "../docs/tracker/parse.js";
import { banner, type Cycle, pin, problems } from "./cycle";

const ROOT = join(import.meta.dir, "..");
const slice = (
  n: number,
  status: string,
  blocked = "nothing",
  items = "- [ ] Build the thing (agent)",
) =>
  `## Slice ${n}: Title ${n}\nStatus: ${status}\nGoal: g\nProof: p\nBlocked by: ${blocked}\nProof passed: —\n\n${items}\n`;
const roadmap = (...slices: string[]) => `# Roadmap\n\n${slices.join("\n")}`;
const STATE =
  "PHASE: SETUP\n\n## What works today\n| Area | Capability | Status | Where / why |\n|---|---|---|---|\n| Data | x | Works | y |\n## Waiting on Devesh\n## Decisions in force\n";
const cycle = (over: Partial<Cycle> = {}): Cycle => ({
  roadmap: roadmap(
    slice(
      0,
      "in progress",
      "nothing",
      "- [x] Keep agents on the plan (agent) · evidence: [#1](https://example.com)\n- [ ] Rewrite the patterns (agent)",
    ),
  ),
  state: STATE,
  branch: "feat/x",
  item: "Keep agents on the plan",
  from: "origin/main",
  ...over,
});

it("the current slice is the lowest-numbered one not done, not proof ready and not blocked", () => {
  const { slices } = parseRoadmap(
    roadmap(
      slice(4, "not started"),
      slice(0, "done"),
      slice(1, "proof ready"),
      slice(2, "not started", "Meta test number (Devesh)"),
      slice(3, "in progress"),
    ),
  );
  expect(currentSlice(slices)?.n).toBe(3);
});

it("has no current slice when every open slice waits on Devesh", () => {
  const { slices } = parseRoadmap(
    roadmap(slice(0, "proof ready"), slice(1, "not started", "Slice 0")),
  );
  expect(currentSlice(slices)).toBeUndefined();
});

it("the next item is the first unchecked item an agent owns", () => {
  const [s] = parseRoadmap(
    roadmap(
      slice(
        0,
        "in progress",
        "nothing",
        "- [x] A (agent) · evidence: [#1](https://example.com)\n- [ ] B (Devesh)\n- [ ] C (agent)",
      ),
    ),
  ).slices;
  expect(nextItem(s)?.text).toBe("C");
});

it("the per-prompt pin is one line naming this branch's item, the slice, its next item and the rule", () => {
  const p = pin(cycle());
  expect(p.split("\n")).toHaveLength(1);
  for (const part of [
    '"Keep agents on the plan"',
    "Slice 0",
    '"Rewrite the patterns"',
    "AGENTS.md",
  ])
    expect(p).toContain(part);
});

it("the pin and the banner say CYCLE UNKNOWN instead of going quiet", () => {
  for (const show of [pin, banner])
    expect(show(cycle({ roadmap: "not a roadmap" }))).toStartWith(
      "CYCLE UNKNOWN",
    );
});

it("the banner lists format problems and says when no slice can be built", () => {
  const b = banner(
    cycle({
      roadmap: roadmap(
        slice(0, "proof ready", "nothing", "- [x] Shipped (agent)"),
      ),
    }),
  );
  expect(b).toContain("is ticked without evidence");
  expect(b).toContain("No slice can be built");
  expect(b).toContain("run its proof");
  expect(b).toContain("the passing run's link");
  expect(b).not.toContain("Devesh to watch");
});

it("a branch with no recorded item is told how to record one", () => {
  const b = banner(cycle({ item: "" }));
  for (const part of [
    'git config branch.feat/x.description "<roadmap item text>"',
    "without its backticks",
    '"Side track: <what>"',
    '"Off-roadmap: <what>"',
  ])
    expect(b).toContain(part);
  expect(pin(cycle({ branch: "main", item: "" }))).toContain(
    "main has no roadmap item",
  );
});

it("the repo's own ROADMAP.md and STATE.md have no format problems", () => {
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8"); // done-gate: allow reads ROADMAP.md and STATE.md, which are data
  expect(problems(read("ROADMAP.md"), read("STATE.md"))).toEqual([]);
});

// Hooks drop the output of a command that fails or is not found, so the wrapper must always print.
const hook = (env: Record<string, string>) =>
  spawnSync("sh", ["scripts/cycle-hook.sh", "--pin"], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });

it("the hook wrapper prints the pin and exits 0", () => {
  const r = hook({ ...process.env } as Record<string, string>);
  expect(r.status).toBe(0);
  expect(r.stdout).toStartWith("CYCLE:");
});

it("the hook wrapper finds bun in ~/.bun/bin when it is not on PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "cycle-home-"));
  try {
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, ".bun", "bin", "bun"));
    const r = hook({ PATH: "/usr/bin:/bin", HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toStartWith("CYCLE:");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("the hook wrapper says CYCLE UNKNOWN and exits 0 when bun is missing", () => {
  const r = hook({ PATH: "/usr/bin:/bin", HOME: "/nonexistent" });
  expect(r.status).toBe(0);
  expect(r.stdout).toStartWith("CYCLE UNKNOWN");
});

it('a "Blocked by" line that means nothing but is not exactly "nothing" is a format problem, and the slice stays blocked', () => {
  const at = (v: string) => parseRoadmap(roadmap(slice(0, "in progress", v)));
  for (const v of [
    "Nothing",
    "NOTHING",
    "None",
    "N/A",
    "nil",
    "—",
    "-",
    "",
    "nothing (Slice 0 done)",
    "nothing.",
    "nothing — keys delivered",
    "nothing - Slice 2 done",
    "nothing -",
    "nothing; Slice 2 done",
    "nothing, Slice 2 done",
    "nothing: Slice 2 done",
    "nothing—done",
    "nothing (keys delivered 2026-10-05)",
    "nothing <!-- keys delivered -->",
    "nothing. Slice 2 is done.",
    "[nothing]",
    "(nothing; Slice 2 done)",
    "`nothing`",
    "**nothing**",
    '"nothing"',
    "(nothing)",
    "(none)",
    "~~Slice 2~~ nothing",
    "no",
    "No.",
    "not blocked",
    "Not blocked",
    "unblocked",
    "clear",
  ]) {
    const { slices, problems: found } = at(v);
    expect(currentSlice(slices)).toBeUndefined();
    expect([v, found.join("\n")]).toEqual([
      v,
      expect.stringContaining('write exactly "Blocked by: nothing"'),
    ]);
  }
  // a real blocker, even one that starts with a word or dash that could mean nothing
  for (const v of [
    "Slice 2",
    "Meta test number (Devesh)",
    "Nothing but the Meta test number (Devesh)",
    "None of the three Meta items yet (Devesh)",
    "No blocker except Slice 2",
    "No test number yet (Devesh)",
    "- Slice 2",
    "— the Meta test number (Devesh)",
    "N/A until the pilot contract (Devesh)",
    "Nil balance on the Vapi account (Devesh)",
    "Nilesh signs the contract (Devesh)",
    "Slice 2: the Meta keys (Devesh)",
    "No-reply from Meta (Devesh)",
  ]) {
    const { slices, problems: found } = at(v);
    expect(currentSlice(slices)).toBeUndefined();
    expect([v, found]).toEqual([v, []]);
  }
  expect(currentSlice(at("nothing").slices)?.n).toBe(0);
  expect(at("nothing").problems).toEqual([]);
});

it("both parsers ignore a byte-order mark at the start of the file", () => {
  const r = parseRoadmap(`\uFEFF${slice(0, "in progress")}`);
  expect(r.problems).toEqual([]);
  expect(currentSlice(r.slices)?.n).toBe(0);
  const s = parseState(`\uFEFF${STATE}`);
  expect(s.problems).toEqual([]);
  expect(s.phase).toBe("SETUP");
});

it('a "## " section that is neither a slice nor the Side track is a format problem', () => {
  for (const h of ["slice 1: T", " Slice 1: T", "Slice1: T", "Notes"])
    expect(
      parseRoadmap(roadmap(slice(0, "in progress"), `## ${h}\nStatus: x\n`))
        .problems,
    ).toEqual([expect.stringContaining(`"## ${h}"`)]);
  expect(
    parseRoadmap(
      roadmap(
        slice(0, "in progress"),
        "## Side track: marketing site\nfree text\n",
      ),
    ).problems,
  ).toEqual([]);
});

it("reads STATE.md → Rule changes for the tracker page, one entry per line", () => {
  const s = parseState(
    `${STATE}\n## Rule changes\n\nNewest first.\n\n- 2026-10-02 · [#9](https://example.com) · biome.json · tighter\n- 2026-10-01 · [#8](https://example.com) · AGENTS.md · looser\n`,
  );
  expect(s.problems).toEqual([]);
  expect(s.ruleChanges).toEqual([
    "2026-10-02 · [#9](https://example.com) · biome.json · tighter",
    "2026-10-01 · [#8](https://example.com) · AGENTS.md · looser",
  ]);
  expect(parseState(STATE).ruleChanges).toEqual([]);
});

it("both parsers read files saved with Windows line endings", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const r = parseRoadmap(
    crlf(roadmap(slice(0, "in progress"), slice(1, "not started"))),
  );
  expect(r.problems).toEqual([]);
  expect(currentSlice(r.slices)?.title).toBe("Title 0");
  const s = parseState(crlf(STATE));
  expect(s.problems).toEqual([]);
  expect(s.phase).toBe("SETUP");
});

it("STATE.md line 1 must be exactly PHASE: SETUP or PHASE: LIVE, and only SETUP lets agents merge", () => {
  const withPhase = (first: string) => STATE.replace("PHASE: SETUP", first);
  for (const bad of [
    "PHASE: Live",
    "PHASE: live",
    "Phase: LIVE",
    "PHASE: **LIVE**",
    "# State\nPHASE: SETUP",
  ]) {
    expect(parseState(withPhase(bad)).problems.join("\n")).toContain(
      "line 1 must be",
    );
    const b = banner(cycle({ state: withPhase(bad) }));
    expect(b).toContain("only humans merge");
    expect(b).not.toContain("agents may merge");
  }
  expect(parseState(withPhase("PHASE: SETUP  <!-- note -->")).problems).toEqual(
    [],
  );
  expect(banner(cycle())).toContain("agents may merge");
  expect(banner(cycle({ state: withPhase("PHASE: LIVE") }))).toContain(
    "only humans merge",
  );
});

it("the banner gives every first line rules-from-main accepts, and the fix-when-touched line", () => {
  const b = banner(cycle());
  for (const form of [
    '"Roadmap: Slice N — <item>"',
    '"Roadmap: Slice N — replan: <what>"',
    '"Roadmap: Side track — <what>"',
    '"Roadmap: off-roadmap — <what>"',
    "`Fix-when-touched: <entry number> · fixed | not applicable · <how or why>`",
  ])
    expect(b).toContain(form);
});

it("the pin sums up how to handle a new ask (AGENTS.md → The loop, step 1) in one short line", () => {
  const p = pin(cycle());
  expect(p.split("\n")).toHaveLength(1);
  expect(p.length).toBeLessThan(480);
  for (const part of [
    "question",
    "outside the repo",
    "Side track",
    "later slice",
    '"off-roadmap PR, or replan?"',
    "one off-roadmap PR",
  ])
    expect(p).toContain(part);
});

it('"Side track: …" and "Off-roadmap: …" branch descriptions are valid, and say which kind', () => {
  const side = cycle({ item: "Side track: new hero copy" });
  const off = cycle({ item: "Off-roadmap: fix duplicate seed contacts" });
  expect(pin(side)).toContain('Side-track work "new hero copy"');
  expect(pin(off)).toContain('off-roadmap work "fix duplicate seed contacts"');
  expect(pin(cycle())).toContain('roadmap item "Keep agents on the plan"');
  for (const c of [side, off]) {
    expect(pin(c)).not.toContain("has no roadmap item");
    expect(banner(c)).not.toContain("has no roadmap item");
    expect(banner(c)).toContain("no roadmap line to tick");
  }
});

it("near misses of those prefixes count too; any other description must be a roadmap item's text", () => {
  for (const item of [
    "Side-track: hero",
    "Side track - hero",
    "sidetrack — hero",
    "SIDE TRACK:hero",
  ])
    expect([item, pin(cycle({ item }))]).toEqual([
      item,
      expect.stringContaining('Side-track work "hero"'),
    ]);
  for (const item of [
    "Off roadmap: seed",
    "Offroadmap: seed",
    "off-roadmap - seed",
  ])
    expect([item, pin(cycle({ item }))]).toEqual([
      item,
      expect.stringContaining('off-roadmap work "seed"'),
    ]);
  for (const item of [
    "Track: marketing site",
    "Side track:",
    "Keep agents on the plan too",
  ]) {
    const [p, b] = [pin(cycle({ item })), banner(cycle({ item }))];
    expect([item, p]).toEqual([
      item,
      expect.stringContaining("matches no roadmap item"),
    ]);
    expect(p.length).toBeLessThan(480);
    expect(b).not.toContain("builds the roadmap item");
    expect(b).toContain(
      'git config branch.feat/x.description "<roadmap item text>"',
    );
  }
  expect(pin(cycle({ item: "keep  agents on the PLAN" }))).toContain(
    'roadmap item "keep  agents on the PLAN"',
  );
  // backticks and quotes may be left out or curled (the shell runs a backticked command in "…")
  const marked = cycle({
    roadmap: roadmap(
      slice(
        0,
        "in progress",
        "nothing",
        '- [ ] `bun run demo --keep` leaves it (agent)\n- [ ] When a lead says "don\'t contact me", record it (agent)',
      ),
    ),
  });
  for (const item of [
    "`bun run demo --keep` leaves it",
    "bun run demo --keep leaves it",
    'When a lead says "don\'t contact me", record it',
    "When a lead says don't contact me, record it",
    "When a lead says dont contact me, record it",
    "When a lead says “don’t contact me”, record it",
  ])
    expect([item, pin({ ...marked, item })]).toEqual([
      item,
      expect.stringContaining("this branch builds roadmap item"),
    ]);
  expect(pin({ ...marked, item: "bun run demo leaves it" })).toContain(
    "matches no roadmap item",
  );
  // a replan adds its line to ROADMAP.md on the branch that builds it, before origin/main has it
  const replan = cycle({
    item: "Replanned item",
    branchRoadmap: roadmap(
      slice(0, "in progress", "nothing", "- [ ] Replanned item (agent)"),
    ),
  });
  expect(pin(replan)).toContain('roadmap item "Replanned item"');
  expect(banner(replan)).toContain("builds the roadmap item: Replanned item");
});

// A throwaway repo shaped like this one: a clone (origin = src) with a second worktree on feat/y.
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cycle-"));
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        ...["user.name=t", "user.email=t@t", "commit.gpgsign=false"].flatMap(
          (c) => ["-c", c],
        ),
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const src = join(dir, "src");
  for (const [f, body] of [
    ...[
      "scripts/cycle.ts",
      "scripts/cycle-hook.sh",
      "docs/tracker/parse.js",
      "scripts/proof/latest.ts",
      "scripts/done-gate/proof-run.ts",
      "scripts/done-gate/mac-record.ts",
      "scripts/done-gate/git.ts",
    ].map((f) => [f, readFileSync(join(ROOT, f), "utf8")]), // done-gate: allow copies the real scripts into a scratch repo to run them
    [
      "ROADMAP.md",
      roadmap(slice(0, "in progress", "nothing", "- [ ] Build item Y (agent)")),
    ],
    ["STATE.md", STATE],
  ]) {
    mkdirSync(join(src, f, ".."), { recursive: true });
    writeFileSync(join(src, f), body);
  }
  run(src, "init", "-q", "-b", "main");
  run(src, "add", "-A");
  run(src, "commit", "-qm", "init");
  const work = join(dir, "work");
  run(dir, "clone", "-q", src, work);
  run(work, "worktree", "add", "-q", "-b", "feat/y", join(dir, "wt"));
  run(work, "config", "branch.feat/y.description", "Build item Y");
  // As Claude Code runs it: from another folder, the hook's JSON on stdin.
  const hookIn = (flag: string, input: string) =>
    spawnSync("sh", [join(work, "scripts/cycle-hook.sh"), flag], {
      cwd: tmpdir(),
      encoding: "utf8",
      input,
      env: process.env as Record<string, string>,
    });
  return { dir, work, wt: join(dir, "wt"), run, hookIn };
}

it("the pin names the branch of the folder the agent works in (the hook's cwd), else its own checkout", () => {
  const { dir, work, wt, run, hookIn } = scratchRepo();
  const at = (cwd: string) => hookIn("--pin", JSON.stringify({ cwd }));
  try {
    for (const cwd of [wt, join(wt, "scripts")])
      expect(at(cwd).stdout).toContain('roadmap item "Build item Y"');
    // a replan's new line counts once it is in that folder's ROADMAP.md, committed or not
    run(work, "config", "branch.feat/y.description", "Replanned item Z");
    expect(at(wt).stdout).toContain("matches no roadmap item");
    writeFileSync(
      join(wt, "ROADMAP.md"),
      roadmap(
        slice(0, "in progress", "nothing", "- [ ] Replanned item Z (agent)"),
      ),
    );
    expect(at(wt).stdout).toContain('roadmap item "Replanned item Z"');
    // its own checkout, another repository, a missing folder, junk input: fall back to this checkout
    for (const r of [
      at(work),
      at(ROOT),
      at("/nonexistent"),
      hookIn("--pin", "not json"),
    ]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("main has no roadmap item");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the banner says the plan may be out of date when it could not fetch origin/main", () => {
  const { dir, work, run, hookIn } = scratchRepo();
  try {
    expect(hookIn("--banner", "").stdout).not.toContain("out of date");
    run(work, "remote", "set-url", "origin", join(dir, "gone.git"));
    const r = hookIn("--banner", "");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("last fetch");
    expect(r.stdout).toContain("could be out of date");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the banner shows a proof-ready slice's latest proof run, read with gh, or says it could not read them", () => {
  const { dir, work, run } = scratchRepo();
  try {
    // origin/main sets Slice 0 to proof ready; the banner's fetch brings it in
    const src = join(dir, "src");
    writeFileSync(
      join(src, "ROADMAP.md"),
      roadmap(slice(0, "proof ready", "nothing", "- [x] Build item Y (agent)")),
    );
    run(src, "commit", "-qam", "Slice 0 is proof ready");
    // A stand-in gh: the proof workflow's runs and a run's jobs, as gh prints them, or GitHub's 404 before it runs
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const URL = "https://github.com/o/r/actions/runs/555";
    const listed = [
      {
        databaseId: 555,
        displayTitle: "Proof of every proof-ready or done slice (schedule)",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-10-05T03:23:11Z",
        url: URL,
      },
    ];
    const jobs = {
      jobs: [
        {
          name: "proof (0)",
          status: "completed",
          conclusion: "success",
          steps: [
            { name: "Prove Slice 0", conclusion: "success" },
            { name: "Every step passed", conclusion: "success" },
          ],
        },
      ],
    };
    const bannerWith = (gh: string) => {
      writeFileSync(join(bin, "gh"), gh);
      chmodSync(join(bin, "gh"), 0o755);
      return spawnSync(
        "sh",
        [join(work, "scripts/cycle-hook.sh"), "--banner"],
        {
          cwd: tmpdir(),
          encoding: "utf8",
          input: "",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      ).stdout;
    };
    expect(
      bannerWith(
        `#!/bin/sh\ncase "$1 $2" in\n"run list") echo '${JSON.stringify(listed)}' ;;\n"run view") echo '${JSON.stringify(jobs)}' ;;\nesac\n`,
      ),
    ).toContain(
      `Slice 0 (proof ready): its latest proof run passed on 2026-10-05: ${URL}. Set it to done: "Status: done" and "Proof passed: 2026-10-05 · [run 555](${URL})"`,
    );
    expect(
      bannerWith(
        `#!/bin/sh\necho "HTTP 404: workflow proof.yml not found on the default branch" >&2\nexit 1\n`,
      ),
    ).toContain(
      "Proof runs: could not read them (gh run list failed: HTTP 404: workflow proof.yml not found on the default branch)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A scratch repo whose remote never answers: git runs remote.sh, which waits on a pipe nobody
// writes to. left() lists the processes still running from it, with their full command lines
// (`ps -o args`: on Linux, `pgrep -l` prints only the program name, never "remote.sh").
function hangingRemote() {
  const s = scratchRepo();
  const fifo = join(s.dir, "never");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  writeFileSync(join(s.dir, "remote.sh"), `read x < "${fifo}"\n`);
  s.run(s.work, "config", "protocol.ext.allow", "always");
  s.run(s.work, "remote", "set-url", "origin", `ext::sh ${s.dir}/remote.sh`);
  const left = () =>
    spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(s.dir))
      .join("\n");
  const gone = async () => {
    for (let i = 0; left() && i < 20; i++) await Bun.sleep(100);
    return left();
  };
  const clean = () => {
    spawnSync("pkill", ["-f", s.dir]);
    rmSync(s.dir, { recursive: true, force: true });
  };
  return { ...s, left, gone, clean };
}

it("a fetch that times out leaves no git process running", async () => {
  const { hookIn, gone, clean } = hangingRemote();
  try {
    const r = hookIn("--banner", "");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("could be out of date");
    expect(await gone()).toBe("");
  } finally {
    clean();
  }
}, 20_000);

it("Ctrl-C during the fetch leaves no git process running", async () => {
  const { work, left, gone, clean } = hangingRemote();
  try {
    // Ctrl-C signals the terminal's foreground process group, so the hook gets a group of its own.
    const p = Bun.spawn(
      ["sh", join(work, "scripts/cycle-hook.sh"), "--banner"],
      {
        cwd: tmpdir(),
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    for (let i = 0; !left().includes("remote.sh") && i < 50; i++)
      await Bun.sleep(100);
    expect(left()).toContain("remote.sh");
    process.kill(-p.pid, "SIGINT");
    await p.exited;
    expect(await gone()).toBe("");
  } finally {
    clean();
  }
}, 20_000);

it("a run whose stdin stays open does not wait for it", async () => {
  const p = Bun.spawn([process.execPath, "scripts/cycle.ts", "--pin"], {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
  });
  const code = await Promise.race([
    p.exited,
    Bun.sleep(4000).then(() => "hung"),
  ]);
  p.kill();
  expect(code).toBe(0);
  expect(await new Response(p.stdout).text()).toStartWith("CYCLE:");
});
