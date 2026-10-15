// Every stop judges what changed and says what it did not run. Each test drives the real hook in a throwaway
// repository holding a copy of the gate, its origin/main at its first commit, as a session's stop would. Its checks
// are the repository's own package.json scripts, which only say that they ran (the ones on the database also leave a
// mark in the git folder), and a machine without Docker is one whose `docker` can't run.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { noDocker as dockerMissing } from "./done-gate/checks";
import {
  removeTranscripts,
  runHook,
  verifierRun,
} from "./done-gate-verifier-run";
import { standInGitHub } from "./proof/gate";

const GATE = join(import.meta.dir, "done-gate.ts");
// A stop starts bun and git a dozen times, and some run every check; with other agents busy that passes bun's 5 s.
setDefaultTimeout(60_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  removeTranscripts();
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};
const sh = (dir: string, cmd: string[]) =>
  spawnSync(cmd[0] as string, cmd.slice(1), { cwd: dir, encoding: "utf8" });
const write = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
const commit = (dir: string) => {
  sh(dir, ["git", "add", "-A"]);
  sh(dir, [
    "git",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "x",
  ]);
};

// The checks `bun run gate` runs, as package.json scripts that only say they ran; the three on the database (tests,
// database policies, browser checks) each add a line to RAN, in the git folder, so no snapshot sees it.
const RAN = ".git/database-checks-ran";
const SCRIPTS = {
  typecheck: "echo typed",
  lint: "echo linted",
  guards: "echo guarded",
  "rls:check": `echo policies >> ${RAN}`,
  local: `echo tests >> ${RAN}; echo 3 pass; true`, // `bun run local bun run gate tests [e2e]`
};
const databaseChecksRan = (dir: string) =>
  existsSync(join(dir, RAN))
    ? readFileSync(join(dir, RAN), "utf8").trim().split("\n").length
    : 0;

