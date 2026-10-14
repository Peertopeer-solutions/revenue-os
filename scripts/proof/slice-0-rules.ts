// Slice 0's proof: what main's copy of the rules refuses. Each case is a scratch branch in a clone of the proved
// commit, judged from main's checkout as data, as rules-from-main judges a pull request (`bun scripts/done-gate.ts pr
// --base main --head <branch>`, with a sample body and 9999 as its number) or as CI's done rules do (`… rules`). No
// pull request is opened: one opened from a GitHub workflow starts no other workflows. Where a refusal could be for
// another reason, the same change, put right, must pass. The two cases of a branch that rewrites what judges it (its
// own gate, ci.yml) also run main's rules-from-main workflow as GitHub runs it (rules-from-main.ts): a branch can't
// escape main's copy only because GitHub runs main's copy of that file.

import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { areasOf, TABLE } from "../done-gate/fix-when-touched";
import { RECORDS } from "../done-gate/rule-changes";
import { judged, PR, rules } from "./gate";
import { byWorkflow } from "./rules-from-main";
import { commit, git, inScratch, sh, write } from "./scratch";
import type { Step } from "./step";

const FIRST =
  "Roadmap: off-roadmap — a sample pull request the Slice 0 proof judges and throws away";
const WHY = "a sample change the proof makes and throws away";
// Product code that switches the type checker off: a problem whichever copy of the rules finds it.
const SAMPLE = "services/worker/src/proof-sample.ts";
const UNCHECKED = '// @ts-ignore\nconst sample: number = "one";\n'; // done-gate: allow the sample written into a scratch branch, for main's copy of the rules to refuse

/** On a new branch `name` cut from main: `change`, committed; then back to main. */
function branch(dir: string, name: string, change: () => void) {
  git(dir, "checkout", "-q", "-B", name, "main");
  change();
  commit(dir, `a sample: ${name}`);
  git(dir, "checkout", "-q", "main");
}

/** A sample body: its first line, a `Rule change:` line per rule, and an answer to each entry of main's table. */
function body(
  dir: string,
  o: { rules?: string[]; answered?: boolean; first?: string } = {},
) {
  const entries =
    o.answered === false
      ? []
      : areasOf(git(dir, "show", `main:${TABLE}`)).map((e) => e.n);
  return [
    o.first ?? FIRST,
    "",
    ...(o.rules ?? []).map((r) => `Rule change: ${r} · looser · ${WHY}`),
    ...entries.map((n) => `Fix-when-touched: ${n} · not applicable · ${WHY}`),
    "",
  ].join("\n");
}

/** Adds this pull request's record for `rule`, a file of its own in docs/rule-changes/. */
function record(dir: string, rule: string) {
  const day = new Date().toISOString().slice(0, 10);
  write(
    dir,
    `${RECORDS}${day}-pr-${PR}-sample.md`,
    `- ${day} · [#${PR}](https://github.com/devesh911/revenue-os/pull/${PR}) · ${rule} · looser\n`,
  );
}

type Run = { status: number; out: string };
const lead = (r: Run) => r.out.trim().split("\n").slice(0, 3).join(" / ");

/**
 * The problem `who` named holding every one of `needles` (else its first), when it refused with each of them in
 * what it said; else why not.
 */
function refused(who: string, r: Run, ...needles: string[]) {
  const missing = needles.filter((n) => !r.out.includes(n));
  const named = r.out.split("\n").filter((l) => l.startsWith("- "));
  if (r.status === 1 && !missing.length)
    return (
      (
        named.find((l) => needles.every((n) => l.includes(n))) ?? named[0]
      )?.slice(2) ?? lead(r)
    );
  throw new Error(
    r.status === 0
      ? `${who} passed it: ${lead(r)}`
      : `${who} exited ${r.status} without naming ${missing.join(" and ")}: ${lead(r)}`,
  );
}

const MAIN = "main's copy of the rules";
function passes(r: Run, what: string) {
  if (r.status !== 0)
    throw new Error(
      `${MAIN} also refused ${what}, so the refusal may not be for its reason: ${lead(r)}`,
    );
}

