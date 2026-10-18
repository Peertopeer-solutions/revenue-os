// Slice 1's proof steps (scripts/proof/slice-1*.ts). Its three worker steps run only in `bun run proof 1`, as Slice 0's
// whole-suite step does: each starts a real worker, which takes every company's due jobs from the one local database,
// and the whole-suite-at-once test (services/worker/test/test-runs-at-once.test.ts) runs this suite four times at once
// beside another company's queued calls that no test may take. What the worker answers is tested on the real
// database with a job schema of the test's own (services/worker/test/ready.test.ts); ci.yml's image build checks the
// image's label. Who the worker and the sign-in server refuse is tested in services/worker/test/orgs.test.ts,
// services/worker/test/sign-in.test.ts and tests/sign-up.test.ts. The links step runs one test of
// tests/company-links.test.ts by name, and the do-not-call step five of services/worker/test/do-not-call.test.ts.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toProve } from "./proof/cli";
import { runSteps } from "./proof/run";
import { everyCheckHasAStep, NOT_YET, steps as slice1 } from "./proof/slice-1";
import { SLICES } from "./proof/slices";

const ROOT = join(import.meta.dir, "..");

describe("Slice 1's steps", () => {
  it("are the ones `bun run proof 1` runs, and the last fails while a check the Proof line names has no step, naming each one", async () => {
    expect(SLICES[1]).toBe(slice1);
    expect(toProve(["1"], ROOT)).toEqual({
      n: 1,
      steps: slice1,
      out: undefined,
    });
    const [result] = await runSteps([everyCheckHasAStep], {
      root: ROOT,
      env: {},
      state: "",
      dir: mkdtempSync(join(tmpdir(), "proof-slice-1-")),
    });
    expect(result?.outcome).toBe("failed");
    expect(NOT_YET.length).toBeGreaterThan(0);
    for (const check of NOT_YET) expect(result?.seen).toContain(check);
    expect(slice1.at(-1)).toBe(everyCheckHasAStep);
  });

  it("prove a self sign-up and a stranger creating a company are each refused, first, as the Proof line orders them", async () => {
    expect(NOT_YET.join("\n")).not.toContain("self sign-up");
    const { signUpAndStrangerRefused } = await import(
      "./proof/slice-1-sign-in"
    );
    expect(slice1[0]).toBe(signUpAndStrangerRefused);
    expect(signUpAndStrangerRefused.does).toContain("422 signup_disabled");
    expect(signUpAndStrangerRefused.does).toContain("403 not_an_operator");
  });

  it("prove a do-not-call lead is refused a message, after the sign-up step, as the Proof line orders them", async () => {
    expect(NOT_YET.join("\n")).not.toContain("do-not-call lead");
    const { doNotCallLeadRefused } = await import(
      "./proof/slice-1-do-not-call"
    );
    expect(slice1[1]).toBe(doNotCallLeadRefused);
    expect(doNotCallLeadRefused.does).toContain(
      "services/worker/test/do-not-call.test.ts",
    );
    expect(doNotCallLeadRefused.does).toContain("the AI's reading of a call");
  });

  it("prove an attempt to attach one company's record to another company is rejected, before the worker's readiness check, as the Proof line orders them", async () => {
    expect(NOT_YET.join("\n")).not.toContain("attach one company's record");
    const { attachAcrossCompaniesRefused } = await import(
      "./proof/slice-1-links"
    );
    expect(slice1[2]).toBe(attachAcrossCompaniesRefused);
    expect(attachAcrossCompaniesRefused.does).toContain(
      "tests/company-links.test.ts",
    );
  });
});
