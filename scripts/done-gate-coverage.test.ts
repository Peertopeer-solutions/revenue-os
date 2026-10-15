// Every product line a change adds is run by at least one test (ROADMAP.md, Slice 0). The gate's own test run
// (`bun run gate tests`) writes an lcov report, and each line the change adds to a .ts or .tsx file under apps,
// services or packages must be one it ran, read with the line rule in scripts/done-gate/lcov.ts. The shapes below
// are reproduced on real Bun coverage, so a Bun upgrade that changes what Bun reports shows up here: the first test
// fails until someone re-runs them on the new version, updates which the rule catches and the known holes in
// docs/done-gate.md (STATE.md's coverage row points there), and then WRITTEN_FOR.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unrunLines } from "./done-gate/coverage";
import { markNotes } from "./done-gate/coverage-marks";
import type { Added } from "./done-gate/diff";
import { type Hits, lineRan, parseLcov } from "./done-gate/lcov";
import { untestedMigrations } from "./done-gate/migration-tests";
import { unquotedMarks } from "./done-gate/pr-coverage-marks";
import { checkRules } from "./done-gate/rules";

/** The Bun version these shapes were reproduced on. */
const WRITTEN_FOR = "1.3.11";

setDefaultTimeout(30_000); // the gate runs start bun and git several times
const dirs: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `done-gate-coverage-${name}-`));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const write = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
const sh = (dir: string, cmd: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

// behaviour already on main: only its message now names docs/done-gate.md, where STATE.md's known holes moved
it(`the shapes below were reproduced on Bun ${WRITTEN_FOR}, the version the repo pins`, () => {
  const pinned = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ).engines.bun;
  if (pinned !== WRITTEN_FOR || Bun.version !== WRITTEN_FOR)
    throw new Error(
      `Bun is ${Bun.version} and the repo pins ${pinned}, but the coverage shapes in this file were reproduced on ${WRITTEN_FOR}. Re-run each shape on the new version, update which the rule catches here and the known holes in docs/done-gate.md, then set WRITTEN_FOR.`,
    );
});

// Each shape, with the paths a test takes. The line that never runs carries a comment naming it.
const SHAPES = `export const oneLine = () => 5; // ONE-LINE-FUNCTION

export function neverCalled(x: number) {
  const doubled = x * 2;
  return doubled; // NEVER-CALLED
}

export function sign(x: number) {
  if (x >= 0) {
    return "plus";
  } else {
    return "minus"; // NEVER-TAKEN-ELSE
  }
}

export const shapes = {
  used() {
    return 1;
  },
  unused() {
    return 2; // NEVER-CALLED-METHOD
  },
};

export function pick(x: string) {
  switch (x) {
    case "a":
      return 1;
    default:
      return 0; // UNUSED-DEFAULT
  }
}

export function firstArm(yes: boolean) {
  return yes
    ? "yes" // FIRST-ARM
    : "no";
}

export function lastArm(yes: boolean) {
  return yes
    ? "yes"
    : "no"; // LAST-ARM
}

export class Box {
  open() {
    return 1;
  }
  shut() {
    const a = 1;
    return a; // UNLISTED
  }
  close(x: number) {
    const a = x * 3;
    return a; // NOT-FOLDED
  }
}

export function outer() {
  const inner = () => {
    const z = 3;
    return z;
  };
  return 2; // WRONGLY-REPORTED
}

export function isConflict(err: unknown) {
  if (
    typeof err === "object" &&
    err !== null && // SHORT-CIRCUIT
    (err as { code?: string }).code === "23505"
  ) {
    return true;
  }
  return false;
}

export function kindOf(kind: string) {
  if (kind === "a") {
    return 1;
  }
  if (kind === "b") {
    return 2;
  }
  throw new Error("unknown kind");
}

function afterUnrun(raw: unknown) { // AFTER-UNRUN
  const out = String(raw);
  return out;
}
export const useAfterUnrun = (r: unknown) => afterUnrun(r);

export const folded = {
  unused() {
    const a = 1;
    return a;
  },
  used() { // METHOD-AFTER-FOLDED
    const b = String(2);
    return b;
  },
};
`;
// Run only in a child process the test starts, the way services/worker/test/env-port.test.ts starts the worker.
const CLI = `export const greet = (name: string) => "hi " + name;
if (import.meta.main) {
  console.log(greet(process.argv[2] ?? "you")); // CHILD-ONLY
}
`;
const SHAPES_TEST = `import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { greet } from "./cli";
import { firstArm, folded, isConflict, kindOf, lastArm, outer, pick, shapes, sign, useAfterUnrun } from "./shapes";
test("the paths a test takes", () => {
  expect(sign(1)).toBe("plus");
  expect(shapes.used()).toBe(1);
  expect(pick("a")).toBe(1);
  expect(firstArm(false)).toBe("no");
  expect(lastArm(true)).toBe("yes");
  expect(outer()).toBe(2);
  expect(isConflict("nope")).toBe(false);
  expect(kindOf("a")).toBe(1);
  expect(useAfterUnrun(1)).toBe("1");
  expect(folded.used()).toBe("2");
  expect(greet("me")).toBe("hi me"); // the file is loaded; its entry point runs only in the child below
  const cli = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "devesh"], { encoding: "utf8" });
  expect(cli.stdout.trim()).toBe("hi devesh");
});
`;
const lineOf = (tag: string, text = SHAPES) =>
  text.split("\n").findIndex((l) => l.endsWith(`// ${tag}`)) + 1;

