// A wording guard, like verifier-instructions.test.ts: the task-loop skill (.claude/skills/task-loop/SKILL.md) keeps the
// checklist of the verifier's commonest FAIL reasons, which a builder goes through before the gate and verifier run
// the merge will use, and says its answers are never handed to the verifier. It proves the words are there, not that
// builders act on them.
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The skill as one line of words, so rewrapping a paragraph changes nothing here.
const words = readFileSync(
  join(import.meta.dir, "..", ".claude", "skills", "task-loop", "SKILL.md"),
  "utf8",
).replace(/\s+/g, " ");

it("sends the builder through the checklist before the gate and verifier run", () => {
  expect(words).toContain(
    "8. Go through **Before your first verifier run** (below), then `bun run gate` run bare",
  );
  expect(words).toContain(
    "## Before your first verifier run: its commonest FAIL reasons",
  );
});

// The loop's steps run in order, so they must agree with the checklist's last check: a ROADMAP.md tick after the
// verifier's PASS changes the code it ruled on, and the gate and the verifier must then run again.
it("has the builder open the PR and write its records before the gate and verifier run the merge uses", () => {
  const order = [
    "6. Show it working:",
    "7. Open the PR and write its records now, before the run the merge uses",
    "tick the item in `ROADMAP.md` with `· evidence: …`, from what you have seen",
    "8. Go through **Before your first verifier run**",
    "9. Run the verifier agent",
    "10. Put the gate's line and the verifier's ruling in the PR body",
  ].map((phrase) => words.indexOf(phrase));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

it("names each of the six FAIL reasons the verifier's rulings gave", () => {
  for (const phrase of [
    "**The records match the code, and main after each merge, counts included.**",
    "**Each outside call's failure has a test.**",
    "unreachable, answer empty, be cancelled, or get bad or missing input",
    "marks no good work failed",
    "**Each edge case the request names has a test**",
    "**Each new or edited test fails on main for its stated reason**",
    "**A decision line covers this change only.**",
    "**The PR is open, and the item's ROADMAP.md and STATE.md lines are written, before the `bun run gate` and verifier run whose results the merge uses**",
    "Claim no ruling or CI result you have not seen",
  ])
    expect(words).toContain(phrase);
});

it("adds to the verifier's checks and keeps the builder's answers away from it", () => {
  expect(words).toContain(
    "This list adds to the verifier's checks and replaces none; your answers are for you, never evidence you hand the verifier.",
  );
});

it("points at the checks the old lessons became, not at a search of lessons.md", () => {
  expect(words).not.toContain("lessons.md` and read");
  for (const phrase of [
    "a stop and a merge count only the gate's own record of a pass",
    "it waits until GitHub reports `checks` passed on a head that holds main's tip",
    "biome.json leaves `.claude/worktrees` out",
    "refuses a pull request naming an item main already ticked unless it adds to its evidence",
  ])
    expect(words).toContain(phrase);
});
