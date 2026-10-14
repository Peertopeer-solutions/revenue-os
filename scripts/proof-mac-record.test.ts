// The record of Slice 0's two AI steps run on Devesh's Mac (scripts/done-gate/mac-record.ts): which files it
// fingerprints, how it is judged against a commit's files, and the line `bun run cycle --banner` shows when it does not
// hold (its reading of main: scripts/cycle-ai-steps.test.ts). GitHub's proof steps that read it:
// scripts/proof-slice-0-record.test.ts; the Mac command that writes it: scripts/proof-on-mac.test.ts.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGAIN,
  AI_STEPS,
  bannerLine,
  fingerprints,
  judged,
  MAC_COMMAND,
  RECORD,
  RECORD_PR,
} from "./done-gate/mac-record";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FILES = { "AGENTS.md": "a1", "scripts/done-gate.ts": "b2" };
const record = (over: object = {}) =>
  JSON.stringify({
    commit: "c".repeat(40),
    date: "2026-10-14",
    claude: "2.1.299",
    steps: AI_STEPS.map((name) => ({ name, outcome: "passed", seen: "ok" })),
    files: FILES,
    ...over,
  });

/** A scratch repository holding `files`, committed; git in it. */
const repo = (files: { [path: string]: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "mac-record-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
  const put = (more: { [path: string]: string }) => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", "-A");
    git("commit", "-qm", "x");
  };
  git("init", "-q", "-b", "main");
  put(files);
  return { dir, git, put };
};

describe("the files the AI steps' record fingerprints", () => {
  // behaviour already on main: it tests scripts/done-gate/mac-record.ts, the gate's own code, which main's copy carries over (it is not product code), so it passes there
  it("are, in this repository, the law files, the hooks' settings, the scripts they run with all they import, and the steps' code, but no test", () => {
    const files = Object.keys(fingerprints(ROOT, "HEAD"));
    expect(files).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".claude/agents/verifier.md",
        "scripts/cycle-hook.sh",
        "scripts/cycle.ts",
        "scripts/done-gate.ts",
        "scripts/done-gate/rules.ts",
        "docs/tracker/parse.js",
        "scripts/proof/latest.ts",
        "scripts/proof/slice-0-agents.ts",
        "scripts/proof/claude.ts",
        "scripts/proof/slice-0-plan.ts",
        "scripts/proof/named-tests.ts",
      ]),
    );
    expect(files.filter((f) => /\.test\.ts$/.test(f))).toEqual([]);
    for (const f of [
      "ROADMAP.md",
      "STATE.md",
      "scripts/proof/on-mac.ts",
      "scripts/proof/slice-1.ts",
      RECORD,
    ])
      expect(files).not.toContain(f);
  });

  // behaviour already on main: it tests scripts/done-gate/mac-record.ts, the gate's own code, which main's copy carries over (it is not product code), so it passes there
  it("follow a hook's command to its script and the script's imports, at the commit, as git's id of each one's content", () => {
    const r = repo({
      "AGENTS.md": "the rules: see scripts/d.ts\n",
      ".claude/settings.json": '{"command": "sh \\"$DIR/scripts/hook.sh\\""}',
      "scripts/hook.sh": '"$BUN" scripts/a.ts "$1"\n',
      "scripts/a.ts":
        '// unlike scripts/d.ts\nimport { b } from "./b";\nimport c from "../lib/c.js";\nimport { t } from "./a.test";\nexport const a = b + c + t;\n',
      "scripts/b.ts":
        'export const b = 1;\nconst x = await import("./lazy");\n',
      "scripts/lazy.ts": "export {};\n",
      "lib/c.js": "export default 2;\n",
      "scripts/a.test.ts": "export const t = 0;\n",
      "scripts/d.ts": "export const d = 0;\n",
    });
    const before = fingerprints(r.dir, "HEAD");
    expect(Object.keys(before).sort()).toEqual([
      ".claude/settings.json",
      "AGENTS.md",
      "lib/c.js",
      "scripts/a.ts",
      "scripts/b.ts",
      "scripts/hook.sh",
      "scripts/lazy.ts",
    ]);
    expect(before["scripts/b.ts"]).toBe(
      r.git("rev-parse", "HEAD:scripts/b.ts"),
    );
    r.put({ "scripts/b.ts": "export const b = 3;\n", "scripts/d.ts": "x\n" });
    const after = fingerprints(r.dir, "HEAD");
    expect(after["scripts/b.ts"]).not.toBe(before["scripts/b.ts"]);
    expect(fingerprints(r.dir, "HEAD~1")).toEqual(before);
  });
});

