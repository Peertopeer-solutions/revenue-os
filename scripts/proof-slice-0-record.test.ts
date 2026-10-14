// Slice 0's two AI steps as GitHub's proof run takes them (scripts/proof/slice-0-agents.ts): from the record of their
// run on Devesh's Mac committed in docs/proof/slice-0-ai/, never a model. They pass while that record passed them and
// every file they test is as that run had it, wait on Devesh's Mac otherwise, and fail a step the Mac run failed.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copyOf,
  failures,
  git,
  prove,
  removeScratch,
  standIn,
} from "../tests/proof-stand-ins";
import {
  AGAIN,
  AI_STEPS,
  fingerprints,
  MAC_COMMAND,
  RECORD,
  RECORD_DIR,
  recordFiles,
} from "./done-gate/mac-record";
import { agentSessionRecord, crossCompanyRecord } from "./proof/slice-0-agents";

setDefaultTimeout(120_000); // each case copies this checkout
afterAll(removeScratch);

describe("Slice 0's AI steps on GitHub: the record Devesh's Mac run committed", () => {
  /** A copy of the proved commit with a record of a Mac run committed (each step's outcome as `outcomes` says), then `edit`. */
  const recorded = (
    outcomes: Partial<Record<(typeof AI_STEPS)[number], string>> = {},
    edit: (dir: string) => void = () => {},
  ) =>
    copyOf((dir) => {
      rmSync(join(dir, RECORD_DIR), { recursive: true, force: true });
      mkdirSync(join(dir, RECORD_DIR), { recursive: true });
      const written = recordFiles({
        commit: git(dir, "rev-parse", "HEAD"),
        date: "2026-10-14",
        claude: "2.1.299",
        steps: AI_STEPS.map((name) => ({
          name,
          outcome: (outcomes[name] ?? "passed") as "passed" | "failed",
          seen: `${name} seen on the Mac`,
        })),
        files: fingerprints(dir, "HEAD"),
      });
      for (const [path, text] of Object.entries(written))
        writeFileSync(join(dir, path), text);
      git(dir, "add", RECORD_DIR);
      edit(dir);
    }, "a record of a Mac run");
  const both = [agentSessionRecord, crossCompanyRecord];

  it("pass, naming the Mac run, when the committed record passed them and every file they test is as that run had it; no model runs", async () => {
    const claude = standIn([{ say: "never asked" }]);
    const results = await prove(both, recorded(), claude.env);
    expect(failures(results)).toEqual([]);
    for (const [i, r] of results.entries()) {
      expect(r.seen).toContain("passed on Devesh's Mac on 2026-10-14");
      expect(r.seen).toContain(`${AI_STEPS[i]} seen on the Mac`);
    }
    expect(claude.calls()).toBe("");
  });

  it("wait on Devesh's Mac, naming the command, with no record committed", async () => {
    const results = await prove(
      both,
      copyOf((dir) =>
        rmSync(join(dir, RECORD_DIR), { recursive: true, force: true }),
      ),
    );
    for (const r of results) {
      expect(r.outcome).toBe("waiting");
      expect(r.seen).toContain(AGAIN);
      expect(r.seen).toContain(MAC_COMMAND);
      expect(r.seen).toContain(`${RECORD} is not committed`);
    }
  });

  it("wait once a file they test changed since the Mac run, naming it", async () => {
    const results = await prove(
      both,
      recorded({}, (dir) => {
        appendFileSync(join(dir, "AGENTS.md"), "\nA new rule.\n");
        appendFileSync(join(dir, ".claude", "agents", "verifier.md"), "\n");
      }),
    );
    for (const r of results) {
      expect(r.outcome).toBe("waiting");
      expect(r.seen).toContain("2 file(s) those steps test changed");
      expect(r.seen).toContain(".claude/agents/verifier.md, AGENTS.md");
    }
  });

  it("fail the step the Mac run failed, saying what it saw there; the other still passes", async () => {
    const [session, verifierRun] = await prove(
      both,
      recorded({ verifier: "failed" }),
    );
    expect(session?.outcome).toBe("passed");
    expect(verifierRun?.outcome).toBe("failed");
    expect(verifierRun?.seen).toContain(
      "the verifier step failed on Devesh's Mac on 2026-10-14",
    );
    expect(verifierRun?.seen).toContain("verifier seen on the Mac");
  });
});
