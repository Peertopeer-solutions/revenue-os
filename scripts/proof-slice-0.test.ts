// Slice 0's proof steps (scripts/proof/slice-0*.ts), run as `bun run proof 0` runs them: against this checkout as it
// is on disk, committed in a scratch repository (a step proves a commit), in scratch copies each step makes and
// removes. A step whose safeguard this checkout has must pass here, and every refusal step must fail on a checkout
// whose gate, hooks and guards refuse nothing, so none passes on its own. The scripted agent session and the
// verifier's run use a stand-in `claude` on the PATH, never a real model or key. Two steps run only in `bun run proof
// 0`: the whole suite run at once (it starts the suite, this file included) and the read of GitHub's real run
// records (judged as data in scripts/proof-slice-0-runs.test.ts).
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentSlice, nextItem, parseRoadmap } from "../docs/tracker/parse.js";
import {
  copyOf,
  failures,
  git,
  HERE,
  prove,
  ROOT,
  removeScratch,
  STATE,
  scratch,
  standIn,
} from "../tests/proof-stand-ins";
import { stateDir } from "./done-gate/store";
import { runSteps } from "./proof/run";
import { agentSession, crossCompany } from "./proof/slice-0-agents";
import {
  adminMerge,
  disallowedModel,
  interrupted,
  noDockerStop,
  selfPass,
  undeliveredRuling,
  unverifiedMerge,
  unverifiedStop,
  wrappedMerge,
} from "./proof/slice-0-gate";
import { banner } from "./proof/slice-0-plan";
import {
  barrelExport,
  deletedTest,
  editedMigration,
  fixWhenTouchedUnanswered,
  loosenedGate,
  noFirstLine,
  rewrittenCi,
  unexplainedRuleChange,
} from "./proof/slice-0-rules";
import {
  passesOnMain,
  patternFileGuard,
  unrunLine,
} from "./proof/slice-0-tests";
import { agentToolsRefused, hooksWarn } from "./proof/slice-0-tools";
import { SLICES } from "./proof/slices";

setDefaultTimeout(120_000); // a step clones this checkout and starts bun and git several times
afterAll(removeScratch);
/** `file` in `dir` with `from` replaced by `to`; throws when `from` is not there, so a copy never silently stays the same. */
const replaced = (dir: string, file: string, from: string, to: string) => {
  const text = readFileSync(join(dir, file), "utf8"); // done-gate: allow read only to write a changed copy into a scratch clone, never to check what it says
  if (!text.includes(from)) throw new Error(`${file} no longer has ${from}`);
  writeFileSync(join(dir, file), text.replace(from, to));
};

// The refusals, each of whose safeguards is on main today.
const ON_MAIN = [
  hooksWarn,
  unexplainedRuleChange,
  loosenedGate,
  rewrittenCi,
  noFirstLine,
  fixWhenTouchedUnanswered,
  agentToolsRefused,
  editedMigration,
  patternFileGuard,
  unverifiedStop,
  unverifiedMerge,
  selfPass,
  undeliveredRuling,
  disallowedModel,
  wrappedMerge,
  adminMerge,
  noDockerStop,
  deletedTest,
  barrelExport,
  unrunLine,
  passesOnMain,
  interrupted,
];

