// The limits in biome.json reach the code they are meant for. A function over the complexity limit of 20 fails
// lint in every app, service and package, never in scripts, and not in the files exempted until their next
// rewrite (docs/fix-when-touched.md, entry 11). A circle of imports fails lint anywhere. Each app reads biome.json
// through its own, whose paths start at the app, so a pattern like apps/*/src misses it: this test is what shows it.
import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "lint-limits-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const put = (file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
// Cognitive complexity 38: loops and branches nested five deep.
const tangled = `export function f(a: number[]) {
  let n = 0;
  for (const x of a) {
    if (x > 1) {
      for (const y of a) {
        if (y > 2) {
          while (n < 9) {
            if (n % 2) n++;
            else if (n % 3) n += 2;
            else n += 3;
          }
        } else if (y < 0) n--;
      }
    } else if (x < 0) n -= 2;
    else n = x ? (n ? 1 : 2) : 3;
  }
  return n;
}
`;

it("fails a tangled function in every app, service and package, a circle of imports anywhere, and nothing else", () => {
  for (const config of [
    "biome.json",
    "apps/console/biome.json",
    "apps/www/biome.json",
  ]) {
    mkdirSync(dirname(join(dir, config)), { recursive: true });
    copyFileSync(join(root, config), join(dir, config));
  }
  const over = [
    "apps/console/src/x.tsx",
    "apps/www/src/x.ts",
    "services/worker/src/x.ts",
    "packages/db/src/x.ts",
    "packages/shared/src/x.ts",
    "services/worker/src/vapi/process.ts",
  ];
  for (const file of [...over, "scripts/x.ts", "packages/harness/src/loop.ts"])
    put(file, tangled);
  put(
    "scripts/a.ts",
    'import { b } from "./b";\nexport const a = () => b();\n',
  );
  put(
    "scripts/b.ts",
    'import { a } from "./a";\nexport const b = () => a();\n',
  );
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const r = spawnSync(
    join(root, "node_modules", ".bin", "biome"),
    ["lint", "--max-diagnostics=100", "."],
    { cwd: dir, encoding: "utf8" },
  );
  const flagged = (rule: string) =>
    [
      ...`${r.stdout}${r.stderr}`.matchAll(
        new RegExp(`^(\\S+):\\d+:\\d+ lint/\\w+/${rule}\\b`, "gm"),
      ),
    ]
      .map(([, file]) => file)
      .sort();
  expect(flagged("noExcessiveCognitiveComplexity")).toEqual([...over].sort());
  expect(flagged("noImportCycles")).toEqual(["scripts/a.ts", "scripts/b.ts"]);
});
