// The check before each command guards the done gate's own record and every merge. Each test drives the real hook
// in a throwaway repository holding a copy of the gate, as a session's tool call would, or the command check the hook
// runs (toolRefusal); GitHub is a stand-in (scripts/proof/gate.ts): a `gh` on the PATH and a local copy of the
// repository for `git ls-remote`, never the real one.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toolRefusal } from "./done-gate/tools";
import { checksRun, type Run, standInGitHub } from "./proof/gate";

// A hook test starts bun and git several times; with other agents busy on the machine that passes bun's 5 s.
setDefaultTimeout(60_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};

const sh = (
  dir: string,
  cmd: string[],
  env: Record<string, string> = {},
  input?: string,
) =>
  spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd: dir,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
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
  return sh(dir, ["git", "rev-parse", "HEAD"]).stdout.trim();
};
// The repository's address on GitHub: an address that never resolves, so nothing here reaches the network.
const ORIGIN = "https://example.invalid/o/r.git";

/** A throwaway repository on `main` holding a copy of the gate, its origin at ORIGIN, origin/main at its first commit. */
function repo() {
  const dir = scratch("guards-");
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(import.meta.dir, "done-gate.ts"),
    join(dir, "scripts", "done-gate.ts"),
  );
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
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  commit(dir);
  sh(dir, ["git", "remote", "add", "origin", ORIGIN]);
  sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

type Out = { refused: boolean; why: string; told: string };
/** Runs the repository's own copy of the gate's hook before a tool call, from `cwd`, with `bun`. */
function hook(
  dir: string,
  tool: Record<string, unknown>,
  { cwd = dir, env = {}, codex = false, bun = "bun" } = {},
): Out {
  const r = sh(
    cwd,
    [
      bun,
      join(dir, "scripts", "done-gate.ts"),
      "hook",
      ...(codex ? ["codex"] : []),
    ],
    env,
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd,
      ...tool,
    }),
  );
  const out = r.stdout ? JSON.parse(r.stdout) : {};
  return {
    refused: out.hookSpecificOutput?.permissionDecision === "deny",
    why: out.hookSpecificOutput?.permissionDecisionReason ?? "",
    told: out.systemMessage ?? "",
  };
}
const bash = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
});

