// A change's tests are proven to test it (scripts/done-gate/tests-proven.ts): each test a change adds or edits must
// fail on main's code and pass on the change. The pure parts (coverage reports, where a test ends, why a file can't
// load, the "behaviour already on main" mark) are checked on text; the whole run on throwaway git repos holding a
// tiny product, with real git and real bun test runs on both sides.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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
import { markBodyProblems, markOn, marksIn } from "./done-gate/already-on-main";
import { CHECKS, tally } from "./done-gate/checks";
import { lineRan, parseLcov } from "./done-gate/lcov";
import { judgePr } from "./done-gate/pr";
import { rulesOn } from "./done-gate/rules";
import { snapshot } from "./done-gate/snapshot";
import { casesOf } from "./done-gate/test-run";
import { testEnd } from "./done-gate/test-span";
import { missingOnMain, testsProven } from "./done-gate/tests-proven";

// Each repo test starts git and bun several times; with other agents busy on the machine that passes bun's 5 s.
setDefaultTimeout(90_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The mark, built from pieces so this file's own lines never carry one.
const MARK = ["// behaviour already", "on main:"].join(" ");

describe("lcov: which lines a test run ran", () => {
  const report = [
    "TN:",
    "SF:apps/x/src/a.ts",
    "DA:1,25",
    "DA:3,0",
    "DA:4,0",
    "DA:5,1",
    "DA:8,2",
    "DA:9,2",
    "end_of_record",
    "SF:/repo/packages/p/src/b.ts",
    "DA:2,1",
    "end_of_record",
  ].join("\n");
  const hits = parseLcov(report, "/repo");

  it("reads each file's line counts, naming files from the root", () => {
    expect([...hits.keys()]).toEqual([
      "apps/x/src/a.ts",
      "packages/p/src/b.ts",
    ]);
    expect(hits.get("apps/x/src/a.ts")?.get(8)).toBe(2);
  });

  it("counts a line as run only when Bun marks it run and the nearest earlier line it lists ran too", () => {
    expect(lineRan(hits, "apps/x/src/a.ts", 1)).toBe(true); // nothing earlier listed
    expect(lineRan(hits, "apps/x/src/a.ts", 9)).toBe(true);
    // Bun 1.3.11 marks a never-called function's last line as run; the line before it says otherwise.
    expect(lineRan(hits, "apps/x/src/a.ts", 5)).toBe(false);
    expect(lineRan(hits, "apps/x/src/a.ts", 3)).toBe(false);
    expect(lineRan(hits, "apps/x/src/a.ts", 2)).toBe(false); // not listed: not code that runs
    expect(lineRan(hits, "apps/x/src/other.ts", 1)).toBe(false); // not in the report: 0% covered
  });
});

describe("testEnd: the last line of the test that starts on a line", () => {
  const source = [
    'import { expect, it } from "bun:test";', // 1
    'it("block", () => {', // 2
    "  expect(1).toBe(1);", // 3
    "});", // 4
    'it("one line", () => expect(f()).toBe(2));', // 5
    'it("wrapped", () =>', // 6
    "  expect(g()).toBe(3));", // 7
    'it("brackets in strings, comments and regexes", () => {', // 8
    "  const s = \"})\" + '({';", // 9
    "  // })", // 10
    "  /* }) */", // 11
    "  expect(s).toMatch(/\\)\\}[)]/);", // 12
    ["  const t = `})$", "{({ a: 1 }).a}$", "{`(`}`;"].join(""), // 13
    "  return render(<p>Don't stop (yet)</p>, <Row x={1} />);", // 14
    "});", // 15
    "for (const c of cases) it(c.name, () => {", // 16
    "  expect(c.got).toBe(c.want);", // 17
    "}, 30_000);", // 18
    "const total = 4 / 2;", // 19
  ].join("\n");

  it("follows the brackets the test's line opens to where they close", () => {
    expect(testEnd(source, 2)).toBe(4);
    expect(testEnd(source, 5)).toBe(5);
    expect(testEnd(source, 6)).toBe(7);
    expect(testEnd(source, 8)).toBe(15);
    expect(testEnd(source, 16)).toBe(18);
    expect(testEnd(source, 19)).toBe(19);
  });
});

describe("casesOf: each test bun's JUnit report lists", () => {
  it("reads the file, line, name and outcome of each test", () => {
    const junit = `<testsuites><testsuite name="t.test.ts" file="t.test.ts">
      <testcase name="ok &amp; fine" classname="" file="t.test.ts" line="3" assertions="1" />
      <testcase name="broken" classname="outer" file="t.test.ts" line="7" assertions="1">
        <failure type="AssertionError" />
      </testcase>
      <testcase name="off" classname="" file="t.test.ts" line="9" assertions="0"><skipped /></testcase>
    </testsuite></testsuites>`;
    expect(casesOf(junit)).toEqual([
      { file: "t.test.ts", line: 3, name: "ok & fine", outcome: "passed" },
      { file: "t.test.ts", line: 7, name: "broken", outcome: "failed" },
      { file: "t.test.ts", line: 9, name: "off", outcome: "skipped" },
    ]);
  });
});

describe("missingOnMain: what a test file that can't load on main's code lacks", () => {
  const main = "/scratch/main";
  it("names a missing export and the file bun looked in", () => {
    const out = `# Unhandled error between tests\nSyntaxError: Export named 'added' not found in module '${main}/apps/x/src/old.ts'.`;
    expect(missingOnMain(out, main)).toEqual({
      export: "added",
      file: "apps/x/src/old.ts",
    });
  });
  it("names a missing module and the file that imported it", () => {
    const out = `error: Cannot find module '../src/fresh' from '${main}/apps/x/test/fresh.test.ts'`;
    expect(missingOnMain(out, main)).toEqual({
      module: "../src/fresh",
      from: "apps/x/test/fresh.test.ts",
    });
  });
  it("names nothing for any other failure to load", () => {
    expect(missingOnMain("error: boom", main)).toBeUndefined();
  });
});

describe("the mark on a test that already passes on main", () => {
  it("reads the reason after the mark, and only a mark with a reason", () => {
    expect(markOn(`  it("x", () => { ${MARK} the route existed`)).toBe(
      "the route existed",
    );
    expect(markOn(`  ${MARK}   `)).toBeUndefined();
    expect(markOn('  it("x", () => {')).toBeUndefined();
  });

  it("finds a mark at the end of a test's first line or alone on the comment line above it, on a test the change touches", () => {
    const text = [
      'it("a", () => {', // 1
      `  ${MARK} inside the test, not on its first line`, // 2
      "});", // 3
      `${MARK} on the comment line above b`, // 4
      'it("b", () => {', // 5
      "});", // 6
      `const y = 1; ${MARK} on code above c, which is no mark for c`, // 7
      `it("c", () => { ${MARK} on c's own line`, // 8
      "});", // 9
      `it("d", () => { ${MARK} on d, which the change leaves alone`, // 10
      "});", // 11
    ].join("\n");
    const touched = [1, 3, 5, 7, 8];
    expect(
      marksIn("t.test.ts", text, (start) => touched.includes(start)),
    ).toEqual([
      {
        file: "t.test.ts",
        line: 2,
        start: 3,
        why: "inside the test, not on its first line",
      },
      {
        file: "t.test.ts",
        line: 4,
        start: 5,
        why: "on the comment line above b",
      },
      {
        file: "t.test.ts",
        line: 7,
        start: 7,
        why: "on code above c, which is no mark for c",
      },
      { file: "t.test.ts", line: 8, start: 8, why: "on c's own line" },
    ]);
  });

  it("asks the PR body to copy each mark", () => {
    const marks = [
      { file: "apps/x/test/a.test.ts", line: 4, start: 4, why: "a guard" },
    ];
    expect(markBodyProblems(marks, "Roadmap: off-roadmap — x")).toEqual([
      'the PR body doesn\'t show the test marked "behaviour already on main" at apps/x/test/a.test.ts:4: add the line `Behaviour already on main: apps/x/test/a.test.ts · a guard`',
    ]);
    expect(
      markBodyProblems(
        marks,
        "x\nBehaviour already on main: apps/x/test/a.test.ts · a guard\n",
      ),
    ).toEqual([]);
  });
});

/** Writes files into a folder, making the folders they need. */
const put = (dir: string, files: Record<string, string>) => {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
};
const sh = (dir: string, cmd: string[]) =>
  spawnSync(cmd[0] as string, cmd.slice(1), { cwd: dir, encoding: "utf8" });

const OLD = "export const old = () => 1;\n";
const OLD_TEST = `import { expect, it } from "bun:test";
import { old } from "../src/old";

it("old works", () => {
  expect(old()).toBe(1);
});
`;
const PRODUCT = { "apps/x/src/old.ts": `${OLD}export const unused = 2;\n` }; // a change with product code

/**
 * A throwaway repo: main holds a tiny product (apps/x/src/old.ts), its test and `onMain`, origin/main points at it,
 * and the change is written into the working tree, as an agent leaves it before committing.
 */
function scratch(
  change: Record<string, string>,
  onMain: Record<string, string> = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tests-proven-")));
  dirs.push(dir);
  put(dir, {
    "package.json": '{ "name": "scratch", "private": true }\n',
    "apps/x/src/old.ts": OLD,
    "apps/x/test/old.test.ts": OLD_TEST,
    ...onMain,
  });
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "add", "-A"]);
  sh(dir, [
    "git",
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "main",
  ]);
  sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
  put(dir, change);
  return dir;
}

