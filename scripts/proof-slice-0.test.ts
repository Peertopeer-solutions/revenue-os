// Slice 0's proof steps (scripts/proof/slice-0*.ts), run as `bun run proof 0` runs them: against this checkout as it
// is on disk, committed in a scratch repository (a step proves a commit), in scratch copies each step makes and
// removes. A step whose safeguard this checkout has must pass here, and every refusal step must fail on a checkout
// whose gate, hooks and guards refuse nothing, so none passes on its own. The scripted agent session and the
// verifier's run use a stand-in `claude` on the PATH, never a real model or key. Two steps run only in `bun run proof
// 0`: the whole suite run at once (it starts the suite, this file included) and the read of GitHub's real run
// records (judged as data in scripts/proof-slice-0-runs.test.ts).
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { currentSlice, nextItem, parseRoadmap } from "../docs/tracker/parse.js";
import {
  AGAIN,
  AI_STEPS,
  fingerprints,
  MAC_COMMAND,
  RECORD,
  RECORD_DIR,
} from "./done-gate/mac-record";
import { stateDir } from "./done-gate/store";
import { NO_TOKEN, proveOnMac } from "./proof/on-mac";
import { runSteps } from "./proof/run";
import { agentSession, crossCompany, onMac } from "./proof/slice-0-agents";
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
import type { Step } from "./proof/step";

setDefaultTimeout(120_000); // a step clones this checkout and starts bun and git several times
const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};
const KEY = "A second Anthropic key for the automatic test conversations";
const STATE = `PHASE: SETUP\n\n## Waiting on Devesh\n- [ ] **${KEY}**: saved in GitHub as ANTHROPIC_EVALS_KEY\n## Decisions in force\n`;
/** git in `dir` (its background clean-up off, as scripts/proof/scratch.ts has it): its output; throws when it fails. */
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync(
    "git",
    ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
let here: string | undefined;
/**
 * The repository the steps prove: this checkout's files as they are on disk (those git would track), as one commit,
 * which is also its origin/main. A step proves a commit (it clones it, or archives its gate), and this checkout's may
 * not hold what is on disk: the tests-proven check runs this file with a change copied over main's commit,
 * uncommitted. Nothing is fetched from this checkout, which may be shallow (on GitHub's runner the check's copy was,
 * and git then writes no fetched ref, though the fetch succeeds); its packages are this checkout's, for the tests the
 * steps run by name.
 */
const HERE = () => {
  if (here) return here;
  const dir = scratch("proof-0-here-");
  git(dir, "init", "-q", "-b", "main");
  const listed = git(
    ROOT,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  );
  for (const f of new Set(listed.split("\0").filter(Boolean))) {
    const from = join(ROOT, f);
    const st = lstatSync(from, { throwIfNoEntry: false });
    if (!st?.isFile() && !st?.isSymbolicLink()) continue; // deleted, or another repository's folder
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), join(dir, f));
    else copyFileSync(from, join(dir, f));
  }
  git(dir, "add", "-A", "-f");
  git(
    dir,
    "-c",
    "user.email=proof@example.invalid",
    "-c",
    "user.name=proof",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "this checkout as it is on disk",
  );
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  if (existsSync(join(ROOT, "node_modules")))
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  here = dir;
  return dir;
};
const prove = (steps: Step[], root = HERE(), env: NodeJS.ProcessEnv = {}) =>
  runSteps(steps, {
    root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    state: STATE,
    dir: scratch("proof-0-report-"),
  });
const failures = (results: { does: string; outcome: string; seen: string }[]) =>
  results.flatMap((r) =>
    r.outcome === "passed" ? [] : [`${r.does}\n  ${r.seen}`],
  );