/** A throwaway repository on `main` holding a copy of the gate and SCRIPTS, origin/main at its first commit. */
function repo() {
  const dir = scratch("done-gate-stop-");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(GATE, join(dir, "scripts", "done-gate.ts"));
  cpSync(
    join(import.meta.dir, "done-gate"),
    join(dir, "scripts", "done-gate"),
    { recursive: true },
  );
  write(
    dir,
    "docs/tracker/parse.js",
    readFileSync(
      join(import.meta.dir, "..", "docs", "tracker", "parse.js"),
      "utf8",
    ),
  );
  write(dir, "STATE.md", "# State\n");
  write(dir, "package.json", JSON.stringify({ scripts: SCRIPTS }));
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  commit(dir);
  sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

/** Someone else's branch, made before the session starts: a commit main does not hold, with a rule problem. */
const theirBranch = (dir: string, branch: string) => {
  sh(dir, ["git", "checkout", "-qb", branch]);
  write(dir, "services/worker/src/theirs.ts", "// @ts-ignore\n");
  commit(dir);
  sh(dir, ["git", "checkout", "-q", "main"]);
};
const RULE_PROBLEM =
  "services/worker/src/theirs.ts:1 switches the type checker off";

const start = (dir: string) =>
  runHook(GATE, dir, { hook_event_name: "SessionStart" });
const stop = (
  dir: string,
  input: Record<string, unknown> = {},
  env: Record<string, string> = {},
) => {
  const { out } = runHook(
    GATE,
    dir,
    { hook_event_name: "Stop", ...input },
    env,
  );
  return {
    sentBack: out.decision === "block",
    told: out.systemMessage ?? "",
    reason: out.reason ?? "",
  };
};
const QUIET = { sentBack: false, told: "", reason: "" };
const verified = (dir: string, note: string, ruling = "PASS") =>
  verifierRun(GATE, dir, { report: `Ruling: ${ruling} — ${note}` });
/** The session runs a shell command from `dir`: the hook before it notes the checkouts it runs in. */
const ran = (dir: string, command: string) =>
  runHook(GATE, dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
const ALL_CHECKS =
  "Done gate ✓ typecheck, lint, guards, 3 tests proven, break check, database policies, 3 tests, 3 browser checks";
const WAITING =
  "Done gate ⏳ NOT fully checked yet: tests, database policies and browser checks wait while background work runs; the first stop after it ends runs them";
const HERE =
  "Done gate ⚠ NOT fully checked: tests, database policies and browser checks did not run here; CI runs them";
const BACKGROUND = { background_tasks: [{ id: "t1", type: "shell" }] };

/**
 * A folder holding a `docker` that can't run, as on a machine where Docker is not installed, and bun: started from
 * there, bun's own folder leads the PATH the gate sets (scripts/done-gate.ts), so that docker is the one it finds, as
 * Homebrew may install a real docker beside a real bun.
 */
const noDockerBin = () => {
  const bin = scratch("no-docker-");
  write(bin, "docker", "#!/bin/sh\nexit 127\n");
  chmodSync(join(bin, "docker"), 0o755);
  try {
    linkSync(process.execPath, join(bin, "bun")); // bun names its own folder by the path it was started from
  } catch {
    copyFileSync(
      process.execPath,
      join(bin, "bun"),
      constants.COPYFILE_FICLONE,
    );
    chmodSync(join(bin, "bun"), 0o755);
  }
  return bin;
};

/** A stand-in GitHub for `dir` (scripts/proof/gate.ts): its pull request's head is `head`, and `checks` passed on it. */
const passingGh = (dir: string, head: string) =>
  standInGitHub(dir, scratch("gh-"), head).env;

describe("a stop judges a checkout whose latest commit main does not hold, however it got there", () => {
  it("judges work the session committed after it switches to main and back", () => {
    const dir = repo();
    start(dir);
    sh(dir, ["git", "checkout", "-qb", "feat/mine"]);
    write(dir, "services/worker/src/mine.ts", "// @ts-ignore\n");
    commit(dir);
    sh(dir, ["git", "checkout", "-q", "main"]);
    sh(dir, ["git", "checkout", "-q", "feat/mine"]);
    const r = stop(dir);
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "services/worker/src/mine.ts:1 switches the type checker off",
    );
  });

  it("judges a checkout reset to another branch's commit", () => {
    const dir = repo();
    theirBranch(dir, "feat/theirs");
    start(dir);
    sh(dir, ["git", "checkout", "-qb", "feat/mine"]);
    sh(dir, ["git", "reset", "-q", "--hard", "feat/theirs"]);
    const r = stop(dir);
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(RULE_PROBLEM);
  });

  it("judges a checkout fast-forwarded, or switched, to a commit main does not hold", () => {
    const dir = repo();
    theirBranch(dir, "feat/theirs");
    start(dir);
    sh(dir, ["git", "checkout", "-qb", "feat/mine"]);
    sh(dir, ["git", "merge", "-q", "--ff-only", "feat/theirs"]);
    expect(stop(dir).reason).toContain(RULE_PROBLEM);

    const other = repo();
    theirBranch(other, "feat/theirs");
    start(other);
    sh(other, ["git", "checkout", "-q", "feat/theirs"]); // to read a pull request: check it out in a worktree of its own
    expect(stop(other).reason).toContain(RULE_PROBLEM);
  });

  // behaviour already on main: only a comment in it now names docs/done-gate.md, where STATE.md's known holes moved
  it("does not judge a checkout whose latest commit is on origin/main: a pull, or a switch back to main", () => {
    const dir = repo();
    start(dir);
    theirBranch(dir, "teammate");
    sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "teammate"]); // merged on GitHub while the session ran
    sh(dir, ["git", "merge", "-q", "--ff-only", "origin/main"]); // the session pulls main
    expect(stop(dir)).toEqual(QUIET);

    sh(dir, ["git", "checkout", "-qb", "feat/mine"]);
    write(dir, "services/worker/src/mine.ts", "// @ts-ignore\n");
    commit(dir);
    expect(stop(dir).sentBack).toBe(true); // its own work, judged
    sh(dir, ["git", "checkout", "-q", "main"]); // and set aside: main's code is not the session's to answer for
    expect(stop(dir)).toEqual(QUIET); // a known hole (docs/done-gate.md): the merge check, not a stop, judges that commit
  });

  /** A worktree on a branch of the session's own, noted, holding a commit main does not hold. */
  const ownWorktree = () => {
    const dir = repo();
    start(dir);
    const wt = join(scratch("wt-"), "w");
    sh(dir, ["git", "worktree", "add", "-q", "-b", "feat/w", wt]);
    ran(dir, `cd ${wt} && git status`);
    write(wt, "services/worker/src/w.ts", "// @ts-ignore\n");
    commit(wt);
    return { dir, wt };
  };

  it("judges the session's commit in a worktree it removed and added again on the same branch", () => {
    const { dir, wt } = ownWorktree();
    sh(dir, ["git", "worktree", "remove", wt]);
    sh(dir, ["git", "worktree", "add", "-q", wt, "feat/w"]);
    ran(dir, `cd ${wt} && git status`);
    const r = stop(dir);
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "services/worker/src/w.ts:1 switches the type checker off",
    );
  });

  it("judges the session's commit in a worktree it moved", () => {
    const { dir, wt } = ownWorktree();
    const moved = join(scratch("wt-"), "moved");
    sh(dir, ["git", "worktree", "move", wt, moved]);
    ran(dir, `cd ${moved} && git status`);
    const r = stop(dir);
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "services/worker/src/w.ts:1 switches the type checker off",
    );
  });

  it("finds a worktree the session adds on someone else's branch as it is, to read their pull request", () => {
    const dir = repo();
    theirBranch(dir, "feat/theirs");
    start(dir);
    for (const how of [["feat/theirs"], ["--detach", "feat/theirs"]]) {
      const wt = join(scratch("wt-"), "w");
      sh(dir, ["git", "worktree", "add", "-q", wt, ...how]);
      ran(dir, `cd ${wt} && git status`);
      const r = stop(dir); // not sent back; Devesh is told once that it holds unverified work from before the session
      expect(r.sentBack).toBe(false);
      expect(r.told).toContain(
        "but it holds product changes from before the session",
      );
      sh(dir, ["git", "worktree", "remove", wt]);
    }
  });
});