describe("Slice 0's proof steps", () => {
  it("follow its Proof line: one step per check it names, in its order, each in its words", async () => {
    const named = [
      "four law files",
      "`bun run cycle --banner`",
      "scripted fresh agent session",
      "entry file missing",
      "doesn't explain it or that adds no line to STATE.md → Rule changes",
      "loosens its own copy of the gate",
      "rewrites ci.yml",
      "without its roadmap first line",
      "fix-when-touched area",
      "push to the cloud database",
      "GitHub's run records",
      "edits a migration already on main",
      "two test runs started at once",
      "pattern file naming a missing file",
      "deliberately unverified change",
      "its merge",
      "records for itself",
      "the verifier did not deliver",
      "not on the allowed list",
      "wrapped in another command",
      "`--admin`",
      "without Docker",
      "deleted test",
      "only a barrel file re-exports",
      "added product line no test runs",
      "already passes on main",
      "cross-company test",
      "interrupted, unchecked change",
    ];
    const proof =
      parseRoadmap(git(HERE(), "show", "HEAD:ROADMAP.md")).slices.find(
        (s) => s.n === 0,
      )?.Proof ?? "";
    expect(named.filter((n) => !proof.includes(n))).toEqual([]);
    // What `bun run proof 0` reports each step did, in its order: from a run of the slice's steps whose time is
    // already up, so that none of them runs.
    const slice0 = await runSteps(SLICES[0] ?? [], {
      root: HERE(),
      env: {},
      state: STATE,
      dir: scratch("proof-0-report-"),
      minutes: 0,
    });
    // Every phrase it quotes (a prompt, a test it cites by name) and every test file it names is in a step's words.
    const cited = [
      ...(proof.match(/"[^"]+"/g) ?? []).map((q) => q.slice(1, -1)),
      ...(proof.match(/scripts\/[\w./-]+\.test\.ts/g) ?? []),
    ];
    expect(cited.length).toBe(11);
    expect(
      cited.filter((c) => !slice0.some((s) => s.does.includes(c))),
    ).toEqual([]);
    expect(slice0.length).toBe(named.length);
    expect(
      slice0.flatMap((s, i) =>
        s.does.includes(named[i] ?? "") ? [] : [`${i + 1}: ${s.does}`],
      ),
    ).toEqual([]);
  });

  it("the banner step passes, naming the slice and item the tracker's parser finds on origin/main", async () => {
    const [r] = await prove([banner]);
    const roadmap = parseRoadmap(
      git(HERE(), "show", "origin/main:ROADMAP.md"),
    ).slices;
    const cur = currentSlice(roadmap);
    expect(r?.outcome).toBe("passed");
    expect(r?.seen).toContain(`Slice ${cur?.n}`);
    expect(r?.seen).toContain(nextItem(cur)?.text.slice(0, 40) ?? "no item");
  });

  it("each refusal whose safeguard is on this checkout passes here, refused for its own reason", async () => {
    expect(failures(await prove(ON_MAIN))).toEqual([]);
  }, 600_000);

  it("every refusal step fails on a checkout whose gate, hooks and guards refuse nothing", async () => {
    // The gate's entry does nothing, the hooks go quiet when it is missing, and the guards pass anything.
    const weak = copyOf((dir) => {
      writeFileSync(join(dir, "scripts", "done-gate.ts"), "process.exit(0);\n");
      writeFileSync(join(dir, "scripts", "guards.sh"), "exit 0\n");
      const quiet = JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    'f="$CLAUDE_PROJECT_DIR/scripts/done-gate.ts"; [ -f "$f" ] || exit 0; exec bun "$f" hook',
                },
              ],
            },
          ],
        },
      });
      writeFileSync(join(dir, ".claude", "settings.json"), quiet);
      writeFileSync(join(dir, ".codex", "hooks.json"), quiet);
    }, "a gate that refuses nothing");
    const results = await prove(ON_MAIN, weak);
    expect(results.filter((r) => r.outcome !== "failed")).toEqual([]);
    expect(results.every((r) => r.seen.length > 0)).toBe(true);
  }, 600_000);
});

