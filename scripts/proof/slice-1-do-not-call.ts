// Slice 1's proof, its step for a do-not-call lead being refused a message: it runs, by name, the tests that record a
// lead's "don't contact me" each way it reaches us (a person in the console, an imported list, the AI's reading of a
// call) on the local stack, then make that lead's next WhatsApp message and next call through the real send jobs and
// guard, and see both refused (services/worker/test/do-not-call.test.ts), beside the test where a lead nobody blocked
// gets both. A rename, a removal or a failure of any of them fails the step. The tests sign people in, so they run
// with the local stack's settings: the proof workflow sets them; on this machine they are read from the running stack.

import { buildLocalEnv, LOCAL_ENV_KEYS } from "../local-env";
import { namedTestsPass } from "./named-tests";
import { sh } from "./scratch";
import type { Step } from "./step";

const FILE = "services/worker/test/do-not-call.test.ts";
const TESTS = [
  "gets their next WhatsApp message and call, so each refusal below is the block's doing",
  "an operator marks a lead do-not-call, and that lead's next WhatsApp message and call are refused in every sequence",
  "a lead the list marks do-not-call is blocked, whether new or already the company's, and their next send is refused",
  "the AI's reading that the lead asked not to be contacted blocks the call's lead, and their next send is refused",
  "a known lead who calls in is blocked by the number they call from, and their next send is refused",
  "a reading may never lift a block or grant consent, whatever it says",
];

export const doNotCallLeadRefused: Step = {
  does: `Records a lead's "don't contact me" on the local stack each way it reaches us (a person in the console, an imported list, the AI's reading of a call), then makes that lead's next WhatsApp message and next call through the worker's real send jobs and guard, and checks both are refused while a lead nobody blocked gets both, and that a call's reading never lifts a block or grants consent (the ${TESTS.length} tests it names in ${FILE}, each run alone)`,
  check: ({ root, env }) => {
    const known = Object.fromEntries(LOCAL_ENV_KEYS.map((k) => [k, env[k]]));
    const stack = LOCAL_ENV_KEYS.every((k) => env[k])
      ? known
      : {
          ...known,
          ...buildLocalEnv(
            sh(root, ["supabase", "status", "-o", "env"]).stdout,
            env,
          ),
        };
    return `each way of recording "don't contact me" blocked the lead's next WhatsApp message and call, and an open lead got both; ${namedTestsPass(root, FILE, TESTS, stack)}`;
  },
};