describe("while background work runs, a stop still judges the done rules and the verifier; only the database checks wait", () => {
  it("sends the agent back on a rule problem", () => {
    const dir = repo();
    write(dir, "services/worker/src/a.ts", "// @ts-ignore\n");
    const r = stop(dir, BACKGROUND);
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "services/worker/src/a.ts:1 switches the type checker off",
    );
  });

  it("runs typecheck, lint and guards, leaves the database checks for the first stop after it ends, and says so", () => {
    const dir = repo();
    write(dir, "docs/notes.md", "hello\n");
    expect(stop(dir, BACKGROUND)).toEqual({ ...QUIET, told: WAITING });
    expect(databaseChecksRan(dir)).toBe(0);
    expect(stop(dir, { session_crons: [{ id: "c1" }] })).toEqual({
      ...QUIET,
      told: WAITING,
    }); // a scheduled job counts too, and the change was not taken as checked
    expect(stop(dir)).toEqual({
      ...QUIET,
      told: "Done gate ✓ typecheck, lint, guards, 3 tests proven, break check, database policies, 3 tests, 3 browser checks (no product code changed, so no verifier needed)",
    });
    expect(databaseChecksRan(dir)).toBe(5); // tests proven, break check, database policies, tests, browser checks
    expect(stop(dir)).toEqual(QUIET);
  });

  it("still asks for the verifier on product code, and shows its PASS without a ✓", () => {
    const dir = repo();
    start(dir);
    write(dir, "services/worker/src/route.ts", "const route = 1;\n");
    const r = stop(dir, BACKGROUND);
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      'Run the verifier agent (Agent tool, subagent_type "verifier")',
    );
    verified(dir, "saw the route answer 200");
    expect(stop(dir, BACKGROUND)).toEqual({
      ...QUIET,
      told: `${WAITING} · verifier PASS: saw the route answer 200`,
    });
    expect(databaseChecksRan(dir)).toBe(0);
  });

  it("waits for a verifier the agent started in the background, without sending it back, then reads its ruling", () => {
    const dir = repo();
    start(dir);
    write(dir, "services/worker/src/route.ts", "const route = 1;\n");
    // While it works, the session stops again and again. The gate knows it runs from its own start and stop hooks,
    // whatever shape Claude Code gives its entry in background_tasks.
    const agent = { background_tasks: [{ id: "a1", type: "local_agent" }] };
    verifierRun(GATE, dir, {
      report: "Ruling: PASS — saw the route answer 200",
      during: () => {
        for (let i = 0; i < 6; i++)
          expect(stop(dir, agent)).toEqual({
            ...QUIET,
            told: `${WAITING} · NOT verified yet: the verifier is still running, and the first stop after it ends reads its ruling`,
          });
      },
    });
    expect(stop(dir)).toEqual({
      ...QUIET,
      told: `${ALL_CHECKS} · verifier PASS: saw the route answer 200`,
    });
    expect(databaseChecksRan(dir)).toBe(5); // tests proven, break check, database policies, tests, browser checks
    // Once it stopped, other background work no longer stands in for a ruling on code it never saw.
    write(dir, "services/worker/src/route.ts", "const route = 2;\n");
    expect(stop(dir, BACKGROUND).sentBack).toBe(true);
  });

  it("judges the same code afresh at the first stop after the work ends, even after the agent gave up", () => {
    const dir = repo();
    start(dir);
    write(dir, "services/worker/src/route.ts", "const route = 1;\n");
    for (let i = 0; i < 5; i++)
      expect(stop(dir, BACKGROUND).sentBack).toBe(true);
    expect(stop(dir, BACKGROUND).told).toStartWith(
      "Done gate ✗ NOT DONE: the agent stopped after 5 tries",
    );
    verified(dir, "saw the route answer 200");
    expect(stop(dir)).toEqual({
      ...QUIET,
      told: `${ALL_CHECKS} · verifier PASS: saw the route answer 200`,
    });
    expect(databaseChecksRan(dir)).toBe(5); // tests proven, break check, database policies, tests, browser checks
  });

  it("never lets a stop's pass while background work ran count at merge on a machine with Docker", () => {
    const dir = repo();
    start(dir);
    sh(dir, ["git", "checkout", "-qb", "feat/notes"]);
    write(dir, "docs/notes.md", "hello\n");
    commit(dir);
    const head = sh(dir, ["git", "rev-parse", "HEAD"]).stdout.trim();
    expect(stop(dir, BACKGROUND).told).toBe(WAITING);
    const merge = (env: Record<string, string>) =>
      runHook(
        GATE,
        dir,
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: `gh pr merge 7 --squash --match-head-commit ${head}`,
          },
        },
        env,
      ).out;
    const refused = merge(passingGh(dir, head));
    expect(refused.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(refused.systemMessage).toBe(
      `Done gate ✗ merge refused: its head commit ${head.slice(0, 7)} has not passed \`bun run gate\` on this machine. Check out ${head.slice(0, 7)} with nothing else changed (a clean worktree: \`git worktree add --detach .claude/worktrees/check ${head.slice(0, 7)}\`), run \`bun run gate\` there (and the verifier, for product code), then merge.`,
    );
    // A machine without Docker never runs them: its pass counts once GitHub reports `checks` passed, and says so.
    expect(
      stop(dir, {}, { PATH: `${noDockerBin()}:${process.env.PATH}` }).told,
    ).toBe(HERE);
    const tip = sh(dir, [
      "git",
      "rev-parse",
      "--short=7",
      "main",
    ]).stdout.trim();
    expect(merge(passingGh(dir, head)).systemMessage).toBe(
      `Done gate ✓ merge of ${head.slice(0, 7)}: typecheck, lint, guards · tests, database policies and browser checks did not run here · GitHub reports \`checks\` passed on it · it holds main's tip ${tip} (no product code changed)`,
    );
  });
});