describe("main's copy of rules-from-main, as GitHub runs it", () => {
  const WORKFLOW = join(".github", "workflows", "rules-from-main.yml");
  const JUDGE = "run: bun scripts/done-gate.ts pr";

  it("a branch's loosened gate and rewritten ci.yml are refused only because GitHub runs main's copy of the workflow: on `pull_request` both steps fail", async () => {
    const own = copyOf((dir) =>
      replaced(dir, WORKFLOW, "pull_request_target:", "pull_request:"),
    );
    const results = await prove([loosenedGate, rewrittenCi], own);
    expect(results.map((r) => [r.outcome, r.seen])).toEqual([
      ["failed", expect.stringContaining("pull_request")],
      ["failed", expect.stringContaining("pull_request")],
    ]);
  }, 300_000);

  it("the loosened-gate step fails when the workflow judges with the branch's own copy of the gate", async () => {
    const own = copyOf((dir) =>
      replaced(
        dir,
        WORKFLOW,
        JUDGE,
        "run: git checkout -q refs/pr/head && bun scripts/done-gate.ts pr",
      ),
    );
    const [r] = await prove([loosenedGate], own);
    expect(r?.outcome).toBe("failed");
  }, 300_000);

  it("the rewritten-ci step fails when main's copy does not count ci.yml as a rule file, or the workflow judges nothing", async () => {
    const unruled = copyOf((dir) =>
      replaced(dir, "scripts/done-gate/rules.ts", "^(\\.github\\/|", "^("),
    );
    const idle = copyOf((dir) =>
      replaced(dir, WORKFLOW, JUDGE, "run: echo judged nothing # "),
    );
    for (const copy of [unruled, idle]) {
      const [r] = await prove([rewrittenCi], copy);
      expect(r?.outcome).toBe("failed");
    }
  }, 300_000);
});

describe("the merge steps, with a merge queue on main's rules and without one", () => {
  it("fail on a copy whose merge check never asks GitHub whether main has a merge queue", async () => {
    const noQueue = copyOf((dir) =>
      replaced(
        dir,
        "scripts/done-gate/merge-gate.ts",
        "const queue = mainQueue(github, repo);",
        "const queue = { queue: false };",
      ),
    );
    const results = await prove([wrappedMerge, adminMerge], noQueue);
    expect(results.map((r) => [r.outcome, r.seen])).toEqual([
      [
        "failed",
        expect.stringContaining(
          "with a merge queue on main, the merge went through as: Done gate ✓ merge of",
        ),
      ],
      [
        "failed",
        expect.stringContaining(
          "with a merge queue on main, the merge went through as: Done gate ✓ merge of",
        ),
      ],
    ]);
  }, 300_000);
});