describe("the gate's own record (.git/done-gate) and hook", () => {
  const RECORD = "it touches the done gate's own record";
  const HOOK = "it runs the done gate's hook by hand";
  const CODE = "it hands code that names the done gate";

  it("refuses, and tells Devesh about, a command that touches the record, in the ways a careless command spells it", () => {
    const dir = repo();
    const wt = join(scratch("guards-wt-"), "w");
    sh(dir, ["git", "worktree", "add", "-qb", "feat/w", wt]);
    symlinkSync(join(dir, ".git"), join(dir, "g"));
    const refused: [string, string, string?][] = [
      ["rm -rf .git/done-gate", RECORD],
      ["ls .git/done-gate/checked", RECORD],
      ["cat .git/done-gate/verdict/abc", RECORD],
      [
        `echo '{"verdict":"pass","note":"saw it"}' > .git/done-gate/verdict/abc`,
        RECORD,
      ],
      ["tee .git/done-gate/checked/abc < /tmp/x", RECORD],
      ['cp /tmp/x "$PWD/.git/done-gate/checked/abc"', RECORD],
      ["mv /tmp/x .git//done-gate/checked/abc", RECORD],
      ["sed -i '' 's/fail/pass/' .git/./done-gate/verdict/abc", RECORD],
      [`rm -rf ${dir}/.git/done-gate`, RECORD],
      ['rm -rf "$(git rev-parse --git-common-dir)/done-gate"', RECORD],
      [
        "rm -rf $(git rev-parse --path-format=absolute --git-common-dir)/done*",
        RECORD,
      ],
      ['cd "$(git rev-parse --git-common-dir)" && rm -rf d*', RECORD],
      ["cd .git && rm -rf done-gate", RECORD],
      ["find .git -name 'done*' -delete", RECORD],
      ["rm -rf .git/*", RECORD],
      ["rm -rf .git", RECORD],
      ["mv .git /tmp/old-git", RECORD],
      ['rsync -a /tmp/forged/ "$(git rev-parse --git-common-dir)/"', RECORD],
      ["ls .git/{done-gate,hooks}", RECORD],
      ["git rev-parse --git-path done-gate | xargs rm -rf", RECORD],
      ['ln -s "$(git rev-parse --git-common-dir)" g', RECORD],
      ["find . -name done-gate -exec rm -rf {} +", RECORD],
      [`sh -c 'rm -rf .g""it/done-gate'`, RECORD],
      ["python3 -c \"import shutil; shutil.rmtree('.git/done-gate')\"", RECORD],
      [
        "bun -e \"const { Store } = await import('./scripts/done-gate/store.ts')\"",
        CODE,
      ],
      // From a worktree, whose .git is a file naming a folder inside the main checkout's .git.
      [`rm -rf ${dir}/.git/done-gate/checked`, RECORD, wt],
      ["rm -rf \"$(sed 's/gitdir: //' .git)/../../done-gate\"", RECORD, wt],
      ["rm -rf ../../done-gate", RECORD, join(dir, ".git", "worktrees", "w")],
      // In the git folder itself, a relative name or a pattern reaches the record.
      ["rm -rf done-gate", RECORD, join(dir, ".git")],
      ["rm -rf *", RECORD, join(dir, ".git")],
      // A brace for the git folder's name, a variable the line sets to the git folder, git's --git-path, and a
      // pattern after a `cd` into the git folder.
      ["echo x > .{git,}/done-gate/verdict/abc", RECORD],
      ['D=$(git rev-parse --git-common-dir); rm -rf "$D/done-gate"', RECORD],
      ['D=$(git rev-parse --git-common-dir); cd "$D" && rm -rf d*', RECORD],
      ["git rev-parse --git-path=done-gate | xargs rm -rf", RECORD],
      ["cd .git/hooks && rm -rf ../d*", RECORD],
      ["echo pass > .git/d*/verdict/abc", RECORD],
      // Text the line hands on to be run, and a link to the git folder.
      ["echo .git/done-gate | xargs rm -rf", RECORD],
      ["bash <<'EOF'\nrm -rf .git/done-gate\nEOF", RECORD],
      ["rm -rf g/done-gate/checked", RECORD],
      ["cd g && rm -rf done-gate", RECORD],
      ['git commit -qm "$(cat .git/done-gate/verdict/abc)"', RECORD],
      // A pattern that stands for the git folder itself, in a folder that holds one.
      ["rm -rf .* *", RECORD],
      ["rm -rf ./.g?t", RECORD],
      ["mv .{git,x} /tmp/old", RECORD],
    ];
    const wrong = refused.flatMap(([command, why, cwd]) => {
      const r = hook(dir, bash(command), { cwd: cwd ?? dir });
      return r.refused &&
        r.why.includes(why) &&
        r.told.startsWith(`Done gate ✗ command refused: ${why}`)
        ? []
        : [
            `${command}\n    got: ${r.refused ? r.why : "(allowed)"} / told: ${r.told || "(nothing)"}`,
          ];
    });
    expect(wrong).toEqual([]);
  });

  it("refuses, and tells Devesh about, running the gate's hook by hand", () => {
    const dir = repo();
    const wrong = [
      "bun scripts/done-gate.ts hook",
      `echo '{"hook_event_name":"SubagentStop","agent_type":"verifier"}' | bun scripts/done-gate.ts hook`,
      "bun ./scripts/done-gate.ts hook codex < input.json",
      'bun "$CLAUDE_PROJECT_DIR/scripts/done-gate.ts" hook',
      'f=scripts/done-gate.ts; bun "$f" hook',
      "timeout 5 bun scripts/done-gate.ts hook",
      "bun run gate hook",
      "bun run gates -- hook",
      "bun gate hook",
      "sh -c 'bun scripts/done-gate.ts hook'",
      'bash -c "bun run gate hook"',
    ].flatMap((command) => {
      const r = hook(dir, bash(command));
      return r.refused &&
        r.told.startsWith(`Done gate ✗ command refused: ${HOOK}`)
        ? []
        : [
            `${command}\n    got: ${r.why || "(allowed)"} / told: ${r.told || "(nothing)"}`,
          ];
    });
    expect(wrong).toEqual([]);
  });

  it("refuses, and tells Devesh about, an edit or a Codex patch that writes into the record, through a link too", () => {
    const dir = repo();
    symlinkSync(join(dir, ".git"), join(dir, "g"));
    const edits = [
      {
        tool_name: "Write",
        tool_input: { file_path: ".git/done-gate/verdict/abc", content: "{}" },
      },
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(dir, ".git", "done-gate", "checked", "abc"),
          content: "x",
        },
      },
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(dir, ".git", "done-gate", "verdict", "abc"),
          old_string: "fail",
          new_string: "pass",
        },
      },
      {
        tool_name: "MultiEdit",
        tool_input: {
          file_path: ".git/worktrees/../done-gate/verdict/abc",
          edits: [],
        },
      },
      {
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: ".git/done-gate/x.ipynb", new_source: "" },
      },
      {
        tool_name: "Write",
        tool_input: { file_path: "g/done-gate/checked/abc", content: "x" },
      },
    ];
    for (const edit of edits)
      expect(hook(dir, edit)).toEqual({
        refused: true,
        why: expect.stringContaining(RECORD),
        told: expect.stringMatching(
          /^Done gate ✗ edit refused: it touches the done gate's own record/,
        ),
      });
    const patch = {
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Add File: .git/done-gate/verdict/abc\n+{}\n*** End Patch\n",
      },
    };
    expect(hook(dir, patch, { codex: true }).why).toContain(RECORD);
  });

  it("lets through commands and edits that only name the gate's code or read the git folder", () => {
    const dir = repo();
    const commands = [
      "git rev-parse --git-common-dir",
      "cat .git",
      "ls -la .git",
      "cat .git/HEAD",
      'git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." worktree list',
      "git log --oneline -3",
      "ls scripts/done-gate",
      "find scripts -name '*done-gate*'",
      "cat .gitignore && du -sh .git",
      "rm -f .git/index.lock",
      'echo "scratch/" >> .git/info/exclude',
      'rg -n "stateDir" scripts/done-gate',
      "bunx biome check --write scripts/done-gate/store.ts",
      "cat scripts/done-gate/hook.ts",
      "grep -n hook scripts/done-gate.ts",
      "bun scripts/done-gate.ts rules --base origin/main",
      "bun test scripts/done-gate.test.ts -t hook",
      'git commit -qm "the gate keeps its record per code state"',
    ];
    const refused = commands.flatMap((command) => {
      const r = hook(dir, bash(command));
      return r.refused ? [`${command}\n    refused: ${r.why}`] : [];
    });
    expect(refused).toEqual([]);
    expect(
      hook(dir, bash("cat HEAD"), { cwd: join(dir, ".git") }).refused,
    ).toBe(false);
    for (const file_path of ["docs/notes.md", "scripts/done-gate/store.ts"])
      expect(
        hook(dir, {
          tool_name: "Write",
          tool_input: { file_path, content: "x" },
        }).refused,
      ).toBe(false);
  });

  // The outside review of 2026-10-03 found each of these refused, and Devesh told of a try at the record: a git
  // folder named anywhere in the line beside a pattern anywhere else in it, the record's name in a message or a
  // search, or its name beside rm, cp or mv in another command of the line.
  it("lets through everyday searches, listings and commits that name the git folder or the record only as text", () => {
    const dir = repo();
    const refused = [
      `grep -rn "withOrg" . --exclude-dir=.git --include='*.ts'`,
      "find . -path ./.git -prune -o -name '*.md' -print",
      "ls -la .git && ls scripts/*.ts",
      "cat .git/HEAD; ls apps/*/package.json",
      'git commit -qm "The gate refuses commands that touch .git/done-gate"',
      'grep -rn ".git/done-gate" docs STATE.md',
      "rm -rf /tmp/done-gate",
      'git commit -qm "done-gate: refuse --admin" && cp a.txt b.txt',
      // Text that names the record: a question for Devesh, a pull request's words, a file written from a heredoc,
      // and the hook's command printed, not run.
      'bun run gate pause "may I clear .git/done-gate?"',
      'gh pr comment 7 --body "the gate keeps its record in .git/done-gate"',
      "cat > /tmp/body.md <<'EOF'\nThe gate keeps its record in .git/done-gate.\nEOF",
      "echo scripts/done-gate.ts hook",
      'git log --grep=".git/done-gate" --oneline',
      // Patterns that can't stand for the git folder: in a folder that holds none, or not starting with a dot.
      `rm -rf ${scratch("guards-plain-")}/.g*`,
      "rm -rf dist/* && cp -r .claude/skills/* /tmp/skills/",
      "find . -name '*.ts' -not -path './.git/*'",
      "grep -rn TODO --exclude-dir=.git --include='*.ts' .",
      "[ -d .git ] && echo yes",
      `cat .git/HEAD; echo "\${HOME}"`,
      "ls .git/hooks/*.sample",
      `D=$(git rev-parse --git-common-dir); echo "\${D}/config"`,
      "git rev-parse --git-common-dir && ls scripts/*.ts",
      "rsync -a --exclude .git ./ /tmp/copy/",
      "git log --oneline && echo '.git/*'",
      "tar --exclude='.git' -czf /tmp/x.tgz .",
      "grep -rn done-gate --exclude-dir=.git .",
      "rm -f /tmp/x.log && rg -n done-gate docs",
      "find .git -name '*.lock'",
    ].flatMap((command) => {
      const r = hook(dir, bash(command));
      return r.refused ? [`${command}\n    refused: ${r.why}`] : [];
    });
    expect(refused).toEqual([]);
  });
});