describe("what the record says about a commit's files", () => {
  // behaviour already on main: it tests scripts/done-gate/mac-record.ts, the gate's own code, which main's copy carries over (it is not product code), so it passes there
  it("passed, naming the Mac run, when every step passed and every file is as that run had it", () => {
    const r = judged(record(), FILES);
    expect(r.outcome).toBe("passed");
    expect(r.seen).toContain("passed on Devesh's Mac on 2026-10-14 at ccccccc");
    expect(judged(record(), FILES, "verifier").outcome).toBe("passed");
  });

  // behaviour already on main: it tests scripts/done-gate/mac-record.ts, the gate's own code, which main's copy carries over (it is not product code), so it passes there
  it("waits with no record, or a step it lacks, and once a file was changed, added or removed since", () => {
    expect(judged(undefined, FILES)).toEqual({
      outcome: "waiting",
      seen: `${RECORD} is not committed`,
    });
    const one = record({ steps: [{ name: "verifier", outcome: "passed" }] });
    expect(judged(one, FILES, "verifier").outcome).toBe("passed");
    expect(judged(one, FILES, "agent-session").seen).toContain(
      "has no agent-session step",
    );
    for (const [files, named] of [
      [{ ...FILES, "AGENTS.md": "zz" }, "AGENTS.md"],
      [{ ...FILES, "CLAUDE.md": "n1" }, "CLAUDE.md"],
      [{ "AGENTS.md": "a1" }, "scripts/done-gate.ts"],
    ] as const) {
      const r = judged(record(), files);
      expect(r.outcome).toBe("waiting");
      expect(r.seen).toContain(`1 file(s) those steps test changed`);
      expect(r.seen).toContain(named);
    }
  });

  // behaviour already on main: it tests scripts/done-gate/mac-record.ts, the gate's own code, which main's copy carries over (it is not product code), so it passes there
  it("fails a step the Mac run failed, and a record that is not JSON; a step that waited there still waits", () => {
    const failed = record({
      steps: [
        { name: "agent-session", outcome: "passed", seen: "ok" },
        { name: "verifier", outcome: "failed", seen: "it ruled PASS" },
      ],
    });
    expect(judged(failed, FILES, "agent-session").outcome).toBe("passed");
    expect(judged(failed, FILES)).toEqual({
      outcome: "failed",
      seen: "the verifier step failed on Devesh's Mac on 2026-10-14 at ccccccc: it ruled PASS",
    });
    expect(judged("{", FILES).outcome).toBe("failed");
    const waited = record({
      steps: AI_STEPS.map((name) => ({
        name,
        outcome: "waiting",
        seen: "usage limit",
      })),
    });
    expect(judged(waited, FILES).outcome).toBe("waiting");
  });
});

describe("what `bun run cycle --banner` says about main's record", () => {
  // behaviour already on main: it tests scripts/done-gate/mac-record.ts, the gate's own code, which main's copy carries over (it is not product code), so it passes there
  it("nothing while it holds; otherwise what to run and how to commit it", () => {
    expect(bannerLine({ outcome: "passed", seen: "x" })).toBeUndefined();
    const line = bannerLine({ outcome: "waiting", seen: "AGENTS.md changed" });
    for (const s of [AGAIN, "AGENTS.md changed", MAC_COMMAND, RECORD_PR])
      expect(line).toContain(s);
    expect(bannerLine({ outcome: "failed", seen: "x" })).toContain(
      "FAILED on Devesh's Mac",
    );
  });
});
