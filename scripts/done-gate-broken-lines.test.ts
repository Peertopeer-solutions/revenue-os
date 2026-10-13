// For guardrail, tenancy and money code, the gate breaks each new line on purpose and a test must then fail
// (scripts/done-gate/broken-lines.ts says which files and how a line is broken, break-check.ts runs it). The pure
// part is checked on text; the whole run on throwaway git repos holding a tiny product, with real git and real bun
// test runs.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { breakCheck } from "./done-gate/break-check";
import { breaksOf, codeMask, kindOf } from "./done-gate/broken-lines";
import { CHECKS } from "./done-gate/checks";
import { judgePr } from "./done-gate/pr";
import { rulesOn } from "./done-gate/rules";
import { snapshot } from "./done-gate/snapshot";

// Each repo test starts git and bun several times; with other agents busy on the machine that passes bun's 5 s.
setDefaultTimeout(90_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The broken copies of `line` in `src`, each as what was done and the line or statement shown. */
const broken = (src: string, line: number) =>
  breaksOf(src, line).map((b) => `${b.how}: ${b.shown}`);

describe("kindOf: which files are guardrail, tenancy or money code", () => {
  // behaviour already on main: the gate's files are the same in both copies, which differ only in product code
  it("names each kind by path, and leaves out tests, type declarations and other files", () => {
    expect(kindOf("packages/harness/src/policies.ts")).toBe("guardrail");
    expect(kindOf("packages/channels/src/whatsapp.ts")).toBe("guardrail");
    expect(kindOf("services/worker/src/routes/guardrail-policies.ts")).toBe(
      "guardrail",
    );
    expect(kindOf("packages/db/src/guardrails.ts")).toBe("guardrail");
    expect(kindOf("packages/db/src/client.ts")).toBe("tenancy");
    expect(kindOf("services/worker/src/routes/contacts.ts")).toBe("tenancy");
    expect(kindOf("services/worker/src/auth.ts")).toBe("tenancy");
    expect(kindOf("services/worker/src/app.ts")).toBe("tenancy");
    expect(kindOf("packages/harness/src/meter.ts")).toBe("money");
    expect(kindOf("packages/db/test/rls.test.ts")).toBeUndefined();
    expect(kindOf("packages/db/src/types.d.ts")).toBeUndefined();
    expect(kindOf("packages/db/src/notes.md")).toBeUndefined();
    expect(kindOf("services/worker/src/scheduler.ts")).toBeUndefined();
    expect(kindOf("packages/db/src/schema.ts")).toBe("tenancy"); // no file under packages/db/src is left out
    expect(kindOf("apps/console/src/main.tsx")).toBeUndefined();
  });
});

describe("codeMask: code kept, everything else blanked", () => {
  it("blanks comments and the inside of strings, template text and regexes, keeping offsets and template holes", () => {
    const src = [
      'const a = "x === y"; // a && b',
      `const t = \`if (${"$"}{a === 1}) true\`;`,
      "/* x > 1 */ const r = /a||b/g.test(s) && 4 / 2 > 1;",
    ].join("\n");
    const mask = codeMask(src);
    expect(mask.length).toBe(src.length);
    expect(mask.split("\n")).toEqual([
      'const a = "       ";          ',
      "const t = `    $(a === 1)      `;",
      "            const r = /    /g.test(s) && 4 / 2 > 1;",
    ]);
  });
});

describe("breaksOf: up to two broken copies of a line", () => {
  const fn = (body: string) =>
    `export function f(a: number, b: number) {\n${body}\n  return 0;\n}\n`;

  it("flips each kind of condition", () => {
    for (const [from, to] of [
      ["a === b", "a !== b"],
      ["a !== b", "a === b"],
      ["a == b", "a != b"],
      ["a != b", "a == b"],
      ["a < b", "a >= b"],
      ["a >= b", "a < b"],
      ["a > b", "a <= b"],
      ["a <= b", "a > b"],
      ["a && b", "a || b"],
      ["a || b", "a && b"],
      ["!a", "a"],
    ])
      expect(broken(fn(`  if (${from}) return 1;`), 2)[0]).toBe(
        `flip: if (${to}) return 1;`,
      );
    expect(broken(fn("  const ok = true;\n  if (ok) return 1;"), 2)[0]).toBe(
      "flip: const ok = false;",
    );
  });

  it("negates a bare if or while condition, and a ternary's", () => {
    expect(broken(fn("  if (a) return 1;"), 2)[0]).toBe(
      "flip: if (!(a)) return 1;",
    );
    expect(broken(fn("  while (a) a--;"), 2)[0]).toBe(
      "flip: while (!(a)) a--;",
    );
    expect(broken(fn("  const c = a ? 1 : 2;\n  return c;"), 2)[0]).toBe(
      "flip: const c = !(a) ? 1 : 2;",
    );
  });

  it("removes the statement the line starts: a call, a return, a throw, an if with its block, a declaration", () => {
    const src = [
      "export function f(a: number, log: (s: string) => void) {", // 1
      '  log("start");', // 2
      "  if (a > 1) {", // 3
      '    throw new Error("big");', // 4
      "  }", // 5
      "  const b = a +", // 6
      "    1;", // 7
      "  return b;", // 8
      "}", // 9
    ].join("\n");
    expect(broken(src, 2)).toEqual(['remove: log("start");']);
    expect(broken(src, 3)).toEqual([
      "flip: if (a <= 1) {",
      "remove: if (a > 1) {",
    ]);
    expect(breaksOf(src, 3)[1]?.text).toBe(
      src.replace('  if (a > 1) {\n    throw new Error("big");\n  }', "  \n\n"),
    );
    expect(broken(src, 4)).toEqual(['remove: throw new Error("big");']);
    expect(broken(src, 6)).toEqual(["remove: const b = a +"]);
    expect(broken(src, 8)).toEqual(["remove: return b;"]);
    expect(broken(src, 5)).toEqual([]); // a closing brace: nothing to break
    expect(broken(src, 7)).toEqual([]); // the middle of a statement, nothing to flip
  });

  it("removes a line holding whole list items: an argument or a property", () => {
    const src = [
      "export const q = (db: { query: (s: string, v: unknown[]) => void }, org: string, id: string) =>", // 1
      "  db.query(", // 2
      '    "select 1 where org_id = $1 and id = $2",', // 3
      "    [org, id],", // 4
      "  );", // 5
      "export const row = (org: string) => ({", // 6
      "  org_id: org,", // 7
      "  open: true,", // 8
      "});", // 9
    ].join("\n");
    expect(broken(src, 4)).toEqual(["remove: [org, id],"]);
    expect(broken(src, 7)).toEqual(["remove: org_id: org,"]);
    expect(broken(src, 8)).toEqual([
      "flip: open: false,",
      "remove: open: true,",
    ]);
  });

  it("never touches a string, a template's text, a regex or a comment on the line", () => {
    const src = fn(
      '  const s = "a === b && c"; // if (a < b) return a || b;\n  const t = `x > ' +
        "$" +
        "{a} && y`;\n  const r = /a||b/;",
    );
    expect(broken(src, 2)).toEqual(['remove: const s = "a === b && c";']);
    expect(broken(src, 3)).toEqual([
      `remove: const t = \`x > ${"$"}{a} && y\`;`,
    ]);
    expect(broken(src, 4)).toEqual(["remove: const r = /a||b/;"]);
  });

  it("drops a copy that would not parse, and one that changes only types", () => {
    const src = [
      "export type Big = Array<number>;", // 1: a type: nothing that runs changes
      "import type { X } from './x';", // 2
      "export const f = (a: Array<number>): a is never => a.length > 1;", // 3
    ].join("\n");
    expect(broken(src, 1)).toEqual([]);
    expect(broken(src, 2)).toEqual([]);
    expect(
      broken('import { y } from "./y";\nexport const f = () => y;\n', 1),
    ).toEqual(['remove: import { y } from "./y";']);
    // `Array<number>` flipped would not parse, so the comparison is the one flipped
    expect(broken(src, 3)).toEqual([
      "flip: export const f = (a: Array<number>): a is never => a.length <= 1;",
      "remove: export const f = (a: Array<number>): a is never => a.length > 1;",
    ]);
  });

  it("leaves arrows, shifts and a non-null assertion alone", () => {
    const src = fn("  const g = (x: number) => x >> 1;\n  return g(a!)");
    expect(broken(src, 2)).toEqual([
      "remove: const g = (x: number) => x >> 1;",
    ]);
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

const METER = "packages/harness/src/meter.ts"; // money code
const COST = "export function cost(n: number) {\n  return n;\n}\n";
// The change: line 2 is new.
const GUARDED_COST =
  "export function cost(n: number) {\n  if (n < 0) return 0;\n  return n;\n}\n";
const testOf = (body: string) => `import { expect, it } from "bun:test";
import { cost } from "../src/meter";

it("costs", () => {
${body}
});
`;
const CATCHES = testOf(
  "  expect(cost(-1)).toBe(0);\n  expect(cost(2)).toBe(2);",
);
const WEAK = testOf("  expect(cost(2)).toBeGreaterThan(-100);");

/** A throwaway repo: main holds METER (cost, unguarded) and `onMain`; origin/main points at it; `change` is written in. */
function scratch(
  change: Record<string, string>,
  onMain: Record<string, string> = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "break-check-")));
  dirs.push(dir);
  put(dir, {
    "package.json": '{ "name": "scratch", "private": true }\n',
    [METER]: COST,
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
const check = (dir: string, budgetMs?: number) =>
  breakCheck(dir, snapshot(dir), budgetMs);

describe("breakCheck on a throwaway repo", () => {
  it("passes a new money line whose every break a real test catches", () => {
    const r = check(
      scratch({
        [METER]: GUARDED_COST,
        "packages/harness/test/meter.test.ts": CATCHES,
      }),
    );
    expect(r.text).toStartWith(
      "Break check ✓ 1 line(s) broken in guardrail, tenancy and money code, each caught (2 break(s),",
    );
    expect(r.ok).toBe(true);
  });

  it("fails a new line whose breaks only a test asserting nothing about it runs, naming the line, the break and the files that ran; a test under scripts/ is never asked", () => {
    const r = check(
      scratch({
        [METER]: GUARDED_COST,
        "packages/harness/test/meter.test.ts": WEAK,
        "scripts/meter-guard.test.ts": CATCHES.replace(
          "../src/meter",
          "../packages/harness/src/meter",
        ),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      "- packages/harness/src/meter.ts:2 (money) with a condition flipped, `if (n >= 0) return 0;`, and every test that runs it still passed: packages/harness/test/meter.test.ts",
    );
    expect(r.text).toContain(
      "- packages/harness/src/meter.ts:2 (money) with its statement removed, `if (n < 0) return 0;`, and every test that runs it still passed: packages/harness/test/meter.test.ts",
    );
  });

  it("passes a marked line and shows the mark; a mark without a reason does not hold", () => {
    const marked = (mark: string) =>
      scratch({
        [METER]: GUARDED_COST.replace(
          "  if (n < 0)",
          `  // break-check gap: ${mark}\n  if (n < 0)`,
        ),
        "packages/harness/test/meter.test.ts": WEAK,
      });
    const ok = check(marked("refunds are checked by the billing report"));
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain(
      "⚠ break-check mark at packages/harness/src/meter.ts:3: refunds are checked by the billing report",
    );
    const bare = check(marked(""));
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain(
      "packages/harness/src/meter.ts:3 has a break-check mark without a reason",
    );
  });

  it("never breaks a line outside guardrail, tenancy and money code", () => {
    const r = check(
      scratch(
        {
          "services/worker/src/scheduler.ts": GUARDED_COST,
          "services/worker/test/scheduler.test.ts": WEAK.replace(
            "../src/meter",
            "../src/scheduler",
          ),
        },
        { "services/worker/src/scheduler.ts": COST },
      ),
    );
    expect(r).toEqual({
      ok: true,
      text: "Break check ✓ no new line in guardrail, tenancy or money code, so nothing to break",
    });
  });

  // The whole suite runs after the break check, and in CI in a job of its own, so a file that passes only beside
  // another test's leftovers must not leave its lines unbroken.
  it("fails when a test file that runs the line fails alone on the change, naming the file", () => {
    const r = check(
      scratch({
        [METER]: GUARDED_COST,
        "packages/harness/test/meter.test.ts": `${CATCHES}\nit("finds what another test left", () => expect(Reflect.get(globalThis, "leftover")).toBe(1));\n`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      "- packages/harness/test/meter.test.ts fails when run alone on the change, so it can't show whether a broken line is caught",
    );
  });

  it("leaves a line no test runs to the coverage check, saying so", () => {
    const r = check(scratch({ [METER]: GUARDED_COST }));
    expect(r.ok).toBe(true);
    expect(r.text).toContain(
      "⚠ packages/harness/src/meter.ts:2 is run by no test, so it wasn't broken (the coverage check reports a line no test runs)",
    );
  });

  it("stops at its time limit and fails, naming each line not yet broken", () => {
    const r = check(
      scratch({
        [METER]: GUARDED_COST,
        "packages/harness/test/meter.test.ts": CATCHES,
      }),
      0,
    );
    expect(r.ok).toBe(false);
    expect(r.text).toContain(
      "the break check's time limit of 0 min ran out after 0 break(s): not yet broken: packages/harness/src/meter.ts:2",
    );
  });

  it("runs as `bun run gate broken`, failing with the reason", () => {
    const dir = scratch({
      [METER]: GUARDED_COST,
      "packages/harness/test/meter.test.ts": WEAK,
    });
    for (const f of [
      "scripts/done-gate.ts",
      "scripts/done-gate",
      "docs/tracker/parse.js",
    ])
      cpSync(join(import.meta.dir, "..", f), join(dir, f), { recursive: true });
    const r = sh(dir, [process.execPath, "scripts/done-gate.ts", "broken"]);
    expect(r.stdout).toContain(
      "packages/harness/src/meter.ts:2 (money) with a condition flipped",
    );
    expect(r.status).toBe(1);
  });

  it("shows each mark at every stop and asks the PR body to quote it", async () => {
    const dir = scratch({
      [METER]: GUARDED_COST.replace(
        "  if (n < 0) return 0;",
        "  if (n < 0) return 0; // break-check gap: refunds are checked elsewhere",
      ),
    });
    const quote =
      "Break-check mark: packages/harness/src/meter.ts · refunds are checked elsewhere";
    expect(rulesOn(snapshot(dir)).notes).toContain(
      `break-check mark at packages/harness/src/meter.ts:2: refunds are checked elsewhere · the PR body quotes it: \`${quote}\``,
    );
    const pr = (body: string) => judgePr(snapshot(dir), body);
    expect((await pr("Roadmap: off-roadmap — x")).problems).toContain(
      `the PR body does not show the break-check mark at packages/harness/src/meter.ts:2: add the line \`${quote}\``,
    );
    expect(
      (await pr(`Roadmap: off-roadmap — x\n\n${quote}\n`)).problems.join("\n"),
    ).not.toContain("break-check mark");
  });
});

describe("where the break check runs", () => {
  it("is one of the gate's checks on the shared database, right after tests proven, and names its summary", () => {
    const at = CHECKS.findIndex((c) => c.name === "break check");
    expect(CHECKS[at - 1]?.name).toBe("tests proven");
    const c = CHECKS[at];
    expect(c?.cmd).toEqual([
      "bun",
      "run",
      "local",
      "bun",
      "run",
      "gate",
      "broken",
    ]);
    expect(c?.db).toBe(true);
    expect(
      c?.said?.(
        "Break check ✓ 3 line(s) broken in guardrail, tenancy and money code, each caught (6 break(s), 9 test file run(s), 41.0 s)\n⚠ note",
      ),
    ).toBe(
      "3 line(s) broken in guardrail, tenancy and money code, each caught",
    );
    expect(
      c?.said?.(
        "Break check ✓ no new line in guardrail, tenancy or money code, so nothing to break",
      ),
    ).toBe("break check"); // nothing broken: the gate's line just names the check
  });

  it("runs in CI's checks job right after tests proven, against the pull request's base", () => {
    const ci = Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
        "utf8",
      ),
    ) as {
      jobs: { checks: { steps: { run?: string; env?: { BASE?: string } }[] } };
    };
    const steps = ci.jobs.checks.steps;
    const proven = steps.findIndex((s) => s.run?.includes("gate proven"));
    expect(steps[proven + 1]).toMatchObject({
      run: 'bun run gate broken --base "$BASE"',
      env: { BASE: `origin/\${{ github.base_ref || 'main' }}` },
    });
  });
});
