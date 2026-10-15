// The done rules refuse a test file that reads source code as text (scripts/done-gate/source-reading.ts), and that
// refusal stays as tight as it was: structure rules and secret scans live in lint (biome.json) and `bun run guards`
// (scripts/guards/), never in a test file, so no exception is ever needed. Bun can also read a file as text by
// importing it with options (`with { type: "text" }`, or `type: "file"`, which hands over its path), which reads
// nothing through readFileSync or Bun.file; that is refused too. What still gets past it is listed in
// docs/done-gate.md → The done gate.
import { describe, expect, it } from "bun:test";
import { checkRules } from "./done-gate/rules";

const READS =
  "reads source code as text; test what the code does (render it, call it, drive it), not what it says";
const problemsOf = (file: string, ...lines: string[]) =>
  checkRules(
    [file],
    lines.map((text, i) => ({ file, line: i + 1, text })),
    () => [],
  ).problems;

describe("a test that reads source code as text", () => {
  const test = "apps/console/test/home.test.tsx";
  const refused = (...at: number[]) => at.map((n) => `${test}:${n} ${READS}`);

  // behaviour already on main: main's copy carries scripts/done-gate/rules.ts and source-reading.ts over, so it passes there
  it("is refused when it reads the file, whatever a comment on the line says", () => {
    expect(
      problemsOf(
        test,
        'const HOME_SRC = "apps/console/src/pages/Home.tsx";',
        "expect(await Bun.file(HOME_SRC).text()).toMatch(/<DataShell/);",
        'expect(readFileSync(HOME_SRC, "utf8")).toContain("Home"); // not a fixture',
        "const stream = createReadStream(HOME_SRC);",
        'const t = readFileSync("tests/fixtures/../../apps/console/src/main.tsx", "utf8");',
      ),
    ).toEqual(refused(2, 3, 4, 5));
  });

  // behaviour already on main: main's copy carries scripts/done-gate/rules.ts and source-reading.ts over, so it passes there
  it("is refused when it imports a code file with options, statically or on demand", () => {
    for (const line of [
      'import home from "../src/pages/Home/index.tsx" with { type: "text" };',
      "import main from '../src/main.tsx' with {type:'text'};",
      'import mainPath from "../src/main.tsx" with { type: "file" };',
      'const src = await import("../src/main.tsx", { with: { type: "text" } });',
      'const api = (await import("../../src/lib/api.ts", { with: { type: "text" } })).default;',
      'const src = (await import("../src/main.tsx", asText)).default;',
      'await import("../src/main.tsx", { with: { type: t } });',
      'import main from "../src/main.tsx" with { type: "text" }; await import("./x.json");',
      'import main from "tests/fixtures/../../apps/console/src/main.tsx" with { type: "text" };',
    ])
      expect(problemsOf(test, line)).toEqual(refused(1));
    // A path held in a name, when the test names a source path.
    expect(
      problemsOf(
        test,
        'const MAIN = "../src/main.tsx";',
        "const src = (await import(MAIN, asText)).default;",
      ),
    ).toEqual(refused(2));
    // The formatter wraps a long one.
    expect(
      problemsOf(
        test,
        'const src = await import("../src/pages/Conversations/index.tsx", {',
        '  with: { type: "text" },',
        "});",
      ),
    ).toEqual(refused(1));
    expect(
      problemsOf(
        test,
        "const src = await import(",
        '  "../src/pages/Conversations/index.tsx",',
        '  { with: { type: "text" } },',
        ");",
      ),
    ).toEqual(refused(1));
  });

  // behaviour already on main: main's copy carries scripts/done-gate/rules.ts and source-reading.ts over, so it passes there
  it("is not refused for importing code to run it, a data file as text, or a field typed text", () => {
    for (const line of [
      'import { HomePage } from "../src/pages/Home/index";',
      'const { Boot } = await import("../src/app/Boot.tsx");',
      'const { Boot } = await import(join(consoleDir, "src", "app", "Boot.tsx"));',
      'import rows from "./fixtures/leads.csv" with { type: "text" };',
      'import config from "../../../.gitleaks.toml" with { type: "text" };',
      'import seed from "../src/seed.json" with { type: "json" };',
      'const fields = [{ name: "src", type: "text" }];',
    ])
      expect(problemsOf(test, line)).toEqual([]);
    expect(
      problemsOf(test, '  path: "src/app.ts",', '  type: "text",'),
    ).toEqual([]);
  });
});