export const unexplainedRuleChange: Step = {
  does: "Judges with main's copy of `rules-from-main` (`--head <scratch branch>` and a sample PR body) a rule-file change to AGENTS.md whose body doesn't explain it or that adds no record to docs/rule-changes/, and checks that each is refused and the same change, explained and recorded, passes",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      const change = () =>
        appendFileSync(join(dir, "AGENTS.md"), `\nA sample rule: ${WHY}.\n`);
      branch(dir, "recorded", () => {
        change();
        record(dir, "AGENTS.md");
      });
      branch(dir, "unrecorded", change);
      const said = { rules: ["AGENTS.md"] };
      const a = refused(MAIN, judged(dir, body(dir), "recorded"), "AGENTS.md");
      const b = refused(
        MAIN,
        judged(dir, body(dir, said), "unrecorded"),
        "AGENTS.md",
        "docs/rule-changes/",
      );
      passes(
        judged(dir, body(dir, said), "recorded"),
        "the change explained and recorded",
      );
      return `refused the unexplained one (${a}) and the unrecorded one (${b}); passed it explained and recorded`;
    }),
};

const GATE = "scripts/done-gate.ts";
const CI = ".github/workflows/ci.yml";
const CHECKS_NOTHING =
  "name: ci\non: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  checks:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo nothing is checked\n";
const RUN_AS_GITHUB =
  "main's `rules-from-main` workflow, run as GitHub runs it (main's copy of the file, as `pull_request_target` runs it; its checkout of main and its steps, with the pull request fetched as data)";

export const loosenedGate: Step = {
  does: `Judges with ${RUN_AS_GITHUB} a branch that loosens its own copy of the gate (its scripts/done-gate.ts passes anything) and adds product code that switches the type checker off (${SAMPLE}), explained and recorded, and checks that it refuses the branch while the branch's own copy passes it; and that main's copy refuses the loosened gate alone when the body doesn't explain it`,
  check: ({ root }) =>
    inScratch(root, ({ dir, base }) => {
      const loosen = () =>
        write(dir, GATE, "process.exit(0); // passes anything\n");
      branch(dir, "loosened", () => {
        loosen();
        write(dir, SAMPLE, UNCHECKED);
        record(dir, GATE);
      });
      branch(dir, "loosened-unexplained", loosen);
      git(dir, "checkout", "-q", "loosened");
      const own = sh(dir, ["bun", GATE, "rules", "--base", "main"]);
      git(dir, "checkout", "-q", "main");
      if (own.status !== 0)
        throw new Error(
          `the branch's own copy refused it too, so this shows nothing: ${lead(own)}`,
        );
      const why = refused(
        MAIN,
        byWorkflow(dir, base, "loosened", body(dir, { rules: [GATE] })),
        SAMPLE,
      );
      const alone = refused(
        MAIN,
        judged(dir, body(dir), "loosened-unexplained"),
        GATE,
      );
      return `the branch's own copy passed it; main's workflow refused it: ${why}; the loosened gate alone, unexplained: ${alone}`;
    }),
};

export const rewrittenCi: Step = {
  does: `Judges with ${RUN_AS_GITHUB} a branch that rewrites ci.yml so its \`checks\` job checks nothing and adds product code that switches the type checker off (${SAMPLE}), explained and recorded, and checks that it refuses the branch; and that main's copy refuses the ci.yml rewrite alone when the body doesn't explain it, and passes it explained and recorded`,
  check: ({ root }) =>
    inScratch(root, ({ dir, base }) => {
      branch(dir, "rewritten-ci", () => {
        write(dir, CI, CHECKS_NOTHING);
        write(dir, SAMPLE, UNCHECKED);
        record(dir, CI);
      });
      branch(dir, "ci-alone", () => {
        write(dir, CI, CHECKS_NOTHING);
        record(dir, CI);
      });
      const why = refused(
        MAIN,
        byWorkflow(dir, base, "rewritten-ci", body(dir, { rules: [CI] })),
        SAMPLE,
      );
      const alone = refused(MAIN, judged(dir, body(dir), "ci-alone"), CI);
      passes(
        judged(dir, body(dir, { rules: [CI] }), "ci-alone"),
        "the ci.yml rewrite explained and recorded",
      );
      return `main's workflow refused it, whatever the branch's ci.yml runs: ${why}; the ci.yml rewrite alone, unexplained: ${alone}; explained and recorded, it passed`;
    }),
};