// How docs/done-gate.md → Every added line is run by a test (the detail of STATE.md's coverage row) names each shape
// the rule cannot catch, and each it wrongly reports as not run.
const NOT_CAUGHT = {
  default: "an unused switch `default:`",
  arm: "a never-taken ternary arm on its own line",
  oneLine: "a never-called function written on one line",
  shortCircuit: "a later operand of `&&`, `??` or a logical or on its own line",
  folded:
    "the last line of a never-called function or method whose body Bun folds to a constant",
};
const WRONGLY_REPORTED = {
  inner: "the line after a never-called inner function",
  afterUnrun:
    "the first line of a tested function or method right after a line no test runs",
  child: "a line only a child process runs",
};

describe(`what Bun ${WRITTEN_FOR} reports for each shape, and which the line rule catches`, () => {
  let hits: Hits = new Map();
  beforeAll(() => {
    const dir = scratch("shapes");
    write(dir, "shapes.ts", SHAPES);
    write(dir, "cli.ts", CLI);
    write(dir, "shapes.test.ts", SHAPES_TEST);
    const r = sh(dir, [
      process.execPath,
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-dir=report",
    ]);
    expect(r.status).toBe(0);
    hits = parseLcov(
      readFileSync(join(dir, "report", "lcov.info"), "utf8"),
      dir,
    );
  });
  const bunSays = (tag: string) => hits.get("shapes.ts")?.get(lineOf(tag));

  it("a never-called function: caught (Bun marks its last line run, but not the line before it)", () => {
    expect(bunSays("NEVER-CALLED")).toBeGreaterThan(0);
    expect(lineRan(hits, "shapes.ts", lineOf("NEVER-CALLED"))).toBe(false);
  });
  it("a never-taken else: caught", () => {
    expect(bunSays("NEVER-TAKEN-ELSE")).toBeGreaterThan(0);
    expect(lineRan(hits, "shapes.ts", lineOf("NEVER-TAKEN-ELSE"))).toBe(false);
  });
  it("a never-called object method: caught", () => {
    expect(bunSays("NEVER-CALLED-METHOD")).toBeGreaterThan(0);
    expect(lineRan(hits, "shapes.ts", lineOf("NEVER-CALLED-METHOD"))).toBe(
      false,
    );
  });
  // behaviour already on main: only its title now names docs/done-gate.md, where STATE.md's known holes moved
  it(`${NOT_CAUGHT.default}: NOT caught (known hole, docs/done-gate.md): Bun lists no line for \`default:\`, and the case before it ran`, () => {
    expect(lineRan(hits, "shapes.ts", lineOf("UNUSED-DEFAULT"))).toBe(true);
  });
  // behaviour already on main: only its title now names docs/done-gate.md, where STATE.md's known holes moved
  it(`${NOT_CAUGHT.arm}: NOT caught (known hole, docs/done-gate.md): Bun marks the arm run, the first arm or the last, and the line before it ran`, () => {
    for (const arm of ["FIRST-ARM", "LAST-ARM"]) {
      expect(bunSays(arm)).toBeGreaterThan(0);
      expect(lineRan(hits, "shapes.ts", lineOf(arm))).toBe(true);
    }
  });
  // behaviour already on main: only its title now names docs/done-gate.md, where STATE.md's known holes moved
  it(`${NOT_CAUGHT.oneLine}: NOT caught (known hole, docs/done-gate.md): the line ran when the file loaded`, () => {
    expect(lineRan(hits, "shapes.ts", lineOf("ONE-LINE-FUNCTION"))).toBe(true);
  });
  // behaviour already on main: only its title now names docs/done-gate.md, where STATE.md's known holes moved
  it(`${NOT_CAUGHT.shortCircuit}: NOT caught (known hole, docs/done-gate.md): Bun marks it run though an earlier operand decided the answer, and the line before it ran`, () => {
    expect(bunSays("SHORT-CIRCUIT")).toBeGreaterThan(0);
    expect(lineRan(hits, "shapes.ts", lineOf("SHORT-CIRCUIT"))).toBe(true);
    expect(lineRan(hits, "shapes.ts", lineOf("SHORT-CIRCUIT") + 1)).toBe(true);
  });
  // behaviour already on main: only its title now names docs/done-gate.md, where STATE.md's known holes moved
  it(`${NOT_CAUGHT.folded}: NOT caught alone (known hole, docs/done-gate.md): Bun lists no line there, so it reads as holding no code; the earlier lines are caught, and so is the last line of a body Bun doesn't fold`, () => {
    expect(bunSays("UNLISTED")).toBeUndefined();
    expect(lineRan(hits, "shapes.ts", lineOf("UNLISTED") - 1)).toBe(false);
    expect(bunSays("NOT-FOLDED")).toBeGreaterThan(0);
    expect(lineRan(hits, "shapes.ts", lineOf("NOT-FOLDED"))).toBe(false);
  });
  it(`${WRONGLY_REPORTED.afterUnrun} is wrongly reported as not run (Bun says it ran, but the line its report lists before it did not)`, () => {
    // A function declared without `export` after one whose last line, a throw, never ran; a method after a never-called one Bun folds.
    for (const tag of ["AFTER-UNRUN", "METHOD-AFTER-FOLDED"]) {
      expect(bunSays(tag)).toBeGreaterThan(0);
      expect(lineRan(hits, "shapes.ts", lineOf(tag))).toBe(false);
      expect(lineRan(hits, "shapes.ts", lineOf(tag) + 1)).toBe(true);
    }
  });
  it(`${WRONGLY_REPORTED.child} is wrongly reported as not run: Bun's coverage records only the test's own process`, () => {
    const line = lineOf("CHILD-ONLY", CLI);
    expect(hits.get("cli.ts")?.get(line)).toBe(0);
    expect(lineRan(hits, "cli.ts", line)).toBe(false);
  });
  // behaviour already on main: docs/done-gate.md is not product code, so tests proven's copy of main holds it; main itself has no such file and fails it
  it("docs/done-gate.md, where STATE.md's coverage row points, lists each shape the rule cannot catch as a known hole, and each it wrongly reports", () => {
    const row = readFileSync(
      join(import.meta.dir, "..", "docs", "done-gate.md"),
      "utf8",
    )
      .split("\n## ")
      .find((l) => l.startsWith("Every added line is run by a test\n"));
    for (const shape of [
      ...Object.values(NOT_CAUGHT),
      ...Object.values(WRONGLY_REPORTED),
    ])
      expect(row).toContain(shape);
  });
  it(`a line the rule wrongly reports as not run (${WRONGLY_REPORTED.inner}) is marked on its line like any other gap`, () => {
    const line = lineOf("WRONGLY-REPORTED");
    expect(bunSays("WRONGLY-REPORTED")).toBeGreaterThan(0);
    expect(lineRan(hits, "shapes.ts", line)).toBe(false);
    const file = "packages/p/src/shapes.ts";
    const remapped = new Map([[file, hits.get("shapes.ts") ?? new Map()]]);
    const at = (text: string) => [{ file, line, text }];
    expect(
      unrunLines(at("  return 2;"), remapped, { read: () => SHAPES }),
    ).toEqual([`${file}: line ${line} never ran`]);
    expect(
      unrunLines(
        at(
          "  return 2; // coverage gap: Bun's rule reads the never-called inner function above as this line",
        ),
        remapped,
        { read: () => SHAPES },
      ),
    ).toEqual([]);
  });
});

