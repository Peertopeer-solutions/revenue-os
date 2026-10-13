// Worktrees stay out of lint. A stale worktree under .claude/worktrees once made every check look broken: its copy
// of the repo's files entered `bun run lint` (`biome check .`) and clashed with the checkout's own settings. biome.json
// leaves the folder out by itself, and git ignores it too, so neither depends on the other.
import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIOME = join(ROOT, "node_modules", ".bin", "biome");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A file biome refuses: its spacing is not the formatter's.
const BADLY_FORMATTED = "const  a=1;\nexport { a };\n";

/** `biome check .` in a scratch repository holding only the repo's biome.json and `files`: its exit status and output. */
function lint(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lint-scope-")));
  dirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir }); // biome.json reads git's ignore rules; there are none here
  copyFileSync(join(ROOT, "biome.json"), join(dir, "biome.json"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const r = spawnSync(BIOME, ["check", "."], { cwd: dir, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// behaviour already on main: biome.json has left .claude/worktrees out since July; this fails if that ever stops
it("biome.json leaves .claude/worktrees out of lint by itself, while the same file elsewhere fails it", () => {
  const ok = "export const a = 1;\n";
  const inWorktree = lint({
    "src/ok.ts": ok,
    ".claude/worktrees/w/bad.ts": BADLY_FORMATTED,
  });
  expect(inWorktree.status).toBe(0);
  expect(inWorktree.out).not.toContain("bad.ts");
  const elsewhere = lint({ "src/ok.ts": ok, "src/bad.ts": BADLY_FORMATTED });
  expect(elsewhere.status).not.toBe(0);
  expect(elsewhere.out).toContain("bad.ts");
});

// behaviour already on main: .gitignore has ignored .claude/worktrees since July; this fails if that ever stops
it("git ignores .claude/worktrees in this checkout", () => {
  const r = spawnSync(
    "git",
    ["check-ignore", "--no-index", ".claude/worktrees/any/file.ts"],
    { cwd: ROOT, encoding: "utf8" },
  );
  expect([r.status, r.stdout.trim()]).toEqual([
    0,
    ".claude/worktrees/any/file.ts",
  ]);
});