export const noFirstLine: Step = {
  does: 'Judges with main\'s copy of `rules-from-main` a PR body without its roadmap first line (it starts "## What"), and checks that it is refused and the same pull request with its first line passes',
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      branch(dir, "notes", () =>
        write(dir, "docs/proof-sample.md", `${WHY}\n`),
      );
      const why = refused(
        MAIN,
        judged(dir, body(dir, { first: "## What" }), "notes"),
        "first line",
      );
      passes(judged(dir, body(dir), "notes"), "it with its first line");
      return `refused it: ${why}; passed it with "${FIRST}"`;
    }),
};

export const fixWhenTouchedUnanswered: Step = {
  does: "Judges with main's copy of `rules-from-main` a change that touches a fix-when-touched area (a folder of the first entry of docs/fix-when-touched.md that names one) whose body doesn't name the entry, and checks that it is refused and passes once the body answers it",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      const entry = areasOf(git(dir, "show", `main:${TABLE}`)).find((e) =>
        e.paths.some((p) => p.endsWith("/")),
      );
      const folder = entry?.paths.find((p) => p.endsWith("/"));
      if (!entry || !folder)
        throw new Error(`${TABLE} on main has no entry naming a folder`);
      branch(dir, "unanswered", () =>
        write(dir, `${folder}proof-sample.md`, `${WHY}\n`),
      );
      const why = refused(
        MAIN,
        judged(dir, body(dir, { answered: false }), "unanswered"),
        `entry ${entry.n}`,
      );
      passes(
        judged(dir, body(dir), "unanswered"),
        "it with the entry answered",
      );
      return `refused a change to ${folder}proof-sample.md: ${why}; passed it answered`;
    }),
};

export const editedMigration: Step = {
  does: "Runs CI's migration check the same way (main's copy, `--head <scratch branch>`) on a scratch branch that edits a migration already on main, and checks that it fails",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      const migration = git(dir, "ls-files", "supabase/migrations/*.sql").split(
        "\n",
      )[0];
      if (!migration) throw new Error("main has no migration to edit");
      branch(dir, "edited-migration", () =>
        appendFileSync(join(dir, migration), `\n-- ${WHY}\n`),
      );
      return `it failed: ${refused(MAIN, judged(dir, body(dir), "edited-migration"), migration)}`;
    }),
};

const RULES = "the done rules";

export const deletedTest: Step = {
  does: "Runs the done rules (`bun scripts/done-gate.ts rules --head <scratch branch>`, as CI and every stop run them) on a deleted test (a scratch branch deletes a worker test file) with no line in docs/removed-tests.md, and checks that it is refused",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      const test = git(dir, "ls-files", "services/worker/test/*.test.ts").split(
        "\n",
      )[0];
      if (!test) throw new Error("main has no worker test file to delete");
      branch(dir, "deleted-test", () => rmSync(join(dir, test)));
      return `refused: ${refused(RULES, rules(dir, "deleted-test"), "docs/removed-tests.md", test)}`;
    }),
};

export const barrelExport: Step = {
  does: "Runs the done rules on a scratch branch that adds an export only a barrel file re-exports (`proofSample` in packages/shared/src/proof-sample.ts, which packages/shared/src/index.ts passes on and nothing imports), and checks that the export itself is refused, not only the barrel's line",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      const barrel = "packages/shared/src/index.ts";
      const sample = "packages/shared/src/proof-sample.ts";
      branch(dir, "barrel-export", () => {
        write(
          dir,
          sample,
          `// ${WHY}: nothing imports it.\nexport function proofSample() {\n  return 1;\n}\n`,
        );
        appendFileSync(
          join(dir, barrel),
          'export { proofSample } from "./proof-sample";\n',
        );
      });
      return `refused: ${refused(RULES, rules(dir, "barrel-export"), `${sample}:2 exports proofSample`)}`;
    }),
};