// Each command a line may not run when it names gh (or graphql) and merge, and a phrase its reason must hold.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ADMIN = "`--admin`";
const PLAIN = "a plain `gh pr merge <number>`";
const LITERAL = "written out in full";
const REPO_ENV = "GH_REPO";
const NESTED = "handed to a shell or eval";
const SETTING = "a setting that names";
const IN_WORD = "a command inside a word";
const API = "`gh api` may only read";
const LOOP = "not one of the loop's own GitHub steps";
const REFUSED: [string, string][] = [
  // --admin skips main's required checks, however it is written.
  [`gh pr merge 7 --squash --admin --match-head-commit ${SHA}`, ADMIN],
  ["gh pr merge 7 --admin", ADMIN],
  ["gh pr merge --admin=true 7", ADMIN],
  ["gh -R o/r pr merge 7 --admin", ADMIN],
  // An option a plain merge doesn't take, and a pull request, repository or commit known only when it runs.
  ["gh pr merge 7 --squash -x", PLAIN],
  ['gh pr merge 7 -R "$REPO" --squash', LITERAL],
  ['gh pr merge "https://github.com/$R/pull/7"', LITERAL],
  ['gh pr merge 7 --match-head-commit "$(git rev-parse HEAD)"', LITERAL],
  ['for n in 7 8; do gh pr merge "$n" --squash; done', LITERAL],
  ["GH_REPO=o/r gh pr merge 7", REPO_ENV],
  ["env GH_REPO=o/r gh pr merge 7", REPO_ENV],
  // A merge handed to a shell or eval, which the merge check never sees, quotes and all.
  [`sh -c 'g""h pr merge 7'`, NESTED],
  [`eval 'g""h pr merge 7'`, NESTED],
  // In a line that names gh and merge, a program that could run a merge out of sight.
  ["alias m='g''h pr merge'", PLAIN],
  ["./scripts/gh-merge.sh 7", PLAIN],
  ["bash merge.sh 7 && gh pr view 7", PLAIN],
  ["source merge.sh; gh pr view 7", PLAIN],
  ["make merge && gh pr checks 7", PLAIN],
  ["git -c core.editor='gh pr merge 7 --squash' commit", PLAIN],
  ["git rebase -x 'gh pr merge 7' main", PLAIN],
  ["rg --pre 'gh pr merge 7' x", PLAIN],
  ["GIT_EDITOR='gh pr merge 7' git commit", SETTING],
  // git's own commands that run a program they are handed (outside review, 2026-10-03): fetch and pull's
  // upload-pack, abbreviated too, a remote-helper address (`ext::`), or a setting known only when it runs. (A push
  // naming a program is refused already: agents' pushes take no such option.)
  ["git fetch --upload-pack='gh pr merge 7 --squash --admin' .", PLAIN],
  ["git pull --upload-pack='gh pr merge 7 --admin' . main", PLAIN],
  ["git fetch --upl='gh pr merge 7' .", PLAIN],
  [
    "GIT_ALLOW_PROTOCOL=ext git fetch 'ext::sh -c gh% pr% merge% 7% --admin'",
    PLAIN,
  ],
  [`X='gh pr merge 7 --admin'; GIT_SSH_COMMAND="$X" git fetch origin`, SETTING],
  // A merge written inside a word (outside review, 2026-10-03), which bash runs when it reads the word as an array
  // subscript, quotes or a backslash notwithstanding.
  ["[[ 'x[$(gh pr merge 7 --squash --admin)]' -eq 0 ]]", IN_WORD],
  ["printf -v 'y[$(gh pr merge 7 --admin)]' z", IN_WORD],
  ['[[ "x[\\`gh pr merge 7\\`]" -eq 0 ]]', IN_WORD],
  // bun running anything but the gate's own command.
  ["bun scripts/merge.ts 7 && gh pr view 7", PLAIN],
  // gh api: a GraphQL query known only when it runs, the merge address and the merge mutation.
  ['gh api graphql -f query="$(cat merge.graphql)"', API],
  ['gh api graphql -f query="$Q"', API],
  ["gh api -X PUT repos/o/r/pulls/7/merge", API],
  [
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    API,
  ],
  // gh alias, which would name a merge something else (refused since the tools item: not a loop step).
  ["gh alias set m 'pr merge'", LOOP],
  ["gh alias import aliases.yml", LOOP],
];