describe("parseLcov and lineRan: Bun's report, read with the line rule", () => {
  const REPORT = [
    "TN:",
    "SF:packages/a/src/x.ts",
    "DA:1,3",
    "DA:2,0",
    "DA:4,1",
    "DA:6,2",
    "end_of_record",
    "SF:/repo/packages/b/src/y.ts",
    "DA:3,1",
    "end_of_record",
  ].join("\n");
  const hits = parseLcov(REPORT, "/repo");

  it("names each file from the repository's root, whether the report writes it relative or absolute", () => {
    expect([...hits.keys()]).toEqual([
      "packages/a/src/x.ts",
      "packages/b/src/y.ts",
    ]);
    expect(hits.get("packages/a/src/x.ts")?.get(2)).toBe(0);
  });
  it("a line runs only when Bun marks it run and also the nearest earlier line the report lists", () => {
    expect(lineRan(hits, "packages/a/src/x.ts", 1)).toBe(true); // nothing listed before it
    expect(lineRan(hits, "packages/a/src/x.ts", 2)).toBe(false); // Bun says 0
    expect(lineRan(hits, "packages/a/src/x.ts", 4)).toBe(false); // the line before it the report lists, 2, did not run
    expect(lineRan(hits, "packages/a/src/x.ts", 6)).toBe(true);
    expect(lineRan(hits, "packages/a/src/x.ts", 5)).toBe(false); // not listed
    expect(lineRan(hits, "packages/c/src/z.ts", 1)).toBe(false); // file not in the report
  });
});

