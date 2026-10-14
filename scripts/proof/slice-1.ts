// Slice 1's proof steps, in the order ROADMAP.md → Slice 1 → Proof gives the checks they make. Each Slice 1 item adds
// the steps for what it builds and strikes its check from NOT_YET (docs/decisions-in-force/), so until every
// check has its step, `bun run proof 1` fails on the last step, naming the checks no step makes yet, and never reads
// as passed.

import { attachAcrossCompaniesRefused } from "./slice-1-links";
import { signUpAndStrangerRefused } from "./slice-1-sign-in";
import { imageNamesItsCommit, readyWithoutDatabase } from "./slice-1-worker";
import type { Step } from "./step";

// The checks the Proof line names that no step makes yet, in its words.
export const NOT_YET = [
  "`bun run demo` takes one scripted lead from enrolment to a booked site visit, each printed step reaching its outcome",
  "a do-not-call lead and a lead with no WhatsApp opt-in are each refused a message",
  "a user from another company is refused this company's data",
  "a replayed duplicate event and a worker killed mid-job cause no repeated call or message and leave no lead stuck",
];

export const everyCheckHasAStep: Step = {
  does: "Checks that every check ROADMAP.md → Slice 1 → Proof names has a step in this run",
  check: () => {
    if (NOT_YET.length)
      throw new Error(
        `this run proves only the steps above; no step makes these ${NOT_YET.length} checks yet, so Slice 1 can't be called proved:\n- ${NOT_YET.join("\n- ")}`,
      );
    return "every check the Proof line names has its step";
  },
};

export const steps: Step[] = [
  signUpAndStrangerRefused,
  attachAcrossCompaniesRefused,
  readyWithoutDatabase,
  imageNamesItsCommit,
  everyCheckHasAStep,
];