// Lines that name gh and merge but read plainly: reads, git's own merge, text, and a plain merge.
const ALLOWED = [
  "gh pr view 7 --json mergeable,mergeStateStatus",
  "gh pr list --state merged --json number,mergedAt",
  "gh pr view 7 --json mergeCommit -q .mergeCommit.oid",
  "gh pr view 7 --json body -q .body | grep -c merge",
  "git merge --ff-only origin/main && gh pr view 7",
  "git merge-base HEAD origin/main",
  "git fetch origin && git merge-base --is-ancestor HEAD origin/main && gh pr list --state merged",
  "git pull --ff-only origin main && gh pr view 7 --json mergeable",
  "git fetch --update-head-ok origin && gh pr view 7 --json mergeable",
  '[[ "$(gh pr view 7 --json mergeable -q .mergeable)" == MERGEABLE ]] && echo ok',
  "GH_PAGER=cat gh pr view 7 --json mergeable",
  `gh pr merge 7 --squash --delete-branch --match-head-commit ${SHA}`,
  `gh pr merge 7 --auto --squash --match-head-commit=${SHA}`,
  `gh pr merge 7 -sd --match-head-commit ${SHA}`,
  `gh -R devesh911/revenue-os pr merge 7 --squash --match-head-commit ${SHA}`,
  `gh pr checks 7 --watch && gh pr merge 7 --squash --match-head-commit ${SHA}`,
  `cd ../w && gh pr merge 7 --squash --match-head-commit ${SHA}`,
  "gh pr merge 7 --disable-auto",
  'grep -rn "gh pr merge" AGENTS.md .claude/skills',
  'git commit -qm "every gh pr merge names its commit"',
  'gh pr create --title "Merges name their commit" --body-file /tmp/body.md',
  "gh api repos/o/r/pulls/7 --jq .mergeable",
  'gh api graphql -f query=\'{ repository(owner: "o", name: "r") { pullRequest(number: 7) { mergeable } } }\'',
  "cat > /tmp/body.md <<'EOF'\nMerge with gh pr merge 7 once green\nEOF",
  'echo "merge when green" && gh pr checks 7',
];

// What the check may look up about the folders a command reaches: every one is on a feat/ branch, with no .env file.
const look = { branchOf: () => "feat/x", envFileIn: () => undefined };

describe("a line that names gh and merge must read as a plain `gh pr merge <number>`", () => {
  it("refuses every line the table lists, each for the right reason", () => {
    const wrong = REFUSED.flatMap(([command, why]) => {
      const got = toolRefusal(command, look);
      return got?.includes(why)
        ? []
        : [`${command}\n    expected: ${why}\n    got: ${got ?? "(allowed)"}`];
    });
    expect(wrong).toEqual([]);
  });

  it("lets reads, git's own merge, text and a plain merge through", () => {
    const refused = ALLOWED.flatMap((command) => {
      const got = toolRefusal(command, look);
      return got ? [`${command}\n    refused: ${got}`] : [];
    });
    expect(refused).toEqual([]);
  });

  // The outside review of 2026-10-03 found the gate's own command refused when its words named gh and merge, as a
  // question about any item on merging does.
  it("lets the gate's own command through the hook, whatever its question names", () => {
    const dir = repo();
    const refused = [
      'bun run gate pause "may I run gh pr merge 7 without --match-head-commit?"',
      `bun scripts/done-gate.ts pause "a merge with --admin needs Devesh's own gh login"`,
      'bun run gate pause "may I clear .git/done-gate after a hook run by hand?"',
      "gh pr view 7 --json mergeable,headRefOid && bun run gate pr",
    ].flatMap((command) => {
      const r = hook(dir, bash(command));
      return r.refused ? [`${command}\n    refused: ${r.why}`] : [];
    });
    expect(refused).toEqual([]);
  });
});

