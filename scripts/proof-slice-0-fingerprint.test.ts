// Slice 0's Proof line (ROADMAP.md) is pinned to the steps written to it (scripts/proof/slice-0*.ts): changing the
// line fails this test until each changed check has its step and the fingerprint below is updated.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoadmap } from "../docs/tracker/parse.js";

// The fingerprint of Slice 0's Proof line as these steps were written to it.
const PROOF_LINE = "954a053d2ebf2fe1";

describe("Slice 0's proof steps", () => {
  // behaviour already on main: it reads ROADMAP.md with docs/tracker/parse.js, and neither is product code, so main's copy holds this change's Proof line and parser too
  it("its Proof line is the one these steps were written to: a change to it must revisit them", () => {
    const roadmap = readFileSync(
      join(import.meta.dir, "..", "ROADMAP.md"),
      "utf8",
    );
    const proof =
      parseRoadmap(roadmap).slices.find((s) => s.n === 0)?.Proof ?? "";
    // A new or reworded check needs its step (scripts/proof/slice-0*.ts); then this fingerprint is updated.
    expect(createHash("sha256").update(proof).digest("hex").slice(0, 16)).toBe(
      PROOF_LINE,
    );
  });
});