const prove = (dir: string) => testsProven(dir, snapshot(dir));
/**
 * The snapshot as the done-rules item's moved-code detection leaves it (scripts/done-gate/moved.ts there): each
 * added and removed line git saw move carries `moved: true`. Here the lines `moved` picks.
 */
const withMoves = (dir: string, moved: (l: { text: string }) => boolean) => {
  const s = snapshot(dir);
  const mark = (ls: typeof s.added) =>
    ls.map((l) => (moved(l) ? { ...l, moved: true } : l));
  return { ...s, added: mark(s.added), removed: mark(s.removed) };
};
/** The start of the check's text when it accepts: how many tests failed on main, of how many it judged. */
const proven = (n: number, of: number) =>
  `Tests proven ✓ ${n} passed on this change and failed on main's code, of ${of} new or edited test(s)`;

describe("testsProven on a throwaway repo", () => {
  it("accepts a test of a brand-new file: it can't load on main, the file is new product code, and the test runs an added line of it", () => {
    const r = prove(
      scratch({
        "apps/x/src/fresh.ts": "export const fresh = (n: number) => n + 1;\n",
        // product code uses the new file, so it is product code, not a test helper
        "apps/x/src/old.ts":
          'import { fresh } from "./fresh";\n\nexport const old = () => fresh(0);\n',
        "apps/x/test/fresh.test.ts": `import { expect, it } from "bun:test";
import { fresh } from "../src/fresh";

it("adds one", () => {
  expect(fresh(1)).toBe(2);
});
`,
      }),
    );
    expect(r.text).toContain(proven(1, 1));
    expect(r.ok).toBe(true);
  });

  it("counts a new file that only another new product file names as product code, not a test helper", () => {
    const r = prove(
      scratch({
        "apps/x/src/base.ts": "export const base = (n: number) => n + 1;\n",
        "apps/x/src/fresh.ts":
          'import { base } from "./base";\n\nexport const fresh = (n: number) => base(n);\n',
        "apps/x/src/old.ts":
          'import { fresh } from "./fresh";\n\nexport const old = () => fresh(0);\n',
        "apps/x/test/base.test.ts": `import { expect, it } from "bun:test";
import { base } from "../src/base";

it("adds one", () => {
  expect(base(1)).toBe(2);
});
`,
      }),
    );
    expect(r.text).toContain(proven(1, 1));
    expect(r.ok).toBe(true);
  });

  it("accepts a test of a new export in an old file, added to that file's old test file", () => {
    const r = prove(
      scratch({
        "apps/x/src/old.ts": `${OLD}
export function doubled(n: number) {
  return n * 2;
}
`,
        "apps/x/test/old.test.ts": OLD_TEST.replace(
          "{ old }",
          "{ doubled, old }",
        ).concat(`
it("doubles", () => {
  expect(doubled(2)).toBe(4);
});
`),
      }),
    );
    expect(r.text).toContain(proven(1, 1));
    expect(r.ok).toBe(true);
  });

  it("accepts a test that reaches a new export through a test helper's re-export", () => {
    const r = prove(
      scratch({
        "apps/x/src/old.ts": `${OLD}
export function doubled(n: number) {
  return n * 2;
}
`,
        "apps/x/test/all.ts": 'export * from "../src/old";\n',
        "apps/x/test/all.test.ts": `import { expect, it } from "bun:test";
import { doubled } from "./all";

it("doubles", () => {
  expect(doubled(2)).toBe(4);
});
`,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain(proven(1, 1));
  });

  it("refuses a test whose only missing import is a new test helper: the helper comes along to main's code, where the test passes, so it tests nothing this change adds", () => {
    const r = prove(
      scratch({
        ...PRODUCT,
        "apps/x/test/make-old.ts":
          'import { old } from "../src/old";\nexport const makeOld = () => old();\n',
        "apps/x/test/helper.test.ts": `import { expect, it } from "bun:test";
import { makeOld } from "./make-old";

it("makes one", () => {
  expect(makeOld()).toBe(1);
});
`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      'apps/x/test/helper.test.ts:4 "makes one" passes on main\'s code too',
    );
  });

  // A helper or fixture neither product code nor in a test folder, by today's product list and by the done-rules
  // item's wider one, comes along to main's code too: a missing helper or fixture never counts.
  it("refuses a test that imports a new helper outside a test folder: the helper comes along to main's code, where the test passes", () => {
    const imported = prove(
      scratch({
        ...PRODUCT,
        "docs/fixtures/rows.ts": "export const rows = [1, 2];\n",
        "apps/x/test/rows.test.ts": `import { expect, it } from "bun:test";
import { rows } from "../../../docs/fixtures/rows";

it("has two rows", () => {
  expect(rows.length).toBe(2);
});
`,
      }),
    );
    expect(imported.ok).toBe(false);
    expect(imported.text).toContain(
      'apps/x/test/rows.test.ts:4 "has two rows" passes on main\'s code too',
    );
  });

  it("refuses a test that reads a new fixture from disk outside a test folder: the fixture comes along to main's code, so the test can't throw there for want of it", () => {
    const read = prove(
      scratch({
        ...PRODUCT,
        "docs/fixtures/rows.json": "[1, 2, 3]\n",
        "apps/x/test/rows.test.ts": `import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

it("reads three rows", () => {
  const rows = JSON.parse(readFileSync(\`\${import.meta.dir}/../../../docs/fixtures/rows.json\`, "utf8"));
  expect(rows.length).toBe(3);
});
`,
      }),
    );
    expect(read.ok).toBe(false);
    expect(read.text).toContain(
      'apps/x/test/rows.test.ts:4 "reads three rows" passes on main\'s code too',
    );
  });

  it("refuses a test leaning on a new helper or fixture in a product folder that only tests name: it comes along to main's code, where the test passes", () => {
    const r = prove(
      scratch({
        // product code quoting a like name ("ones.list") and the gate quoting the helper's name don't count
        "apps/x/src/old.ts": `${OLD}export const LOG = "ones.list";\n`,
        "scripts/done-gate/quote.ts":
          'export const Q = "../src/testing/sample";\n',
        // nor does a Markdown page naming it
        "docs/testing.md":
          "The sample lives in `apps/x/src/testing/sample.ts`.\n",
        // a helper named only by another helper is a helper too
        "apps/x/src/testing/sample.ts":
          'import { ONE } from "./one";\n\nexport const SAMPLE = ONE;\n',
        "apps/x/src/testing/one.ts": "export const ONE = 1;\n",
        "apps/x/src/__fixtures__/ones.json": "[1, 1]\n",
        "apps/x/test/sample.test.ts": `import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { old } from "../src/old";
import { SAMPLE } from "../src/testing/sample";

it("old gives the sample", () => {
  expect(old()).toBe(SAMPLE);
});

it("old gives each fixture", () => {
  const ones = JSON.parse(readFileSync(\`\${import.meta.dir}/../src/__fixtures__/ones.json\`, "utf8"));
  for (const one of ones) expect(old()).toBe(one);
});
`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      'apps/x/test/sample.test.ts:6 "old gives the sample" passes on main\'s code too',
    );
    expect(r.text).toContain(
      'apps/x/test/sample.test.ts:10 "old gives each fixture" passes on main\'s code too',
    );
  });

  describe("in a test file that can't load on main, each test counts only when it runs an added line beyond what loading runs", () => {
    const E164 = `${OLD}const E164 = /^\\+[1-9]\\d{7,14}$/;
export function isE164(s: string) {
  return E164.test(s);
}
`;
    const file = (...tests: string[]) => `import { expect, it } from "bun:test";
import { isE164, old } from "../src/old";
${tests.join("")}`;
    const exported = `
it("is exported", () => {
  expect(isE164).toBeDefined();
});
`;
    const calls = `
it("knows a number", () => {
  expect(isE164("+14155550100")).toBe(true);
});
`;
    const oldOne = `
it("old still one", () => {
  expect(old()).toBe(1);
});
`;

    it("refuses a test that only loads the new export, and a test of old behaviour beside it", () => {
      const r = prove(
        scratch({
          "apps/x/src/old.ts": E164,
          "apps/x/test/e164.test.ts": file(exported, oldOne),
        }),
      );
      expect(r.ok).toBe(false);
      for (const t of ['4 "is exported"', '8 "old still one"'])
        expect(r.text).toContain(
          `apps/x/test/e164.test.ts:${t} can't load on main's code because apps/x/src/old.ts lacks the export isE164, and run alone on this change it runs none of the lines this change adds to apps/x/src/old.ts beyond what loading them runs`,
        );
    });

    it("counts the test that calls the new export, and refuses the test of old behaviour beside it", () => {
      const r = prove(
        scratch({
          "apps/x/src/old.ts": E164,
          "apps/x/test/e164.test.ts": file(calls, oldOne),
        }),
      );
      expect(r.ok).toBe(false);
      expect(r.text).toContain("1 problem(s)");
      expect(r.text).toContain('e164.test.ts:8 "old still one" can\'t load');
    });

    it("counts a call of a one-line function, whose line loading runs too", () => {
      const r = prove(
        scratch({
          "apps/x/src/old.ts": `${OLD}export const isE164 = (s: string) => /^\\+[1-9]\\d{7,14}$/.test(s);\n`,
          "apps/x/test/e164.test.ts": file(calls),
        }),
      );
      expect(r.ok).toBe(true);
      expect(r.text).toContain(proven(1, 1));
      expect(r.text).toContain(
        "1 of them because their file can't load there without what this change adds",
      );
    });

    it("refuses a test that runs an added line of another product file, not of the one adding the missing export", () => {
      const other = (n: number) =>
        `export function other() {\n  return ${n};\n}\n`;
      const r = prove(
        scratch(
          {
            "apps/x/src/old.ts": E164,
            "apps/x/src/other.ts": other(2),
            "apps/x/test/e164.test.ts": `${file(calls)}import { other } from "../src/other";

it("other is two", () => {
  expect(other()).toBe(2);
});
`,
          },
          { "apps/x/src/other.ts": other(1) },
        ),
      );
      expect(r.ok).toBe(false);
      expect(r.text).toContain("1 problem(s)");
      expect(r.text).toContain(
        "e164.test.ts:9 \"other is two\" can't load on main's code because apps/x/src/old.ts lacks the export isE164",
      );
    });
  });

  it("accepts a test that fails on main by an assertion or by throwing, and refuses one that fails on the change", () => {
    const change = (wantOnChange: number) => ({
      "apps/x/src/old.ts": "export const old = () => 7;\n",
      "apps/x/test/old.test.ts": `${OLD_TEST}
it("is seven", () => {
  expect(old()).toBe(${wantOnChange});
});

it("throws on main", () => {
  if (old() !== 7) throw new Error("not seven");
});
`,
    });
    const good = prove(scratch(change(7)));
    expect(good.text).toContain(proven(2, 2));
    expect(good.ok).toBe(true);
    const bad = prove(scratch(change(8)));
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain(
      'apps/x/test/old.test.ts:8 "is seven" fails on this change',
    );
  });

  // behaviour already on main: this change only awaits the pull-request check, now asynchronous; what it checks is main's, and main's copy carries the gate's own code over, so it passes there
  it("refuses a new test that passes on main, and accepts it once its line says why, shown at every stop and asked of the PR body", async () => {
    const test = (mark: string) => ({
      ...PRODUCT,
      "apps/x/test/old.test.ts": `${OLD_TEST}
it("still one", () => {${mark}
  expect(old()).toBe(1);
});
`,
    });
    const bare = prove(scratch(test("")));
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain(
      'apps/x/test/old.test.ts:8 "still one" passes on main\'s code too',
    );
    const dir = scratch(test(` ${MARK} a guard for the old rule`));
    const marked = prove(dir);
    expect(marked.ok).toBe(true);
    const note =
      'test marked "behaviour already on main" at apps/x/test/old.test.ts:8: a guard for the old rule';
    expect(marked.text).toContain(note);
    expect(marked.text).toContain(
      "of 1 new or edited test(s) in 1 file(s); 1 of them pass(es) there too and carry the mark",
    );
    expect(rulesOn(snapshot(dir)).notes).toContain(note);
    expect(
      (await judgePr(snapshot(dir), "Roadmap: off-roadmap — x")).problems,
    ).toContain(
      'the PR body doesn\'t show the test marked "behaviour already on main" at apps/x/test/old.test.ts:8: add the line `Behaviour already on main: apps/x/test/old.test.ts · a guard for the old rule`',
    );
    // What a stop shows for the check counts the tests it proved, not the marked ones.
    expect(tally("tests proven", marked.text)).toBe("0 tests proven");
  });

  it("shows a mark at the stop even when git's answer reading the marked test file comes back empty", () => {
    const dir = scratch({
      ...PRODUCT,
      "apps/x/test/old.test.ts": `${OLD_TEST}
it("still one", () => { ${MARK} a guard for the old rule
  expect(old()).toBe(1);
});
`,
    });
    // A fake git, first on the PATH, answers the first read of that file with nothing, as Bun's synchronous spawn
    // can under load (oven-sh/bun#34069).
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "tests-proven-bin-")));
    dirs.push(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *:apps/x/test/old.test.ts) [ -e "$0.asked" ] || { : > "$0.asked"; exit 0; } ;; esac\nexec ${Bun.which("git")} "$@"\n`,
      { mode: 0o755 },
    );
    const gate = (f: string) => join(import.meta.dir, "done-gate", f);
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `import { rulesOn } from "${gate("rules.ts")}";\nimport { snapshot } from "${gate("snapshot.ts")}";\nconsole.log(rulesOn(snapshot(".")).notes.join("\\n"));`,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(existsSync(join(bin, "git.asked"))).toBe(true); // the read did come back empty once
    expect(r.stdout).toContain(
      'test marked "behaviour already on main" at apps/x/test/old.test.ts:8: a guard for the old rule',
    );
  });

  it("takes a mark on the comment line just above a test, and no other line above it", () => {
    const r = prove(
      scratch({
        ...PRODUCT,
        "apps/x/test/old.test.ts": `${OLD_TEST}
${MARK} the comment line above
it("above", () => {
  expect(old()).toBe(1);
});

${MARK} two lines above

it("two above", () => {
  expect(old()).toBe(1);
});

const one = 1; ${MARK} on code above
it("code above", () => {
  expect(old()).toBe(one);
});
`,
      }),
    );
    expect(r.text).not.toContain('"above" passes on main');
    expect(r.text).toContain('old.test.ts:15 "two above" passes on main');
    expect(r.text).toContain('old.test.ts:20 "code above" passes on main');
    expect(r.ok).toBe(false);
  });

  it("refuses a test skipped on main, one main's code doesn't hold, one that can't run on the change, and one whose run on main never finishes", () => {
    const ns = 'import * as x from "../src/old";\n';
    const r = prove(
      scratch({
        "apps/x/src/old.ts": `${OLD}export const NAMES = ["two"];\nexport const two = () => 2;\n`,
        "apps/x/test/skipped.test.ts": `import { expect, it } from "bun:test";
${ns}
it.skipIf(!("two" in x))("two", () => {
  expect(x.two()).toBe(2);
});
`,
        // tests made from a list the change adds: on main the file loads, but holds none of them
        "apps/x/test/listed.test.ts": `import { expect, it } from "bun:test";
${ns}
for (const n of (x as { NAMES?: string[] }).NAMES ?? [])
  it(\`has \${n}\`, () => {
    expect(n).toBe("two");
  });
`,
        "apps/x/test/broken.test.ts": `import { expect, it } from "bun:test";
import { nope } from "../src/old";

it("can't load anywhere", () => {
  expect(nope).toBe(1);
});
`,
        "apps/x/test/killed.test.ts": `import { expect, it } from "bun:test";
${ns}
it("two, or the run dies", () => {
  if (!("two" in x)) process.kill(process.pid, "SIGKILL");
  expect(x.two()).toBe(2);
});
`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      'apps/x/test/skipped.test.ts:4 "two" is skipped on main\'s code',
    );
    expect(r.text).toContain(
      "apps/x/test/listed.test.ts:5 \"has two\" doesn't run on main's code",
    );
    expect(r.text).toContain(
      "apps/x/test/broken.test.ts can't run on this change",
    );
    expect(r.text).toContain(
      "apps/x/test/killed.test.ts didn't finish on main's code",
    );
  });

  it("judges only the tests whose own lines the change adds or edits", () => {
    // The old test passes on main and is untouched; the new import line sits outside every test.
    const r = prove(
      scratch({
        "apps/x/src/old.ts":
          "export const old = () => 1;\nexport const two = () => 2;\n",
        "apps/x/test/old.test.ts": OLD_TEST.replace(
          "{ old }",
          "{ old, two }",
        ).concat(`
it("two", () => {
  expect(two()).toBe(2);
});
`),
      }),
    );
    expect(r.text).toContain(proven(1, 1));
  });

  it("judges a test the change edits only by deleting a line from it", () => {
    const sign = "export const sign = (n: number) => (n < 0 ? -1 : 1);\n";
    const signTest = (zero: string) => `import { expect, it } from "bun:test";
import { sign } from "../src/sign";

it("signs", () => {
  expect(sign(-3)).toBe(-1);
${zero}});
`;
    const r = prove(
      scratch(
        {
          "apps/x/src/sign.ts":
            "export const sign = (n: number) => (n < 0 ? -1 : n === 0 ? 0 : 1);\n",
          "apps/x/test/sign.test.ts": signTest(""),
        },
        {
          "apps/x/src/sign.ts": sign,
          "apps/x/test/sign.test.ts": signTest("  expect(sign(0)).toBe(1);\n"),
        },
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      'apps/x/test/sign.test.ts:4 "signs" passes on main\'s code too',
    );
  });

  it("runs both sides in copies built alike, so a test that needs a git checkout runs in one on main too", () => {
    const r = prove(
      scratch({
        ...PRODUCT,
        "apps/x/test/old.test.ts": `${OLD_TEST}
it("lives in a git checkout", () => {
  const git = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: import.meta.dir });
  expect(git.stdout.toString().trim()).toBe("true");
});
`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      'apps/x/test/old.test.ts:8 "lives in a git checkout" passes on main\'s code too',
    );
  });

  it("runs the change's side in a copy too, so a test leaning on a file git ignores can't pass there and fail on main", () => {
    const dir = scratch(
      {
        ...PRODUCT,
        "local.json": "1\n",
        "apps/x/test/old.test.ts": `${OLD_TEST}
it("matches the local file", () => {
  expect(old()).toBe(Number(require("node:fs").readFileSync(\`\${import.meta.dir}/../../../local.json\`, "utf8")));
});
`,
      },
      { ".gitignore": "local.json\n" },
    );
    const r = prove(dir);
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      'apps/x/test/old.test.ts:8 "matches the local file" fails on this change (in a scratch copy of it, which holds nothing git ignores)',
    );
  });

  // behaviour already on main: this change only awaits the pull-request check, now asynchronous; what it checks is main's, and main's copy carries the gate's own code over, so it passes there
  it("shows a mark main already holds on a test the change edits, and a mark in the gate's own tests, at the stop and in the PR body", async () => {
    const marked = (extra: string) => `${OLD_TEST}
it("still one", () => { ${MARK} guards the old rule
  expect(old()).toBe(1);
${extra}});
`;
    const gateTest = `import { expect, it } from "bun:test";
import { old } from "../apps/x/src/old";

it("old is one", () => { ${MARK} the gate's own code comes along to main
  expect(old()).toBe(1);
});
`;
    // A mark on a test the change leaves alone is not shown.
    const untouched = `\nit("untouched", () => { ${MARK} not this change's\n  expect(old()).toBe(1);\n});\n`;
    const dir = scratch(
      {
        ...PRODUCT,
        "apps/x/test/old.test.ts": `${marked("  expect(old()).not.toBe(2);\n")}${untouched}`,
        "scripts/done-gate-extra.test.ts": gateTest,
      },
      { "apps/x/test/old.test.ts": `${marked("")}${untouched}` },
    );
    const r = prove(dir);
    expect(r.ok).toBe(true);
    const notes = rulesOn(snapshot(dir)).notes;
    const body = (await judgePr(snapshot(dir), "x")).problems.join("\n");
    for (const shown of [r.text, notes.join("\n"), body])
      expect(shown).not.toContain("not this change's");
    for (const [at, why] of [
      ["apps/x/test/old.test.ts:8", "guards the old rule"],
      [
        "scripts/done-gate-extra.test.ts:4",
        "the gate's own code comes along to main",
      ],
    ]) {
      const note = `test marked "behaviour already on main" at ${at}: ${why}`;
      expect(r.text).toContain(note);
      expect(notes).toContain(note);
      expect(body).toContain(
        `at ${at}: add the line \`Behaviour already on main: ${at.split(":")[0]} · ${why}\``,
      );
    }
  });

  it("copies a link in the change as a link", () => {
    const dir = scratch({
      "apps/x/src/old.ts": "export const old = () => 7;\n",
      "apps/x/test/old.test.ts": `${OLD_TEST}
it("is seven", () => {
  expect(old()).toBe(7);
});
`,
    });
    symlinkSync("apps", join(dir, "apps-link")); // a link to a folder
    const r = prove(dir);
    expect(r.text).toContain(proven(1, 1));
    expect(r.ok).toBe(true);
  });

  // MAY_SKIP is empty today, so the check is given a list of its own, as it is given MAY_SKIP in the gate.
  // behaviour already on main: a listed test is left unjudged as before; only the test's example changed
  it("leaves a test MAY_SKIP lets skip unjudged when it skips on either side, and says where", () => {
    const at =
      'not judged: scripts/somewhere.test.ts:4 "runs only somewhere" is skipped';
    const maySkip = {
      "scripts/somewhere.test.ts > runs only somewhere": "a reason",
    };
    const skipped = (when: string) => {
      const dir = scratch({
        "apps/x/src/old.ts": `${OLD}export const two = () => 2;\n`,
        "scripts/somewhere.test.ts": `import { expect, it } from "bun:test";
import * as x from "../apps/x/src/old";

it.skipIf(${when})("runs only somewhere", () => {
  expect(x.two()).toBe(2);
});
`,
      });
      return testsProven(dir, snapshot(dir), maySkip);
    };
    const none =
      "Tests proven ✓ no new or edited test judged: each one skipped, as MAY_SKIP allows";
    const onChange = skipped("true");
    expect(onChange.ok).toBe(true);
    expect(onChange.text).toContain(none);
    expect(onChange.text).toContain(
      `${at} on this change, which MAY_SKIP allows`,
    );
    const onMain = skipped('!("two" in x)');
    expect(onMain.ok).toBe(true);
    expect(onMain.text).toContain(none);
    expect(onMain.text).toContain(
      `${at} on main's code, which MAY_SKIP allows`,
    );
  });

  it("exempts a change with no product code", () => {
    const noProduct = prove(
      scratch({
        "apps/x/test/old.test.ts": `${OLD_TEST}
it("still one", () => {
  expect(old()).toBe(1);
});
`,
      }),
    );
    expect(noProduct.ok).toBe(true);
    expect(noProduct.text).toContain("no product code changed");
  });

  // Moved lines, as the done-rules item's moved-code detection marks them in the snapshot, are left out.
  it("leaves out a renamed test file, every line of which moved", () => {
    const renamed = scratch({
      ...PRODUCT,
      "apps/x/test/renamed.test.ts": OLD_TEST,
    });
    rmSync(join(renamed, "apps/x/test/old.test.ts"));
    const whole = testsProven(
      renamed,
      withMoves(renamed, () => true),
    );
    expect(whole.text).toContain(
      "Tests proven ✓ no test added or edited outside moved lines",
    );
    expect(whole.ok).toBe(true);
  });

  it("leaves out a line moved from one test into another, judging only the new test beside them", () => {
    // From the end of "old works" to the start of "old is a number".
    const two = (
      names: string,
      first: string,
      second: string,
    ) => `${OLD_TEST.replace("{ old }", names).replace("});", `${first}});`)}
it("old is a number", () => {
${second}  expect(typeof old()).toBe("number");
});
`;
    const line = "  expect(old()).not.toBe(2); // and never two\n";
    const within = scratch(
      {
        "apps/x/src/old.ts": `${OLD}export const doubled = (n: number) => n * 2;\n`,
        "apps/x/test/old.test.ts": `${two("{ doubled, old }", "", line)}
it("doubles", () => {
  expect(doubled(2)).toBe(4);
});
`,
      },
      { "apps/x/test/old.test.ts": two("{ old }", line, "") },
    );
    const r = testsProven(
      within,
      withMoves(within, (l) => l.text.includes("never two")),
    );
    expect(r.text).toContain(proven(1, 1));
    expect(r.ok).toBe(true);
  });

  it("runs as `bun run gate proven`, failing with the reason", () => {
    const dir = scratch({
      ...PRODUCT,
      "apps/x/test/old.test.ts": `${OLD_TEST}
it("still one", () => {
  expect(old()).toBe(1);
});
`,
    });
    // The gate, and the roadmap reader it shares with the tracker.
    for (const f of [
      "scripts/done-gate.ts",
      "scripts/done-gate",
      "docs/tracker/parse.js",
    ])
      cpSync(join(import.meta.dir, "..", f), join(dir, f), { recursive: true });
    const r = sh(dir, [process.execPath, "scripts/done-gate.ts", "proven"]);
    expect(r.stdout).toContain(
      'apps/x/test/old.test.ts:8 "still one" passes on main\'s code too',
    );
    expect(r.status).toBe(1);
  });
});

describe("where the check runs", () => {
  it("is one of the gate's checks, on the shared database, so a stop without Docker leaves it to CI with the tests", () => {
    expect(CHECKS.find((c) => c.name === "tests proven")).toEqual({
      name: "tests proven",
      cmd: ["bun", "run", "local", "bun", "run", "gate", "proven"],
      db: true,
    });
  });

  it("runs in CI's quick job right after the local stack starts, on a database no whole-suite run has filled, against the pull request's base, with the job's own files ignored", () => {
    const ci = Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
        "utf8",
      ),
    ) as {
      jobs: { quick: { steps: { run?: string; env?: { BASE?: string } }[] } };
    };
    const steps = ci.jobs.quick.steps;
    const tests = steps.findIndex(
      (s) => s.run === "bash .github/test-stack.sh",
    );
    expect(steps[tests + 1]).toMatchObject({
      run: 'git ls-files --others --exclude-standard >> .git/info/exclude\nbun run gate proven --base "$BASE"\n',
      env: { BASE: `origin/\${{ github.base_ref || 'main' }}` },
    });
  });

  it("counts a file the job made in the checkout as no change once git ignores it, as CI's step does", () => {
    const dir = scratch({ "results.sarif": "{}\n" }); // a file a CI step leaves in the checkout
    expect(prove(dir).text).not.toContain("no product code changed");
    const made = sh(dir, ["git", "ls-files", "--others", "--exclude-standard"]);
    writeFileSync(join(dir, ".git", "info", "exclude"), made.stdout);
    expect(prove(dir).text).toContain("no product code changed");
  });
});
