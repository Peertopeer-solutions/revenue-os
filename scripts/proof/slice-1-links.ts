// Slice 1's proof, its step for records that stay in their company: it runs, by name, the test that gives two
// companies one record in every company table on the local stack and points each of company A's records at company
// B's, through every link between company records the database lists (tests/company-links.test.ts). The links are
// read from the database, so a link added later is tried too; a rename, a removal or a failure of that test fails
// the step.

import { namedTestsPass } from "./named-tests";
import type { Step } from "./step";

const FILE = "tests/company-links.test.ts";
const TEST =
  "each refuses another company's record, and still takes the company's own and, where it may, a shared template";

export const attachAcrossCompaniesRefused: Step = {
  does: `Gives two companies one record in every company table on the local stack, then points each of company A's records at company B's, one link at a time, through every link between company records the database lists, and checks the database refuses each while still taking company A's own record and, where a link may point at one, a shared template (the test "${TEST}" in ${FILE}, run alone)`,
  check: ({ root }) =>
    `the database refused company A's records pointed at company B's on every link, and took A's own and the shared templates; ${namedTestsPass(root, FILE, [TEST])}`,
};