describe("unrunLines: which added product lines no test ran", () => {
  const hits: Hits = new Map([
    [
      "packages/p/src/a.ts",
      new Map([
        [1, 4],
        [2, 0],
        [3, 1],
        [5, 2],
      ]),
    ],
  ]);
  const add = (file: string, ...lines: [number, string][]): Added[] =>
    lines.map(([line, text]) => ({ file, line, text }));
  /** A reader whose files hold exactly the added lines given, each at its own line. */
  const filesOf = (lines: Added[]) => ({
    read: (f: string) => {
      const mine = lines.filter((l) => l.file === f);
      return Array.from(
        { length: Math.max(0, ...mine.map((l) => l.line)) },
        (_, i) => mine.find((l) => l.line === i + 1)?.text ?? "",
      ).join("\n");
    },
  });

  it("reports each added line in scope that did not run, by file and line", () => {
    const lines = add(
      "packages/p/src/a.ts",
      [1, "export function f() {"],
      [2, "  const x = 1;"],
      [3, "  return x;"],
      [4, "}"],
      [5, "f();"],
    );
    expect(unrunLines(lines, hits, filesOf(lines))).toEqual([
      "packages/p/src/a.ts: lines 2-3 never ran",
    ]);
  });
  it("a file in scope missing from the report counts as 0% covered: every added line holding code", () => {
    const lines = add(
      "services/w/src/b.tsx",
      [1, "// a comment"],
      [2, ""],
      [3, "export const b = () => <p>hi</p>;"],
      [4, "export const c = 2;"],
    );
    expect(unrunLines(lines, hits, filesOf(lines))).toEqual([
      "services/w/src/b.tsx: lines 3-4 never ran (no test loads this file, so all of it counts as not run)",
    ]);
  });
  it("a file of types alone holds no code to run, so it needs no test", () => {
    expect(
      unrunLines(
        add("packages/p/src/types.ts", [1, "export type T = { a: number };"]),
        hits,
        { read: () => "export type T = { a: number };\n" },
      ),
    ).toEqual([]);
  });
  it("judges every .ts and .tsx file under apps, services and packages, a tool's settings file too, but no test or declaration file", () => {
    const code: [number, string] = [1, "export const z = 1;"];
    const lines = [
      ...add("scripts/x.ts", code),
      ...add("packages/p/test/x.test.ts", code),
      ...add("services/w/src/index.test.ts", code),
      ...add("apps/console/e2e/x.e2e.ts", code),
      ...add("packages/p/src/x.d.ts", code),
      ...add("packages/p/src/x.js", code),
      ...add("docs/x.ts", code),
      ...add("apps/console/vite.config.ts", code),
    ];
    expect(unrunLines(lines, hits, filesOf(lines))).toEqual([
      "apps/console/vite.config.ts: line 1 never ran (no test loads this file, so all of it counts as not run)",
    ]);
  });
  it("in a file no test loads, a line holds no code only when nothing but brackets is left once its comments are gone", () => {
    const EVIL = [
      "/**",
      " * Refunds a payment.",
      " */",
      "/**/ export function refund(amount: number) {",
      "/**/   const fee = amount * 0.1; // the fee",
      "  return amount - fee;",
      "});",
      "})();",
      "/* a */ }",
      "",
    ];
    expect(
      unrunLines(
        EVIL.map((text, i) => ({
          file: "packages/p/src/evil.ts",
          line: i + 1,
          text,
        })),
        hits,
        { read: () => EVIL.join("\n") },
      ),
    ).toEqual([
      "packages/p/src/evil.ts: lines 4-6, 8 never ran (no test loads this file, so all of it counts as not run)",
    ]);
  });
  const CONSOLE = "apps/console/src/pages/Reports.tsx";
  const SMOKE = "apps/console/e2e/smoke.e2e.ts";
  it("a marked line is not a gap: a deliberate gap with its reason, or console code a named browser test drives", () => {
    const lines = [
      ...add("packages/p/src/a.ts", [
        2,
        "  const x = 1; // coverage gap: runs only on a real network failure",
      ]),
      ...add(CONSOLE, [3, `  go(); /* coverage: browser-only (${SMOKE}) */`]),
    ];
    expect(
      unrunLines(lines, hits, {
        ...filesOf(lines),
        exists: (f) => f === SMOKE,
      }),
    ).toEqual([]);
  });
  it("a mark alone on its line excuses the line below it, where Biome leaves a JSX mark; the line after that still counts", () => {
    const lines = add(
      CONSOLE,
      [4, `      {/* coverage: browser-only (${SMOKE}) */}`],
      [5, '      <a href="/reports">reports</a>'],
      [6, '      <a href="/home">home</a>'],
      [7, "  // coverage gap: runs only when the clock goes backwards"],
      [8, "  rewind();"],
    );
    expect(
      unrunLines(lines, hits, {
        ...filesOf(lines),
        exists: (f) => f === SMOKE,
      }),
    ).toEqual([
      `${CONSOLE}: line 6 never ran (no test loads this file, so all of it counts as not run)`,
    ]);
  });
  it("a mark that does not hold is a problem, and its line still counts: no reason, no such browser test, a browser test outside the console's own, or code outside the console", () => {
    const lines = [
      ...add(
        "packages/p/src/a.ts",
        [2, "  const x = 1; // coverage gap: ok"],
        [3, `  return x; // coverage: browser-only (${SMOKE})`],
      ),
      ...add(
        CONSOLE,
        [1, "go(); // coverage: browser-only (apps/console/e2e/gone.e2e.ts)"],
        [
          2,
          "go(); // coverage: browser-only (apps/console/e2e/../../www/e2e/csp.e2e.ts)",
        ],
        [3, "go(); // coverage: browser-only (apps/www/e2e/csp.e2e.ts)"],
      ),
    ];
    expect(
      unrunLines(lines, hits, { ...filesOf(lines), exists: () => true }).map(
        (p) => p.replace(/ never ran.*/, " never ran"),
      ),
    ).toEqual([
      "packages/p/src/a.ts:2 has a coverage mark without a reason: write `// coverage gap: <why>`",
      "packages/p/src/a.ts:3 is marked browser-only, but only console code (apps/console) is left to the browser checks: mark it `// coverage gap: <why>`",
      `${CONSOLE}:2 is marked browser-only, but apps/console/e2e/../../www/e2e/csp.e2e.ts is not a browser test of the console (a .e2e.ts file under apps/console/e2e) in this checkout`,
      `${CONSOLE}:3 is marked browser-only, but apps/www/e2e/csp.e2e.ts is not a browser test of the console (a .e2e.ts file under apps/console/e2e) in this checkout`,
      "packages/p/src/a.ts: lines 2-3 never ran",
      `${CONSOLE}: lines 2-3 never ran`,
    ]);
    const gone = add(CONSOLE, [
      1,
      "go(); // coverage: browser-only (apps/console/e2e/gone.e2e.ts)",
    ]);
    expect(
      unrunLines(gone, hits, { ...filesOf(gone), exists: () => false })[0],
    ).toBe(
      `${CONSOLE}:1 is marked browser-only, but apps/console/e2e/gone.e2e.ts is not a browser test of the console (a .e2e.ts file under apps/console/e2e) in this checkout`,
    );
  });
});