/** A scratch copy of the proved repository's commit with `edit` applied and committed, as `main`. */
const copyOf = (edit: (dir: string) => void, message = "a changed copy") => {
  const dir = scratch("proof-0-copy-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "fetch", "-q", "--no-tags", HERE(), "+HEAD:refs/proof/base");
  git(dir, "checkout", "-q", "-B", "main", "refs/proof/base");
  edit(dir);
  spawnSync(
    "git",
    [
      "-c",
      "user.email=proof@example.invalid",
      "-c",
      "user.name=proof",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qam",
      message,
    ],
    { cwd: dir },
  );
  return dir;
};
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

type Answer = { when?: string; first?: string; say: string; error?: boolean };
/**
 * A stand-in `claude` that logs each call (its arguments, key, GitHub token, home and folder) and answers as
 * `claude -p --output-format stream-json` does: the first answer whose `when` the prompt (its last argument) holds,
 * after running `first` in its folder (`error`: as Claude Code reports an error from Anthropic's API).
 */
const standIn = (answers: Answer[]) => {
  const bin = scratch("proof-0-claude-");
  const log = join(bin, "calls.txt");
  const events = (text: string, error = false) =>
    [
      { type: "system", subtype: "init", session_id: "stand-in" },
      { type: "assistant", message: { content: [{ type: "text", text }] } },
      {
        type: "result",
        subtype: "success",
        is_error: error,
        session_id: "stand-in",
        result: text,
      },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join("");
  const cases = answers.map((a, i) => {
    writeFileSync(join(bin, `answer-${i}.txt`), events(a.say, a.error));
    return `  *"${a.when ?? ""}"*) ${a.first ?? ":"} >/dev/null 2>&1; cat "${join(bin, `answer-${i}.txt`)}" ;;`;
  });
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `{ echo "args: $*"; echo "token: $CLAUDE_CODE_OAUTH_TOKEN"; echo "api key: \${ANTHROPIC_API_KEY:-none}"; echo "scrub: \${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-off}"; echo "gh: \${GH_TOKEN:-none}"; echo "home: $HOME"; echo "cwd: $(pwd)"; } >> "${log}"`,
      "for last; do :; done",
      'case "$last" in',
      ...cases,
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    env: { PATH: `${bin}:${process.env.PATH}` },
    calls: () =>
      existsSync(log) ? readFileSync(join(bin, "calls.txt"), "utf8") : "", // the log above
  };
};

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
  const live = onMac["agent-session"];

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
  const live = onMac.verifier;

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

describe("Slice 0's AI steps on GitHub: the record Devesh's Mac run committed", () => {
  /** A copy of the proved commit with a record of a Mac run committed (each step's outcome as `outcomes` says), then `edit`. */
  const recorded = (
    outcomes: Partial<Record<(typeof AI_STEPS)[number], string>> = {},
    edit: (dir: string) => void = () => {},
  ) =>
    copyOf((dir) => {
      rmSync(join(dir, RECORD_DIR), { recursive: true, force: true });
      mkdirSync(join(dir, RECORD_DIR), { recursive: true });
      writeFileSync(
        join(dir, RECORD),
        JSON.stringify({
          commit: git(dir, "rev-parse", "HEAD"),
          date: "2026-10-14",
          claude: "2.1.299",
          steps: AI_STEPS.map((name) => ({
            name,
            outcome: outcomes[name] ?? "passed",
            seen: `${name} seen on the Mac`,
          })),
          files: fingerprints(dir, "HEAD"),
        }),
      );
      git(dir, "add", RECORD);
      edit(dir);
    }, "a record of a Mac run");
  const both = [agentSession, crossCompany];

  it("pass, naming the Mac run, when the committed record passed them and every file they test is as that run had it; no model runs", async () => {
    const claude = standIn([{ say: "never asked" }]);
    const results = await prove(both, recorded(), claude.env);
    expect(failures(results)).toEqual([]);
    for (const [i, r] of results.entries()) {
      expect(r.seen).toContain("passed on Devesh's Mac on 2026-10-14");
      expect(r.seen).toContain(`${AI_STEPS[i]} seen on the Mac`);
    }
    expect(claude.calls()).toBe("");
  });

  it("wait on Devesh's Mac, naming the command, with no record committed", async () => {
    const results = await prove(
      both,
      copyOf((dir) =>
        rmSync(join(dir, RECORD_DIR), { recursive: true, force: true }),
      ),
    );
    for (const r of results) {
      expect(r.outcome).toBe("waiting");
      expect(r.seen).toContain(AGAIN);
      expect(r.seen).toContain(MAC_COMMAND);
      expect(r.seen).toContain(`${RECORD} is not committed`);
    }
  });

  it("wait once a file they test changed since the Mac run, naming it", async () => {
    const results = await prove(
      both,
      recorded({}, (dir) => {
        appendFileSync(join(dir, "AGENTS.md"), "\nA new rule.\n");
        appendFileSync(join(dir, ".claude", "agents", "verifier.md"), "\n");
      }),
    );
    for (const r of results) {
      expect(r.outcome).toBe("waiting");
      expect(r.seen).toContain("2 file(s) those steps test changed");
      expect(r.seen).toContain(".claude/agents/verifier.md, AGENTS.md");
    }
  });

  it("fail the step the Mac run failed, saying what it saw there; the other still passes", async () => {
    const [session, verifierRun] = await prove(
      both,
      recorded({ verifier: "failed" }),
    );
    expect(session?.outcome).toBe("passed");
    expect(verifierRun?.outcome).toBe("failed");
    expect(verifierRun?.seen).toContain(
      "the verifier step failed on Devesh's Mac on 2026-10-14",
    );
    expect(verifierRun?.seen).toContain("verifier seen on the Mac");
  });
});

describe("bun run proof 0 --on-my-mac", () => {
  it("refuses without Devesh's Claude login, saying how to make one, and starts no session", async () => {
    const claude = standIn([{ say: "never asked" }]);
    const copy = copyOf(() => {});
    const r = await proveOnMac({
      root: copy,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...claude.env },
      state: STATE,
      dir: scratch("proof-0-mac-"),
    });
    expect(r.code).toBe(2);
    expect(r.text).toBe(NO_TOKEN);
    expect(r.text).toContain("claude setup-token");
    expect(claude.calls()).toBe("");
    expect(existsSync(join(copy, RECORD_DIR))).toBe(false);
  });

  it("runs both steps with his login and writes their record, transcripts and report, which GitHub's steps then pass on once committed", async () => {
    const roadmap = parseRoadmap(git(HERE(), "show", "HEAD:ROADMAP.md"));
    const cur = currentSlice(roadmap.slices);
    const claude = standIn([
      {
        when: "word for word",
        say: "I ran its test.\nRuling: FAIL — no test asks for another company's open tasks",
      },
      {
        when: "/ready",
        say: "It checks the READY_TOKEN bearer token, then that the worker reaches its database and its job queue (pg-boss), each within 2 seconds.",
      },
      { when: "dark mode", say: "off-roadmap PR, or replan?" },
      {
        say: `We are on Slice ${cur?.n}, item: ${nextItem(cur)?.text.split(/:\s/)[0] ?? ""}.`,
      },
    ]);
    const copy = copyOf(() => {});
    const r = await proveOnMac({
      root: copy,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...claude.env,
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      },
      state: STATE,
      dir: scratch("proof-0-mac-"),
    });
    expect(r.text).toContain("Both AI steps passed.");
    expect(r.code).toBe(0);
    const record = JSON.parse(readFileSync(join(copy, RECORD), "utf8"));
    expect(record.commit).toBe(git(copy, "rev-parse", "HEAD"));
    expect(
      record.steps.map((s: { name: string; outcome: string }) => [
        s.name,
        s.outcome,
      ]),
    ).toEqual(AI_STEPS.map((name) => [name, "passed"]));
    expect(record.files).toEqual(fingerprints(copy, "HEAD"));
    expect(Object.keys(record.files)).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".claude/agents/verifier.md",
        "scripts/done-gate.ts",
        "scripts/cycle.ts",
      ]),
    );
    for (const f of ["agent-session.txt", "verifier.txt", "report.md"])
      expect(existsSync(join(copy, RECORD_DIR, f))).toBe(true);
    expect(
      readFileSync(join(copy, RECORD_DIR, "agent-session.txt"), "utf8"),
    ).toContain("Devesh: which item are you on?");
    git(copy, "add", RECORD_DIR);
    git(
      copy,
      "-c",
      "user.email=p@p",
      "-c",
      "user.name=p",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "the record",
    );
    expect(failures(await prove([agentSession, crossCompany], copy))).toEqual(
      [],
    );
  });
});
