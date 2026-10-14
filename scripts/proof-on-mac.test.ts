// `bun run proof 0 --on-my-mac` (scripts/proof/on-mac.ts): Devesh's run of Slice 0's two AI steps with his own Claude
// login. It refuses without one, and with one runs both steps and writes their record, transcripts and report into
// docs/proof/slice-0-ai/, which GitHub's steps then pass on once committed. A stand-in `claude` answers, never a model.
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { currentSlice, nextItem, parseRoadmap } from "../docs/tracker/parse.js";
import {
  copyOf,
  failures,
  git,
  HERE,
  prove,
  removeScratch,
  STATE,
  scratch,
  standIn,
} from "../tests/proof-stand-ins";
import { AI_STEPS, fingerprints, RECORD_DIR } from "./done-gate/mac-record";
import { NO_TOKEN, proveOnMac } from "./proof/on-mac";
import { agentSessionRecord, crossCompanyRecord } from "./proof/slice-0-agents";

setDefaultTimeout(300_000); // both steps clone this checkout, and the verifier's installs its packages
afterAll(removeScratch);
const TOKEN = "login-token-for-tests";

describe("bun run proof 0 --on-my-mac", () => {
  it("refuses without Devesh's Claude login, saying how to make one, and starts no session", async () => {
    const claude = standIn([{ say: "never asked" }]);
    // a copy without a record, whatever the checkout holds (a Mac run leaves its folder there until it is committed)
    const copy = copyOf((dir) =>
      rmSync(join(dir, RECORD_DIR), { recursive: true, force: true }),
    );
    const r = await proveOnMac({
      root: copy,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...claude.env },
      state: STATE,
      dir: scratch("proof-0-mac-"),
    });
    expect(r.code).toBe(2);
    expect(r.text).toBe(NO_TOKEN);
    expect(r.text).toContain("claude setup-token");
    expect(claude.calls()).toBe("");
    expect(existsSync(join(copy, RECORD_DIR))).toBe(false);
  });

  it("runs both steps with his login and writes their record, transcripts and report, which GitHub's steps then pass on once committed", async () => {
    const roadmap = parseRoadmap(git(HERE(), "show", "HEAD:ROADMAP.md"));
    const cur = currentSlice(roadmap.slices);
    const claude = standIn([
      {
        when: "word for word",
        say: "I ran its test.\nRuling: FAIL — no test asks for another company's open tasks",
      },
      {
        when: "/ready",
        say: "It checks the READY_TOKEN bearer token, then that the worker reaches its database and its job queue (pg-boss), each within 2 seconds.",
      },
      { when: "dark mode", say: "off-roadmap PR, or replan?" },
      {
        say: `We are on Slice ${cur?.n}, item: ${nextItem(cur)?.text.split(/:\s/)[0] ?? ""}.`,
      },
    ]);
    const copy = copyOf(() => {});
    const r = await proveOnMac({
      root: copy,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...claude.env,
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      },
      state: STATE,
      dir: scratch("proof-0-mac-"),
    });
    expect(r.text).toContain("Both AI steps passed.");
    expect(r.code).toBe(0);
    const record = JSON.parse(
      readFileSync(join(copy, "docs/proof/slice-0-ai/record.json"), "utf8"),
    );
    expect(record.commit).toBe(git(copy, "rev-parse", "HEAD"));
    expect(
      record.steps.map((s: { name: string; outcome: string }) => [
        s.name,
        s.outcome,
      ]),
    ).toEqual(AI_STEPS.map((name) => [name, "passed"]));
    expect(record.files).toEqual(fingerprints(copy, "HEAD"));
    expect(Object.keys(record.files)).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/settings.json",
        ".claude/agents/verifier.md",
        "scripts/done-gate.ts",
        "scripts/cycle.ts",
      ]),
    );
    for (const f of ["agent-session.txt", "verifier.txt", "report.md"])
      expect(existsSync(join(copy, RECORD_DIR, f))).toBe(true);
    expect(
      readFileSync(join(copy, RECORD_DIR, "agent-session.txt"), "utf8"),
    ).toContain("Devesh: which item are you on?");
    git(copy, "add", RECORD_DIR);
    git(
      copy,
      "-c",
      "user.email=p@p",
      "-c",
      "user.name=p",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "the record",
    );
    expect(
      failures(await prove([agentSessionRecord, crossCompanyRecord], copy)),
    ).toEqual([]);
  });

  it("run again, keeps only the new run: its record's outcomes and its files, nothing left from the run before", async () => {
    const cur = currentSlice(
      parseRoadmap(git(HERE(), "show", "HEAD:ROADMAP.md")).slices,
    );
    /** The Mac command in `copy`, the verifier ruling `ruling`. */
    const run = (copy: string, ruling: string) =>
      proveOnMac({
        root: copy,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...standIn([
            { when: "word for word", say: `I ran its test.\n${ruling}` },
            {
              when: "/ready",
              say: "It checks the READY_TOKEN bearer token, then that the worker reaches its database and its job queue (pg-boss), each within 2 seconds.",
            },
            { when: "dark mode", say: "off-roadmap PR, or replan?" },
            {
              say: `We are on Slice ${cur?.n}, item: ${nextItem(cur)?.text.split(/:\s/)[0] ?? ""}.`,
            },
          ]).env,
          CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
        },
        state: STATE,
        dir: scratch("proof-0-mac-"),
      });
    const outcomes = (copy: string) =>
      JSON.parse(
        readFileSync(join(copy, "docs/proof/slice-0-ai/record.json"), "utf8"),
      ).steps.map((s: { outcome: string }) => s.outcome);
    const copy = copyOf(() => {});
    const first = await run(copy, "Ruling: PASS — the count is right");
    expect(first.code).toBe(1);
    expect(first.text).toContain("Not every AI step passed");
    expect(outcomes(copy)).toEqual(["passed", "failed"]);
    writeFileSync(join(copy, RECORD_DIR, "left-over.txt"), "from before\n");
    const second = await run(
      copy,
      "Ruling: FAIL — no test asks for another company's open tasks",
    );
    expect(second.code).toBe(0);
    expect(outcomes(copy)).toEqual(["passed", "passed"]);
    expect(readdirSync(join(copy, RECORD_DIR)).sort()).toEqual([
      "agent-session.txt",
      "record.json",
      "report.md",
      "verifier.txt",
    ]);
    expect(
      readFileSync(join(copy, RECORD_DIR, "verifier.txt"), "utf8"),
    ).not.toContain("Ruling: PASS");
  });
});