describe("the merge check: every agent merge names the exact commit that passed the gate", () => {
  /**
   * A stand-in GitHub for `dir`: `gh pr view` names `head`, `gh api` answers `runs` (by default `checks` passed on
   * `head`; null: it fails), `git ls-remote` reads `dir`'s main, and every gh call is logged.
   */
  const fakeGh = (dir: string, head: string, runs?: Run[] | null) =>
    standInGitHub(dir, scratch("guards-gh-"), head, { runs });
  /** A pull request's head: a commit changing only `file`, by default notes (no product code, so no verifier is needed). */
  const pullRequest = (dir: string, file = "docs/notes.md") => {
    sh(dir, ["git", "checkout", "-qb", "feat/notes"]);
    write(dir, file, `notes ${Math.random()}\n`);
    const head = commit(dir);
    sh(dir, ["git", "checkout", "-q", "main"]);
    return {
      head,
      tree: sh(dir, ["git", "rev-parse", `${head}^{tree}`]).stdout.trim(),
    };
  };
  const record = (
    dir: string,
    kind: "checked" | "partial",
    tree: string,
    text: string,
  ) => write(dir, `.git/done-gate/${kind}/${tree}`, text);
  const merge = (
    dir: string,
    command: string,
    gh: ReturnType<typeof fakeGh>,
    cwd = dir,
  ) => hook(dir, bash(command), { cwd, env: gh.env });
  /** GitHub's answers that don't show `checks` passed (null: it can't be asked), each with what a refusal names. */
  const NOT_PASSED = (run: (over?: Run) => Run) =>
    [
      [[run({ conclusion: "failure" })], "failure"],
      [[run({ status: "in_progress", conclusion: null })], "in_progress"],
      [[run({ app: { id: 99 } })], "no `checks` run by GitHub Actions"],
      [[run({ head_sha: SHA })], "no `checks` run by GitHub Actions"],
      [[], "no `checks` run by GitHub Actions"],
      [null, "HTTP 502"],
    ] as [Run[] | null, string][];

  it("refuses a merge that doesn't name the exact commit the gate proved, and lets the one that does through", () => {
    const dir = repo();
    const { head, tree } = pullRequest(dir);
    const gh = fakeGh(dir, head);
    const tip = sh(dir, [
      "git",
      "rev-parse",
      "--short=7",
      "main",
    ]).stdout.trim();
    record(dir, "checked", tree, "typecheck, lint, guards, 3 tests");
    const bare = merge(dir, "gh pr merge 7 --squash", gh);
    expect(bare.refused).toBe(true);
    expect(bare.why).toContain(`--match-head-commit ${head}`);
    expect(bare.told).toStartWith("Done gate ✗ merge refused: ");
    expect(
      merge(
        dir,
        `gh pr merge 7 --squash --match-head-commit ${head.slice(0, 7)}`,
        gh,
      ).why,
    ).toContain(`--match-head-commit ${head}`);
    expect(
      merge(dir, `gh pr merge 7 --squash --match-head-commit ${SHA}`, gh)
        .refused,
    ).toBe(true);
    expect(
      merge(dir, `gh pr merge 7 --squash --match-head-commit ${head}`, gh),
    ).toEqual({
      refused: false,
      why: "",
      told: `Done gate ✓ merge of ${head.slice(0, 7)}: typecheck, lint, guards, 3 tests · GitHub reports \`checks\` passed on it · it holds main's tip ${tip} (no product code changed)`,
    });
    // A full result too waits for GitHub's word, as the Mac's gate leaves the four-runs-at-once test to CI; and
    // GitHub is asked whether main has a merge queue.
    expect(gh.calls().filter((c) => c.startsWith("api"))).toEqual([
      "api repos/o/r/rules/branches/main?per_page=100",
      `api repos/o/r/commits/${head}/check-runs?check_name=checks&filter=latest`,
    ]);
  });

  it("reads a merge as gh reads it: quotes in its name, its options before `pr`, or from a folder outside the checkout", () => {
    const dir = repo();
    const { head } = pullRequest(dir); // never proven here
    const gh = fakeGh(dir, head);
    for (const command of [
      `g''h pr merge 7 --squash --match-head-commit ${head}`,
      `g\\h pr merge 7 --squash --match-head-commit ${head}`,
      `gh -R o/r pr merge 7 --squash --match-head-commit ${head}`,
      `gh --repo=o/r pr merge 7 --squash --match-head-commit ${head}`,
    ])
      expect(merge(dir, command, gh).why).toContain(
        `${head.slice(0, 7)} has not passed`,
      );
    // A folder that is not a checkout of this repository, but whose remote is its address: gh merges its PR.
    const elsewhere = scratch("guards-elsewhere-");
    sh(elsewhere, ["git", "init", "-q"]);
    sh(elsewhere, ["git", "remote", "add", "upstream", ORIGIN]);
    expect(
      merge(
        dir,
        `gh pr merge 7 --squash --match-head-commit ${head}`,
        gh,
        elsewhere,
      ).why,
    ).toContain(`${head.slice(0, 7)} has not passed`);
    // Another repository's pull request is that repository's business.
    sh(elsewhere, [
      "git",
      "remote",
      "set-url",
      "upstream",
      "https://example.invalid/someone/else.git",
    ]);
    expect(
      merge(
        dir,
        `gh pr merge 7 --squash --match-head-commit ${head}`,
        gh,
        elsewhere,
      ).refused,
    ).toBe(false);
  });

  // The outside review of 2026-10-03 found the merge check judged the folder the tool call started in, so from
  // another repository `cd <this checkout> && gh pr merge 7` was taken for that repository's business.
  it("checks a merge in every folder the command visits before it, even from another repository", () => {
    const dir = repo();
    const { head } = pullRequest(dir); // never proven here
    const gh = fakeGh(dir, head);
    const other = scratch("guards-other-");
    sh(other, ["git", "init", "-q"]);
    sh(other, [
      "git",
      "remote",
      "add",
      "origin",
      "https://example.invalid/some/other.git",
    ]);
    const exact = `gh pr merge 7 --squash --match-head-commit ${head}`;
    const unproven = `${head.slice(0, 7)} has not passed`;
    const wrong = [
      [`cd ${dir} && gh pr merge 7 --squash`, `--match-head-commit ${head}`],
      [`cd ${dir} && ${exact}`, unproven],
      [`(cd ${dir}; ${exact})`, unproven],
      [`pushd ${dir} && ${exact}`, unproven],
      [`cd /tmp && cd ${dir} && ${exact}`, unproven],
      // A folder known only when the command runs may be this checkout.
      [`cd "$REPO" && ${exact}`, unproven],
      // A merge inside a substitution is a command the merge check reads like any other.
      [`cd ${dir} && out=$(${exact})`, unproven],
    ].flatMap(([command = "", why = ""]) => {
      const r = merge(dir, command, gh, other);
      return r.refused && r.why.includes(why)
        ? []
        : [
            `${command}\n    expected: ${why}\n    got: ${r.why || "(allowed)"}`,
          ];
    });
    expect(wrong).toEqual([]);
    // From this checkout, a subshell that visits another repository leaves the merge here.
    expect(merge(dir, `(cd ${other}) && ${exact}`, gh).why).toContain(unproven);
    // Another repository's pull request, named by -R, is that repository's business.
    expect(
      merge(dir, `cd ${other} && gh -R some/other pr merge 7 --squash`, gh)
        .refused,
    ).toBe(false);
  });

  it("counts a partial result (no Docker, so no database tests) only when GitHub reports `checks` passed on that exact commit", () => {
    const dir = repo();
    const { head, tree } = pullRequest(dir);
    record(dir, "partial", tree, "typecheck, lint, guards");
    const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
    const run = (over: Run = {}): Run => checksRun(head, over);
    const passed = fakeGh(dir, head, [run()]);
    const r = merge(dir, command, passed);
    expect(r.refused).toBe(false);
    expect(r.told).toContain("GitHub reports `checks` passed on it");
    // Asked with reads: main's rules, then the check runs named `checks` on that commit, no method, no fields.
    expect(passed.calls().filter((c) => c.startsWith("api"))).toEqual([
      "api repos/o/r/rules/branches/main?per_page=100",
      `api repos/o/r/commits/${head}/check-runs?check_name=checks&filter=latest`,
    ]);
    for (const [runs, why] of NOT_PASSED(run)) {
      const refused = merge(dir, command, fakeGh(dir, head, runs));
      expect(refused.refused).toBe(true);
      expect(refused.why).toContain("passed `bun run gate` here only in part");
      expect(refused.why).toContain(why);
    }
  });

  // The Mac's gate leaves the four-runs-at-once test to CI, so a full pass here no longer proves a commit alone.
  it("counts a full pass here too only when GitHub reports `checks` passed on that exact commit", () => {
    const dir = repo();
    const { head, tree } = pullRequest(dir);
    record(dir, "checked", tree, "typecheck, lint, guards, 3 tests");
    const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
    const r = merge(dir, command, fakeGh(dir, head));
    expect(r.refused).toBe(false);
    expect(r.told).toContain(
      "typecheck, lint, guards, 3 tests · GitHub reports `checks` passed on it",
    );
    const wrong = NOT_PASSED((over) => checksRun(head, over)).flatMap(
      ([runs, why]) => {
        const refused = merge(dir, command, fakeGh(dir, head, runs));
        return refused.refused &&
          refused.why.includes(
            "passed `bun run gate` here (which leaves the four-runs-at-once test to CI), but",
          ) &&
          refused.why.includes(why)
          ? []
          : [`${why}: ${refused.why || refused.told}`];
      },
    );
    expect(wrong).toEqual([]);
  });

  it("refuses a merge whose head does not hold main's tip as `git ls-remote` reads it at that moment, or when it can't be read", () => {
    const dir = repo();
    const { head, tree } = pullRequest(dir);
    record(dir, "checked", tree, "typecheck, lint, guards, 3 tests");
    const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
    expect(merge(dir, command, fakeGh(dir, head)).refused).toBe(false);
    // Main moves on after the branch left it: GitHub's `checks` ran on the head with the old main.
    write(dir, "docs/later.md", "landed on main later\n");
    const later = commit(dir);
    const behind = merge(dir, command, fakeGh(dir, head));
    expect(behind.refused).toBe(true);
    expect(behind.why).toContain(
      `does not hold main's tip ${later.slice(0, 7)} as GitHub has it now`,
    );
    // The local main is no guide: only GitHub's answer counts, here a main this checkout never saw.
    sh(dir, ["git", "reset", "-q", "--hard", "HEAD~1"]);
    const other = scratch("guards-main-elsewhere-");
    sh(other, ["git", "init", "-q", "-b", "main"]);
    write(other, "a.md", "another history\n");
    commit(other);
    sh(dir, ["git", "fetch", "-q", other, "main:refs/heads/elsewhere"]);
    expect(
      merge(
        dir,
        command,
        standInGitHub(dir, scratch("guards-gh-"), head, { main: "elsewhere" }),
      ).why,
    ).toContain("does not hold main's tip");
    // An answer that can't be had or read: GitHub out of reach, an empty answer, a garbled one, no main there.
    const gh = fakeGh(dir, head);
    const fakeGit = (answer: string) => {
      const bin = scratch("guards-git-");
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\ncase "$1" in ls-remote) ${answer} ;; esac\nexec ${Bun.which("git")} "$@"\n`,
        { mode: 0o755 },
      );
      return { ...gh, env: { ...gh.env, PATH: `${bin}:${gh.env.PATH}` } };
    };
    const unreached = { ...gh, env: { PATH: gh.env.PATH } }; // origin's own address, which never resolves
    const noMain = fakeGh(dir, head);
    sh(dir, [
      "git",
      "--git-dir",
      noMain.env.GIT_CONFIG_KEY_0.replace(/^url\.|\.insteadOf$/g, ""),
      "update-ref",
      "-d",
      "refs/heads/main",
    ]);
    for (const [stand, why] of [
      [unreached, "could not read main's tip on GitHub"],
      [fakeGit("exit 0"), "an empty answer"],
      [fakeGit("echo 'not a commit'; exit 0"), "an answer it can't read"],
      [noMain, "GitHub names no main"],
    ] as const) {
      const r = merge(dir, command, stand);
      expect([why, r.refused]).toEqual([why, true]);
      expect(r.why).toContain(why);
    }
  });

  it("with a merge queue on main's rules, queues a head that does not hold main's tip, still only once it passed here and `checks` passed on it; refuses when the rules can't be read", () => {
    const dir = repo();
    const { head, tree } = pullRequest(dir);
    const command = `gh pr merge 7 --squash --match-head-commit ${head}`;
    const queued = (o: { runs?: Run[] | null; queue?: boolean | null }) =>
      merge(
        dir,
        command,
        standInGitHub(dir, scratch("guards-gh-"), head, { queue: true, ...o }),
      );
    // Never proven here: the queue changes nothing about that.
    expect(queued({}).why).toContain("has not passed `bun run gate`");
    record(dir, "checked", tree, "typecheck, lint, guards, 3 tests");
    // Main moves on after the branch left it.
    write(dir, "docs/later.md", "landed on main later\n");
    commit(dir);
    expect(merge(dir, command, fakeGh(dir, head)).why).toContain(
      "does not hold main's tip",
    );
    const gh = standInGitHub(dir, scratch("guards-gh-"), head, { queue: true });
    const r = merge(dir, command, gh);
    expect(r.refused).toBe(false);
    expect(r.told).toContain(
      `queueing ${head.slice(0, 7)}: typecheck, lint, guards, 3 tests · GitHub reports \`checks\` passed on it · main has a merge queue`,
    );
    // Asked with reads: main's rules, then the check runs on that commit.
    expect(gh.calls().filter((c) => c.startsWith("api"))).toEqual([
      "api repos/o/r/rules/branches/main?per_page=100",
      `api repos/o/r/commits/${head}/check-runs?check_name=checks&filter=latest`,
    ]);
    for (const [runs, why] of NOT_PASSED((over) => checksRun(head, over))) {
      const refused = queued({ runs });
      expect([why, refused.refused]).toEqual([why, true]);
      expect(refused.why).toContain(why);
    }
    // A product change still needs the verifier's PASS, queue or not.
    const product = repo();
    const p = pullRequest(product, "services/worker/src/a.ts");
    record(product, "checked", p.tree, "typecheck, lint, guards, 3 tests");
    expect(
      merge(
        product,
        `gh pr merge 7 --squash --match-head-commit ${p.head}`,
        standInGitHub(product, scratch("guards-gh-"), p.head, { queue: true }),
      ).why,
    ).toContain("nobody independent has seen");
    // Whether main has a queue can't be read: GitHub out of reach, or an answer that is not a list of rules.
    const unread = queued({ queue: null });
    expect(unread.refused).toBe(true);
    expect(unread.why).toContain(
      "could not read whether main's rules on GitHub hold a merge queue (`gh api`: HTTP 502)",
    );
    for (const answer of [
      "",
      "{}",
      "not json",
      JSON.stringify(Array(100).fill({ type: "x" })),
    ]) {
      const stand = standInGitHub(dir, scratch("guards-gh-"), head, {
        queue: true,
      });
      writeFileSync(
        join(stand.env.PATH.split(":")[0] ?? "", "rules.json"),
        answer,
      );
      const odd = merge(dir, command, stand);
      expect([answer.slice(0, 9), odd.refused]).toEqual([
        answer.slice(0, 9),
        true,
      ]);
      expect(odd.why).toContain("an answer it can't read");
    }
  });

  it("refuses a change to CI's workflows or the gate's checks, test runner, coverage, tests-proven, break or merge check without the verifier's PASS", () => {
    const needs = [
      ".github/workflows/ci.yml",
      ".github/workflows/proof.yml",
      "scripts/done-gate/checks.ts",
      "scripts/done-gate/tests-ran.ts",
      "scripts/done-gate/coverage.ts",
      "scripts/done-gate/tests-proven.ts",
      "scripts/done-gate/break-check.ts",
      "scripts/done-gate/merge-gate.ts",
    ];
    const free = [
      "docs/notes.md",
      "scripts/done-gate/rules.ts",
      ".github/CODEOWNERS",
    ];
    const wrong = [...needs, ...free].flatMap((file) => {
      const dir = repo();
      const { head, tree } = pullRequest(dir, file);
      record(dir, "checked", tree, "typecheck, lint, guards, 3 tests");
      const r = merge(
        dir,
        `gh pr merge 7 --squash --match-head-commit ${head}`,
        fakeGh(dir, head),
      );
      const refused =
        r.refused && r.why.includes("nobody independent has seen");
      return refused === needs.includes(file)
        ? []
        : [`${file}: ${r.why || r.told}`];
    });
    expect(wrong).toEqual([]);
  });

  // The stand-in gh must win over a real one that sits beside bun, as Homebrew installs both in /opt/homebrew/bin.
  // It does while the gate's gh calls hand spawnSync no `env`: bun then looks gh up on the PATH it started with, not
  // the one scripts/done-gate.ts sets (bun's own folder first). The outside review of 2026-10-03 asked.
  it("asks the gh the caller's PATH names first, not one beside bun", () => {
    const dir = repo();
    const { head } = pullRequest(dir); // never proven here
    const gh = fakeGh(dir, head);
    const brew = scratch("guards-brew-");
    const bun = join(brew, "bun");
    try {
      linkSync(process.execPath, bun); // bun names its own folder by the path it was started from
    } catch {
      copyFileSync(process.execPath, bun, constants.COPYFILE_FICLONE);
      chmodSync(bun, 0o755);
    }
    writeFileSync(
      join(brew, "gh"),
      "#!/bin/sh\necho 'the gh beside bun answered' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const r = hook(
      dir,
      bash(`gh pr merge 7 --squash --match-head-commit ${head}`),
      { env: gh.env, bun },
    );
    expect(r.why).toContain(`${head.slice(0, 7)} has not passed`);
    expect(gh.calls().some((c) => c.startsWith("pr view 7"))).toBe(true);
  });

  // The outside review of 2026-10-03: the desktop app's auto-merge tool names no commit, and no hook watched it.
  it("refuses an MCP tool that merges a pull request, and Claude Code asks the gate before one runs", () => {
    const dir = repo();
    for (const tool_name of [
      "mcp__ccd_pr__set_auto_merge",
      "mcp__github__merge_pull_request",
    ]) {
      const r = hook(dir, { tool_name, tool_input: { pr: 7, enabled: true } });
      expect(r.refused).toBe(true);
      expect(r.told).toStartWith(
        "Done gate ✗ merge refused: it merges through an MCP tool",
      );
    }
    // A tool that merges something other than a pull request is not the gate's business.
    expect(
      hook(dir, {
        tool_name: "mcp__voice__agents_merge_branch",
        tool_input: {},
      }).refused,
    ).toBe(false);
    // .claude/settings.json runs the gate's hook before each of them.
    const settings = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", ".claude", "settings.json"),
        "utf8",
      ),
    ) as {
      hooks: {
        PreToolUse: { matcher: string; hooks: { command: string }[] }[];
      };
    };
    const asked = (tool: string) =>
      settings.hooks.PreToolUse.some(
        (g) =>
          new RegExp(`^(?:${g.matcher})$`).test(tool) &&
          g.hooks.some(
            (h) =>
              h.command.includes("scripts/done-gate.ts") &&
              /\bhook$/.test(h.command),
          ),
      );
    expect(
      ["mcp__ccd_pr__set_auto_merge", "mcp__github__merge_pull_request"].map(
        asked,
      ),
    ).toEqual([true, true]);
  });
});