describe("the gate's hook, as the steps start it", () => {
  it("never gets the run's GitHub token or evals key, whichever helper starts it", async () => {
    const bin = scratch("proof-0-bun-");
    const log = join(bin, "env.txt");
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh\necho "gh=\${GH_TOKEN:-none} evals=\${ANTHROPIC_EVALS_KEY:-none}" >> "${log}"\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    const was = { ...process.env };
    Object.assign(process.env, {
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "sentinel-gh-token",
      ANTHROPIC_EVALS_KEY: "sentinel-evals-key",
    });
    let results: Awaited<ReturnType<typeof prove>>;
    try {
      results = await prove([undeliveredRuling, adminMerge]);
    } finally {
      for (const k of ["PATH", "GH_TOKEN", "ANTHROPIC_EVALS_KEY"])
        if (was[k] === undefined) delete process.env[k];
        else process.env[k] = was[k];
    }
    expect(failures(results)).toEqual([]);
    const calls = readFileSync(join(bin, "env.txt"), "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.filter((c) => c !== "gh=none evals=none")).toEqual([]);
  }, 300_000);
});

describe("the step for a session started after interrupted work", () => {
  it("hands the gate that work as it is left: in a worktree of its own, by a session quiet for 15 minutes and more", async () => {
    // A stand-in gate that logs each call, holds the second session at its start and sends its stop back until the
    // checks have passed: the step's own checks pass on it, so what is under test is what the step hands the gate.
    const held = scratch("proof-0-held-");
    const log = join(held, "calls.txt");
    const repo = scratch("proof-0-stand-in-");
    mkdirSync(join(repo, "scripts"));
    writeFileSync(
      join(repo, "scripts", "done-gate.ts"),
      `import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const rev = (what: string) => spawnSync("git", ["rev-parse", "--path-format=absolute", what], { encoding: "utf8" }).stdout.trim();
const common = rev("--git-common-dir");
const [cmd, ...args] = process.argv.slice(2);
const input = cmd === "hook" ? await Bun.stdin.json() : {};
appendFileSync(${JSON.stringify(log)}, \`\${JSON.stringify({ cmd, event: input.hook_event_name, session: input.session_id, worktree: rev("--git-dir") !== common, at: Date.now() })}\\n\`);
if (cmd === "checkpoint") writeFileSync(\`\${common}/next.txt\`, args[args.indexOf("--next") + 1] ?? "");
const two = input.session_id === "proof-2";
if (two && input.hook_event_name === "SessionStart")
  console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: \`Next step: \${readFileSync(\`\${common}/next.txt\`, "utf8")}\` }, systemMessage: "Done gate: this session is held to unchecked work" }));
if (two && input.hook_event_name === "Stop" && !existsSync(\`\${common}/done-gate/checked\`))
  console.log(JSON.stringify({ decision: "block", reason: "the checks have not passed" }));
`,
    );
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "a stand-in gate",
    );
    const [r] = await prove([interrupted], repo);
    expect(r?.seen).toContain("held");
    expect(r?.outcome).toBe("passed");
    type Call = {
      session?: string;
      cmd: string;
      worktree: boolean;
      at: number;
    };
    const calls = readFileSync(join(held, "calls.txt"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Call);
    expect(calls.filter((c) => !c.worktree)).toEqual([]);
    const before = calls.filter(
      (c) => c.session === "proof-1" || c.cmd === "checkpoint",
    );
    const after = calls.filter((c) => c.session === "proof-2");
    expect(before.length).toBeGreaterThan(2);
    expect(after.length).toBeGreaterThan(2);
    const quiet =
      Math.min(...after.map((c) => c.at)) -
      Math.max(...before.map((c) => c.at));
    expect(quiet).toBeGreaterThanOrEqual(15 * 60_000);
  }, 120_000);
});

const TOKEN = "login-token-for-tests";

describe("the scripted fresh agent session, on Devesh's Mac", () => {
  /** Answers each scripted question as the repo's rules ask; on "dark mode" it first runs `onDarkMode`. */
  const session = (onDarkMode = ":") => {
    const roadmap = parseRoadmap(git(HERE(), "show", "HEAD:ROADMAP.md"));
    const cur = currentSlice(roadmap.slices);
    const item = nextItem(cur)?.text.split(/:\s/)[0] ?? "";
    return standIn([
      {
        when: "/ready",
        say: "It checks the READY_TOKEN bearer token, then that the worker reaches its database and its job queue (pg-boss), each within 2 seconds.",
      },
      {
        when: "dark mode",
        first: onDarkMode,
        say: "off-roadmap PR, or replan?",
      },
      { say: `We are on Slice ${cur?.n}, item: ${item}.` },
    ]);
  };
  const live = agentSession;

  it("holds four exchanges in one session in a fresh clone of main, with only Devesh's Claude login (kept from the commands it runs) and a home of its own, and saves the transcript", async () => {
    const claude = session();
    const [r] = await prove([live], HERE(), {
      ...claude.env,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      GH_TOKEN: "never-handed-on",
      ANTHROPIC_API_KEY: "another-key",
    });
    expect(r?.seen).not.toContain("✗");
    expect(r?.outcome).toBe("passed");
    expect(r?.files).toEqual(["1-agent-session.txt", "1-agent-session.jsonl"]);
    const calls = claude.calls();
    expect(calls.match(/^args: /gm)?.length).toBe(4);
    expect(calls.match(new RegExp(`^token: ${TOKEN}$`, "gm"))?.length).toBe(4);
    expect(calls.match(/^scrub: 1$/gm)?.length).toBe(4);
    expect(calls.match(/^api key: none$/gm)?.length).toBe(4);
    expect(calls).not.toContain("another-key");
    expect(calls).toContain("gh: none");
    expect(calls).not.toContain(`home: ${process.env.HOME}\n`);
    for (const dir of [ROOT, HERE()])
      expect(calls).not.toContain(`cwd: ${dir}\n`);
    expect(calls.match(/--resume stand-in/g)?.length).toBe(3);
  });

  it("fails, naming the branch, when the session makes one on 'add a dark mode to the console'", async () => {
    const claude = session("git checkout -qb feat/dark-mode");
    const [r] = await prove([live], HERE(), {
      ...claude.env,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    expect(r?.outcome).toBe("failed");
    expect(r?.seen).toContain("feat/dark-mode");
  });

  it("may run git to look around and make a branch, never to push", async () => {
    const claude = session();
    await prove([live], HERE(), {
      ...claude.env,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    const args = claude.calls().split("\n")[0] ?? "";
    expect(args).toContain("Bash(git checkout:*)");
    expect(args).not.toContain("Bash(git:*)");
    expect(args).not.toContain("push");
  });

  it("waits on Devesh, naming his Claude login, when Anthropic refuses it for its usage limit", async () => {
    const claude = standIn([
      {
        say: "Claude AI usage limit reached. Your limit will reset at 5pm.",
        error: true,
      },
    ]);
    const [r] = await prove([live], HERE(), {
      ...claude.env,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    expect(r?.outcome).toBe("waiting");
    expect(r?.seen).toContain("Devesh's Claude login");
    expect(r?.seen).toContain("usage limit reached");
  });
});

describe("the verifier's run on a change missing a cross-company test, on Devesh's Mac", () => {
  const verifier = (ruling: string, first?: string) =>
    standIn([{ say: `I ran its test.\n${ruling}`, first }]);
  // A copy of this checkout's commit: the step takes the proved checkout's turn on the shared local stack, which a
  // gate run of this checkout may be holding while it runs these tests.
  const root = () => copyOf(() => {});
  const live = crossCompany;

  it("passes when the verifier, started as the verifier agent with only Devesh's Claude login, rules FAIL for the other company, while it holds the shared local stack", async () => {
    const copy = root();
    const lock = join(stateDir(copy), "local-stack.lock");
    const lockDir = scratch("proof-0-lock-");
    const seen = join(lockDir, "seen.txt");
    const claude = verifier(
      "Ruling: FAIL — no test asks for another company's open tasks; add a cross-company test",
      `{ { test -f "${lock}" && echo held || echo free; } > "${seen}"; }`,
    );
    const [r] = await prove([live], copy, {
      ...claude.env,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    expect(r?.outcome).toBe("passed");
    expect(r?.files).toEqual(["1-verifier.txt", "1-verifier.jsonl"]);
    const calls = claude.calls();
    expect(calls).toContain("--agent verifier");
    expect(calls).toContain(`token: ${TOKEN}`);
    expect(calls).toContain("scrub: 1");
    expect(readFileSync(join(lockDir, "seen.txt"), "utf8").trim()).toBe("held");
  });

  it("fails when the verifier passes it, or fails it for another reason though its report names another company elsewhere", async () => {
    for (const ruling of [
      "Ruling: PASS — the count is right",
      "Another company's tasks are never counted, I checked.\nRuling: FAIL — nothing outside tests calls openTaskCount",
    ]) {
      const claude = verifier(ruling);
      const [r] = await prove([live], root(), {
        ...claude.env,
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      });
      expect(r?.outcome).toBe("failed");
      expect(r?.seen).toContain(ruling.includes("PASS") ? "PASS" : "FAIL");
    }
  });

  it("gives its sample a production caller and a test at the API layer, so the only thing missing is the other company", async () => {
    const diffDir = scratch("proof-0-diff-");
    const out = join(diffDir, "changed.txt");
    const claude = verifier(
      "Ruling: FAIL — add a cross-company test",
      `{ git diff --name-only main > "${out}"; }`,
    );
    await prove([live], root(), {
      ...claude.env,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    const changed = readFileSync(join(diffDir, "changed.txt"), "utf8");
    expect(changed).toContain("services/worker/src/routes/screens.ts");
    expect(changed).toMatch(/services\/worker\/test\/[\w-]+\.test\.ts/);
  });
});
