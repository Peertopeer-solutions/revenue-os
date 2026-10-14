// The structure rule apps/console/biome.json holds, so no test file has to read source code to check it
// (docs/decisions-in-force/, "Behaviour is proved by behaviour tests"): in the console's src/, only lib/supabase.ts uses the
// Supabase client package, types included, imported or required; everything else goes through its lazy
// getSupabase(). It lints throwaway files with the repository's real lint settings, then the real console's code,
// which must pass in a run where the rule fires. Text-shaped rules (the Anthropic SDK in packages, raw HTML in the
// console) are guards: guards-sdk-raw-html.test.ts.
import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const biome = join(root, "node_modules", ".bin", "biome");
const dir = mkdtempSync(join(tmpdir(), "lint-structure-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A throwaway repository holding the repository's real lint settings, its folder named `name` under `dir`. */
function lintRepo(name: string) {
  const repo = join(dir, name);
  for (const config of [
    "biome.json",
    "apps/console/biome.json",
    "apps/www/biome.json",
  ]) {
    mkdirSync(dirname(join(repo, config)), { recursive: true });
    copyFileSync(join(root, config), join(repo, config));
  }
  spawnSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}
const put = (repo: string, file: string, body: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), body);
};
/** The files biome flags for `rule`, from a lint run in `cwd` over `paths`. */
function flagged(cwd: string, rule: string, paths = ["."]) {
  const r = spawnSync(biome, ["lint", "--max-diagnostics=200", ...paths], {
    cwd,
    encoding: "utf8",
  });
  return [
    ...`${r.stdout}${r.stderr}`.matchAll(
      new RegExp(`^(\\S+):\\d+:\\d+ lint/\\w+/${rule}\\b`, "gm"),
    ),
  ]
    .map(([, file]) => file)
    .sort();
}

const CLIENT =
  'import { createClient } from "@supabase/supabase-js";\nexport const c = createClient;\n';
const CLIENT_TYPE =
  'import type { Session } from "@supabase/supabase-js";\nexport type S = Session;\n';
const CLIENT_REQUIRED =
  'const { createClient } = require("@supabase/supabase-js");\nexport const c = createClient;\n';

it("fails the Supabase client package in the console's src/ outside lib/supabase.ts, however it is loaded", () => {
  const repo = lintRepo("made-up");
  put(repo, "apps/console/src/lib/supabase.ts", CLIENT);
  put(repo, "apps/console/src/lib/other.ts", CLIENT);
  put(repo, "apps/console/src/app/session/x.tsx", CLIENT_TYPE);
  put(repo, "apps/console/src/pages/x.ts", CLIENT_REQUIRED);
  put(repo, "scripts/x.ts", CLIENT);

  expect(flagged(repo, "noRestrictedImports")).toEqual([
    "apps/console/src/app/session/x.tsx",
    "apps/console/src/lib/other.ts",
    "apps/console/src/pages/x.ts",
  ]);
});

it("passes the real console, in a run where the rule fires", () => {
  // The real console's code, beside one file that breaks the rule, so a lint run that checks nothing can't pass.
  const repo = lintRepo("real");
  cpSync(join(root, "apps/console/src"), join(repo, "apps/console/src"), {
    recursive: true,
  });
  put(repo, "apps/console/src/breaks-the-rule.ts", CLIENT_TYPE);
  expect(flagged(repo, "noRestrictedImports")).toEqual([
    "apps/console/src/breaks-the-rule.ts",
  ]);
});