describe("while a file of the gate fails to load", () => {
  /** A copy of the gate one of whose files can't load: an export renamed, as a half-done edit leaves it. */
  const broken = () => {
    const dir = repo();
    const words = join(dir, "scripts", "done-gate", "shell-words.ts");
    writeFileSync(
      words,
      readFileSync(words, "utf8").replace(
        "export function simpleCommands(",
        "export function simpleCommandz(",
      ),
    );
    return dir;
  };

  it("refuses a merge however it is spelt", () => {
    const dir = broken();
    for (const command of ["g''h pr merge 7 --squash", "gh pr m\\erge 7"])
      expect(hook(dir, bash(command)).why).toContain(
        "it could not load the done gate",
      );
    expect(
      hook(dir, { tool_name: "mcp__ccd_pr__set_auto_merge", tool_input: {} })
        .why,
    ).toContain("it could not load the done gate");
  });

  // The outside review of 2026-10-03 found only merges refused in this state: the record and the hook were open.
  it("refuses a command or edit that names the git folder or the record, or runs the hook, and lets the gate be fixed", () => {
    const dir = broken();
    const wrong = [
      bash("rm -rf .git/done-gate"),
      bash("cd .git && rm -rf d*"),
      bash('rm -rf "$(git rev-parse --git-common-dir)/d"*'),
      bash("bun scripts/done-gate.ts hook"),
      bash("bun run gate hook < input.json"),
      {
        tool_name: "Write",
        tool_input: { file_path: ".git/done-gate/verdict/abc", content: "{}" },
      },
    ].flatMap((tool) => {
      const r = hook(dir, tool);
      return r.refused &&
        r.why.includes("it could not load the done gate") &&
        /^Done gate ✗ (command|edit) refused: /.test(r.told)
        ? []
        : [`${JSON.stringify(tool)}\n    got: ${r.why || r.told}`];
    });
    expect(wrong).toEqual([]);
    expect(hook(dir, bash("ls"), { cwd: join(dir, ".git") }).refused).toBe(
      true,
    );
    // What fixing the gate takes still goes through, with the warning that nothing is checked.
    const refused = [
      bash("bunx biome check --write scripts/done-gate/shell-words.ts"),
      bash("bun test scripts/done-gate-guards.test.ts -t hook"),
      bash("git diff scripts/done-gate && git status --short"),
      bash('git commit -qm "the shell reader loads again"'),
      {
        tool_name: "Edit",
        tool_input: {
          file_path: "scripts/done-gate/shell-words.ts",
          old_string: "simpleCommandz",
          new_string: "simpleCommands",
        },
      },
    ].flatMap((tool) => {
      const r = hook(dir, tool);
      return r.refused || !r.told.startsWith("Done gate ⚠ could not load")
        ? [`${JSON.stringify(tool)}\n    got: ${r.why || r.told}`]
        : [];
    });
    expect(refused).toEqual([]);
  });
});