describe("every mark is shown to Devesh: in each stop message and CI's log (the done rules' notes) and in the PR body", () => {
  const marked: Added[] = [
    {
      file: "apps/console/src/pages/X.tsx",
      line: 12,
      text: "      {/* coverage: browser-only (apps/console/e2e/smoke.e2e.ts) */}",
    },
    {
      file: "services/worker/src/y.ts",
      line: 3,
      text: "  retry(); // coverage gap: runs only when the provider times out",
    },
    {
      file: "scripts/z.ts",
      line: 1,
      text: "// coverage gap: a script is not a product file, so this is no mark",
    },
  ];
  it("the done rules' notes list each mark on an added product line, with the line the PR body quotes it in", () => {
    expect(markNotes(marked)).toEqual([
      "coverage mark at apps/console/src/pages/X.tsx:12: browser-only (apps/console/e2e/smoke.e2e.ts) · the PR body quotes it: `Coverage mark: apps/console/src/pages/X.tsx · browser-only (apps/console/e2e/smoke.e2e.ts)`",
      "coverage mark at services/worker/src/y.ts:3: coverage gap: runs only when the provider times out · the PR body quotes it: `Coverage mark: services/worker/src/y.ts · coverage gap: runs only when the provider times out`",
    ]);
    expect(checkRules([], marked, () => []).notes).toEqual(markNotes(marked));
  });
  it("a quote counts only for the file it names, exactly, and once per mark", () => {
    const two: Added[] = [1, 2].map((line) => ({
      file: "packages/p/src/a.ts",
      line,
      text: "go(); // coverage gap: runs only by hand",
    }));
    const quote = (file: string) =>
      `Coverage mark: ${file} · coverage gap: runs only by hand`;
    expect(unquotedMarks(two, quote("packages/p/src/a.tsx"))).toHaveLength(2);
    expect(unquotedMarks(two, quote("packages/p/src/a.ts"))).toHaveLength(1);
    expect(
      unquotedMarks(
        two,
        [quote("packages/p/src/a.ts"), quote("packages/p/src/a.ts")].join("\n"),
      ),
    ).toEqual([]);
  });
  it("the PR body must quote each mark: a `Coverage mark:` line naming its file and what it says", () => {
    expect(unquotedMarks(marked, "Roadmap: off-roadmap — x\n")).toEqual([
      "the PR body does not show the coverage mark at apps/console/src/pages/X.tsx:12: add the line `Coverage mark: apps/console/src/pages/X.tsx · browser-only (apps/console/e2e/smoke.e2e.ts)`",
      "the PR body does not show the coverage mark at services/worker/src/y.ts:3: add the line `Coverage mark: services/worker/src/y.ts · coverage gap: runs only when the provider times out`",
    ]);
    expect(
      unquotedMarks(
        marked,
        [
          "Roadmap: off-roadmap — x",
          "Coverage mark: apps/console/src/pages/X.tsx · browser-only (apps/console/e2e/smoke.e2e.ts)",
          "- Coverage mark: services/worker/src/y.ts · coverage gap: runs only when the provider times out",
        ].join("\n"),
      ),
    ).toEqual([]);
    // A quote GitHub doesn't show (an HTML comment) is no quote.
    expect(
      unquotedMarks(
        marked.slice(1),
        "<!-- Coverage mark: services/worker/src/y.ts · coverage gap: runs only when the provider times out -->",
      ),
    ).toHaveLength(1);
  });
});

