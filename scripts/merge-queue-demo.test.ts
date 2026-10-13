// Demo for the Slice 1 item "The merge queue is seen working", never merged: this test passes on main as it is, and
// fails once a pull request ahead of it in the merge queue ticks the Waiting on Devesh item it reads, so the queue
// must take this pull request out on the combined code and never land it.
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseState } from "../docs/tracker/parse.js";

// behaviour already on main: a demo that must pass alone and fail only on top of the pull request queued ahead of it
it("the merge queue's switch-on still waits on Devesh", () => {
  const state = parseState(
    readFileSync(join(import.meta.dir, "..", "STATE.md"), "utf8"),
  );
  const item = state.waiting.find((w: { text: string }) =>
    w.text.includes("Switch on GitHub's merge queue for main"),
  );
  expect(item?.done).toBe(false);
});