describe("a stop on a machine without Docker says what did not run, never with a ✓", () => {
  const noDocker = () => ({ PATH: `${noDockerBin()}:${process.env.PATH}` });

  it("shows exactly that line when no product code changed, while background work runs too", () => {
    for (const input of [{}, BACKGROUND]) {
      const dir = repo();
      write(dir, "docs/notes.md", "hello\n");
      expect(stop(dir, input, noDocker())).toEqual({ ...QUIET, told: HERE });
      expect(databaseChecksRan(dir)).toBe(0);
    }
  });

  it("shows a pass that ran no database checks without a ✓, as today's gate showed it", () => {
    const dir = repo();
    sh(dir, ["git", "checkout", "-qb", "feat/notes"]);
    write(dir, "docs/notes.md", "hello\n");
    commit(dir);
    const tree = sh(dir, ["git", "rev-parse", "HEAD^{tree}"]).stdout.trim();
    // What a stop that ran typecheck, lint and guards only leaves for this code, in the words today's gate writes when
    // no local database answers. The shared one always answers here, so the test writes it for that run.
    write(
      dir,
      `.git/done-gate/partial/${tree}`,
      "typecheck, lint, guards, NOT run here (no Docker): tests, database policies, browser checks; CI runs them",
    );
    // Docker not installed: none on the PATH the hook starts with, and the one beside bun can't run.
    const r = spawnSync(join(noDockerBin(), "bun"), [GATE, "hook"], {
      cwd: dir,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: dir,
      }),
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout).systemMessage).toBe(HERE);
    expect(databaseChecksRan(dir)).toBe(0);
  });

  it("leads with that line before the verifier's ruling", () => {
    const env = noDocker();
    const dir = repo();
    start(dir);
    write(dir, "services/worker/src/route.ts", "const route = 1;\n");
    expect(stop(dir, {}, env).sentBack).toBe(true); // product code still needs the verifier
    verified(dir, "saw the route answer 200");
    expect(stop(dir, {}, env)).toEqual({
      ...QUIET,
      told: `${HERE} · verifier PASS: saw the route answer 200`,
    });

    const wait = repo();
    start(wait);
    write(wait, "services/worker/src/sms.ts", "const sms = 1;\n");
    verified(wait, "a real phone number to text", "CANNOT_VERIFY");
    const told = stop(wait, {}, env).told;
    expect(told).toBe(
      `${HERE} · NOT verified: the verifier needs something only you can provide: a real phone number to text`,
    );
    expect(told).not.toContain("✓");
  });

  it("finds Docker on the PATH the gate sets, so a hook started with a bare PATH still runs the database checks", () => {
    const dir = repo();
    write(dir, "docs/notes.md", "hello\n");
    // Claude Code may start a hook with a bare PATH; Docker then lives only in a folder scripts/done-gate.ts adds.
    const r = spawnSync(process.execPath, [GATE, "hook"], {
      cwd: dir,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        cwd: dir,
      }),
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout).systemMessage).toStartWith("Done gate ✓ ");
    expect(databaseChecksRan(dir)).toBe(5); // tests proven, break check, database policies, tests, browser checks
  });

  it("asks the docker first on the PATH as the gate set it while running, on Linux too, where docker sits in /usr/bin", () => {
    const path = process.env.PATH;
    process.env.PATH = `${noDockerBin()}:${path}`; // a folder put first after bun started, as scripts/done-gate.ts does
    try {
      expect(dockerMissing()).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("a stop refuses the checks on the database while a worker runs on this machine", () => {
  /** A stand-in ps, first on the PATH the hook starts with, that prints `body` (a shell script's lines). */
  const ps = (body: string) => {
    const bin = scratch("ps-");
    write(bin, "ps", `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "ps"), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  };
  // Workers, from any checkout: the "api" preview (.claude/launch.json), `bun run dev`, the browser checks and the
  // verifier (`bun services/worker/src/index.ts`), one in another worktree.
  const WORKERS = [
    "  101 /Users/dev/.bun/bin/bun run local bun --watch services/worker/src/index.ts",
    "  102 bun --watch services/worker/src/index.ts",
    "  103 /Users/dev/.bun/bin/bun services/worker/src/index.ts",
    "  104 bun /Users/dev/revenue-os/.claude/worktrees/x/services/worker/src/index.ts",
  ];
  // Processes that only name the file, or run something else.
  const OTHERS = [
    "  201 vim services/worker/src/index.ts",
    "  202 grep services/worker/src/index.ts",
    "  203 /bin/zsh -c bun services/worker/src/index.ts", // its bun is listed on its own line
    "  204 bun test services/worker/test/env-port.test.ts",
    "  205 bun services/worker/src/index.tsx",
    "  206 /usr/bin/bunzip2 services/worker/src/index.ts",
  ];

  it("names each worker and how to stop it, and runs none of them until it is gone", () => {
    const dir = repo();
    write(dir, "docs/notes.md", "hello\n");
    const listed = OTHERS.flatMap((o, i) => [o, WORKERS[i]].filter(Boolean));
    const r = stop(dir, {}, ps(`cat <<'EOF'\n${listed.join("\n")}\nEOF`));
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "tests proven, break check, database policies, tests, browser checks did not run: a worker is running on this machine",
    );
    for (const w of WORKERS) expect(r.reason).toContain(`\n- ${w.trim()}\n`);
    for (const o of OTHERS) expect(r.reason).not.toContain(o.trim());
    expect(r.reason).toContain("`kill 101 102 103 104`");
    expect(databaseChecksRan(dir)).toBe(0);
    expect(stop(dir)).toEqual({
      ...QUIET,
      told: `${ALL_CHECKS} (no product code changed, so no verifier needed)`,
    });
    expect(databaseChecksRan(dir)).toBe(5); // tests proven, break check, database policies, tests, browser checks
  });

  it("runs none of them when it can't list this machine's processes, and says why", () => {
    const dir = repo();
    write(dir, "docs/notes.md", "hello\n");
    const r = stop(dir, {}, ps("echo 'ps: no such option' >&2\nexit 1"));
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "did not run: could not look for a running worker: ps failed: ps: no such option",
    );
    expect(databaseChecksRan(dir)).toBe(0);
  });

  // A real listing holds at least ps itself, but Bun 1.3.11's synchronous spawn can hand back no output from a ps
  // that succeeded (oven-sh/bun#34069).
  it("asks again when ps answers with nothing, and never reads that as no worker", () => {
    const dir = repo();
    write(dir, "docs/notes.md", "hello\n");
    const r = stop(dir, {}, ps("exit 0"));
    expect(r.sentBack).toBe(true);
    expect(r.reason).toContain(
      "did not run: could not look for a running worker: ps listed no processes, asked three times",
    );
    expect(databaseChecksRan(dir)).toBe(0);
    // Empty twice, then a real listing: the third answer counts.
    const once = ps(
      `n=$(cat "$0.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$0.n"\nif [ "$n" -ge 2 ]; then echo '${WORKERS[1]}'; fi`,
    );
    expect(stop(dir, {}, once).reason).toContain(`\n- ${WORKERS[1]?.trim()}\n`);
  });

  it("reads a listing longer than 1 MiB, as a busy machine's is, to its end", () => {
    const dir = repo();
    write(dir, "docs/notes.md", "hello\n");
    const helper = `  300 /Applications/Helper.app/Contents/MacOS/helper --type=renderer ${"x".repeat(200)}`;
    const r = stop(
      dir,
      {},
      ps(`yes '${helper}' | head -n 10000\necho '${WORKERS[0]}'`),
    );
    expect(r.reason).toContain(`\n- ${WORKERS[0]?.trim()}\n`);
    expect(databaseChecksRan(dir)).toBe(0);
  });
});