describe("a new migration counts as covered only when the same change adds or edits a database test that uses what it adds", () => {
  const M = "supabase/migrations";
  const lines = (file: string, text: string): Added[] =>
    text.split("\n").map((t, i) => ({ file, line: i + 1, text: t }));
  const DENIAL = `import { withOrg } from "@revenue-os/db";
const rows = await withOrg(app, orgB, (tx) => tx.query("select id from notes where org_id = $1", [orgA]));
expect(rows).toHaveLength(0);`;
  const BEHAVIOUR = `import { Pool } from "pg";
const admin = new Pool({ connectionString: LOCAL_DB_URL });
const r = await admin.query("select app.due_org_ids()");
expect(r.rows).toHaveLength(1);`;
  /** A change that adds each file whole: its added lines, and a reader of the files as it leaves them. */
  const change = (files: Record<string, string>) => ({
    added: Object.entries(files).flatMap(([f, text]) => lines(f, text)),
    read: (f: string) => files[f] ?? "",
  });
  const judge = (files: Record<string, string>) => {
    const c = change(files);
    return untestedMigrations(c.added, c.read);
  };
  const NOTES = {
    [`${M}/018_notes.sql`]:
      "-- notes\ncreate table if not exists public.notes (id uuid, org_id uuid not null);\nalter table notes enable row level security;",
  };

  it("a new table needs a cross-company denial test, in the same change, that names it", () => {
    expect(judge(NOTES)).toEqual([
      `${M}/018_notes.sql creates the table notes, but no database test this change adds or edits names it in a cross-company denial test (another company's read or write refused)`,
    ]);
    expect(
      judge({ ...NOTES, "packages/db/test/notes.test.ts": DENIAL }),
    ).toEqual([]);
    // Named only in a test that never reaches the database, or in a database test that refuses nothing: not covered.
    expect(
      judge({
        ...NOTES,
        "packages/p/test/plain.test.ts": `expect("notes").toBe("notes");`,
        "services/worker/test/due.test.ts": `${BEHAVIOUR}\nawait admin.query("select * from notes");`,
      }),
    ).toHaveLength(1);
  });
  it("a name in a comment is no use of it: a denial test file that only mentions the table in a comment covers nothing", () => {
    const DENIES_OTHERS = DENIAL.replaceAll("notes", "contacts");
    expect(
      judge({
        ...NOTES,
        "packages/db/test/rls.test.ts": `${DENIES_OTHERS}\n// TODO notes\n/*\nnotes\n*/`,
      }),
    ).toHaveLength(1);
    expect(
      judge({
        [`${M}/021_off.sql`]:
          "alter table contacts disable row level security;",
        "packages/db/test/rls.test.ts": `${DENIAL}\nconst x = 1; /* contacts */`,
      }),
    ).toEqual([
      `${M}/021_off.sql adds or changes contacts, but no database test this change adds or edits names them`,
    ]);
    // And a file whose only database words sit in comments is no database test.
    expect(
      judge({
        ...NOTES,
        "packages/db/test/rls.test.ts": `// withOrg( … ).rejects\nexpect(1).toHaveLength(0); // notes`,
      }),
    ).toHaveLength(1);
  });
  it("anything else it adds (a function, a column, a view, a type, a change to a table) needs a database test that names it", () => {
    const FN = {
      [`${M}/019_due.sql`]:
        "create or replace function app.due_org_ids() returns setof uuid\nlanguage sql as $$ select 1 $$;\nalter table contacts add column if not exists nickname text;",
    };
    expect(judge(FN)).toEqual([
      `${M}/019_due.sql adds or changes due_org_ids, nickname, but no database test this change adds or edits names them`,
    ]);
    expect(
      judge({
        ...FN,
        "services/worker/test/due.test.ts": `${BEHAVIOUR}\nconst s = await admin.query("select app.due_org_ids(), nickname from contacts");`,
      }),
    ).toEqual([]);
    expect(
      judge({
        [`${M}/020_cascade.sql`]:
          "alter table webhook_events drop constraint webhook_events_org_id_fkey;",
      }),
    ).toEqual([
      `${M}/020_cascade.sql adds or changes webhook_events, but no database test this change adds or edits names them`,
    ]);
  });
  it("a change with no new migration asks for nothing", () => {
    expect(judge({ "packages/p/src/a.ts": "x" })).toEqual([]);
  });
});

describe("bun run gate tests: the gate's own test run reads its coverage and refuses an added line no test runs", () => {
  const GATE = join(import.meta.dir, "done-gate.ts");
  /** A scratch repo whose main holds a copy of the gate, a product file and its test, and `main`; origin/main is main. */
  const project = (main: Record<string, string> = {}) => {
    const dir = scratch("gate");
    for (const [file, body] of Object.entries(main)) write(dir, file, body);
    mkdirSync(join(dir, "scripts"));
    copyFileSync(GATE, join(dir, "scripts", "done-gate.ts"));
    cpSync(
      join(import.meta.dir, "done-gate"),
      join(dir, "scripts", "done-gate"),
      { recursive: true },
    );
    mkdirSync(join(dir, "docs", "tracker"), { recursive: true }); // the gate reads ROADMAP.md with the tracker's parser
    copyFileSync(
      join(import.meta.dir, "..", "docs", "tracker", "parse.js"),
      join(dir, "docs", "tracker", "parse.js"),
    );
    write(dir, "packages/p/src/a.ts", "export const one = () => 1;\n");
    write(
      dir,
      "packages/p/test/a.test.ts",
      'import { expect, it } from "bun:test";\nimport { one } from "../src/a";\nit("one", () => expect(one()).toBe(1));\n',
    );
    const GIT = ["git", "-c", "user.email=t@t", "-c", "user.name=t"];
    sh(dir, ["git", "init", "-q", "-b", "main"]);
    sh(dir, ["git", "add", "-A"]);
    sh(dir, [...GIT, "commit", "-qm", "x"]);
    sh(dir, ["git", "update-ref", "refs/remotes/origin/main", "HEAD"]);
    sh(dir, ["git", "checkout", "-qb", "feat"]);
    return dir;
  };
  const gateTests = (dir: string) => {
    const r = sh(dir, [process.execPath, "scripts/done-gate.ts", "tests"]);
    return { status: r.status, out: r.stdout + r.stderr };
  };

  // behaviour already on main: only a comment in it now names docs/done-gate.md, where STATE.md's known holes moved
  it("fails naming a line a test never runs and a file no test loads, then passes once a test runs them", () => {
    const dir = project();
    write(
      dir,
      "packages/p/src/a.ts",
      "export const one = () => 1;\nexport function two() {\n  const n = 2;\n  return n;\n}\n",
    );
    write(dir, "packages/p/src/b.ts", "export const three = 3;\n");
    const failed = gateTests(dir);
    expect(failed.status).toBe(1);
    expect(failed.out).toContain(
      "✗ Some lines this change adds are run by no test:",
    );
    // Bun lists no line for `return n;`: it folds the never-called body to a constant (a known hole, docs/done-gate.md).
    expect(failed.out).toContain("- packages/p/src/a.ts: lines 2-3 never ran");
    expect(failed.out).toContain(
      "- packages/p/src/b.ts: line 1 never ran (no test loads this file, so all of it counts as not run)",
    );
    write(
      dir,
      "packages/p/test/b.test.ts",
      'import { expect, it } from "bun:test";\nimport { two } from "../src/a";\nimport { three } from "../src/b";\nit("two, three", () => expect(two() + three).toBe(5));\n',
    );
    const passed = gateTests(dir);
    expect(passed.out).not.toContain("run by no test");
    expect(passed.status).toBe(0);
  });

  it("a marked line passes the tests, and bun run gate pr (main's copy, in CI) shows the mark and refuses a body that does not quote it", () => {
    const dir = project();
    const MARK = "coverage gap: it prints only when someone runs it by hand";
    write(
      dir,
      "packages/p/src/a.ts",
      `export const one = () => 1;\nif (process.env.BY_HAND) console.log("by hand"); // ${MARK}\n`,
    );
    expect(gateTests(dir).status).toBe(0);
    const judged = (body: string) => {
      const r = sh(
        dir,
        [process.execPath, "scripts/done-gate.ts", "pr", "--base", "main"],
        { PR_BODY: body },
      );
      return { status: r.status, out: r.stdout + r.stderr };
    };
    const FIRST = "Roadmap: off-roadmap — a marked line\n";
    const bare = judged(FIRST);
    expect(bare.out).toContain(
      `- the PR body does not show the coverage mark at packages/p/src/a.ts:2: add the line \`Coverage mark: packages/p/src/a.ts · ${MARK}\``,
    );
    expect(bare.status).toBe(1);
    const quoted = judged(
      `${FIRST}Coverage mark: packages/p/src/a.ts · ${MARK}\n`,
    );
    expect(quoted.out).toContain(
      `⚠ coverage mark at packages/p/src/a.ts:2: ${MARK}`,
    );
    expect(quoted.status).toBe(0);
  });

  it("moved lines, found by git's moved-code detection as the done-rules item names it, need no test: a file split in two passes, a moved line edited on the way does not", () => {
    const TOTAL =
      "export function legacyTotal(prices: number[]) {\n  const total = prices.reduce((sum, price) => sum + price, 0);\n  return Math.round(total * 100) / 100;\n}\n";
    const LABEL =
      'export function legacyLabel(name: string) {\n  const trimmed = name.trim();\n  return trimmed.length > 0 ? trimmed : "unnamed";\n}\n';
    // Main holds both in one file no test loads; the change splits it in two.
    const dir = project({ "packages/p/src/old.ts": `${TOTAL}\n${LABEL}` });
    rmSync(join(dir, "packages/p/src/old.ts"));
    write(dir, "packages/p/src/total.ts", TOTAL);
    write(dir, "packages/p/src/label.ts", LABEL);
    const split = gateTests(dir);
    expect(split.out).not.toContain("run by no test");
    expect(split.status).toBe(0);
    write(dir, "packages/p/src/label.ts", LABEL.replace("unnamed", "nameless"));
    const edited = gateTests(dir);
    expect(edited.out).toContain(
      "- packages/p/src/label.ts: line 3 never ran (no test loads this file, so all of it counts as not run)",
    );
    expect(edited.out).not.toContain("total.ts");
    expect(edited.status).toBe(1);
  });

  it("a line whose code stays as it was, only its comment edited (as docs/fix-when-touched.md asks), needs no new test; an edit to its code does", () => {
    const TZ =
      "export function zone(tz: string | undefined) {\n  if (!tz) {\n    return null; // unknown tz mode (T26.3) → fail open\n  }\n  return tz;\n}\n";
    const dir = project({
      "packages/p/src/tz.ts": TZ,
      "packages/p/test/tz.test.ts":
        'import { expect, it } from "bun:test";\nimport { zone } from "../src/tz";\nit("utc", () => expect(zone("utc")).toBe("utc"));\n',
    });
    write(
      dir,
      "packages/p/src/tz.ts",
      TZ.replace("(T26.3)", "(docs/NORTH-STAR.md)"),
    );
    const comment = gateTests(dir);
    expect(comment.out).not.toContain("run by no test");
    expect(comment.status).toBe(0);
    write(
      dir,
      "packages/p/src/tz.ts",
      TZ.replace("return null; // unknown", "return undefined; // unknown"),
    );
    const code = gateTests(dir);
    expect(code.out).toContain("- packages/p/src/tz.ts: line 3 never ran");
    expect(code.status).toBe(1);
  });

  it("console JSX marked browser-only on the line above it, the form Biome keeps, passes", () => {
    const SMOKE = "apps/console/e2e/smoke.e2e.ts";
    const NAV = (links: string) =>
      `export function Nav() {\n  return (\n    <nav>\n      <a href="/home">home</a>\n${links}    </nav>\n  );\n}\n`;
    const dir = project({
      [SMOKE]: "// drives the console in a browser\n",
      "apps/console/src/Nav.tsx": NAV(""),
    });
    const marked = NAV(
      `      {/* coverage: browser-only (${SMOKE}) */}\n      <a href="/reports">reports</a>\n`,
    );
    const repo = join(import.meta.dir, "..");
    const biome = spawnSync(
      join(repo, "node_modules", ".bin", "biome"),
      ["format", "--stdin-file-path=apps/console/src/Nav.tsx"],
      { cwd: repo, input: marked, encoding: "utf8" }, // the repository's formatter settings, as `bun run lint` uses
    );
    expect(biome.stdout).toBe(marked);
    write(dir, "apps/console/src/Nav.tsx", marked);
    const r = gateTests(dir);
    expect(r.out).not.toContain("run by no test");
    expect(r.status).toBe(0);
  });

  it("a file no test loads fails however its lines start: a block comment before each line hides none of them", () => {
    const dir = project();
    write(
      dir,
      "packages/p/src/evil.ts",
      '/**/ export function refund(amount: number) {\n/**/   const fee = amount * 0.1;\n/**/   if (fee > 5) throw new Error("too much");\n/**/   return amount - fee;\n/**/ }\n',
    );
    const r = gateTests(dir);
    expect(r.out).toContain(
      "- packages/p/src/evil.ts: lines 1-4 never ran (no test loads this file, so all of it counts as not run)",
    );
    expect(r.status).toBe(1);
  });

  it("a new migration with no database test in the same change fails the tests check", () => {
    const dir = project();
    write(
      dir,
      "supabase/migrations/002_payouts.sql",
      "create table public.payouts (id uuid primary key, org_id uuid not null, amount numeric);\n",
    );
    const r = gateTests(dir);
    expect(r.out).toContain(
      "- supabase/migrations/002_payouts.sql creates the table payouts, but no database test this change adds or edits names it in a cross-company denial test",
    );
    expect(r.status).toBe(1);
  });
});
