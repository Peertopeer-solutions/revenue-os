// Slice 1's proof, its step for a lead with no WhatsApp opt-in being refused a message: it runs, by name, the tests that
// make a lead's next WhatsApp message through the real send_wa job and guard on the local stack and see it refused
// when no opt-in is recorded or it was withdrawn, and sent once a person (the API) or an imported list records the
// opt-in and where it came from (services/worker/test/whatsapp-opt-in.test.ts). A rename, a removal or a failure of
// any of them fails the step. The tests sign people in, so they run with the local stack's settings: the proof
// workflow sets them; on this machine they are read from the running stack.

import { buildLocalEnv, LOCAL_ENV_KEYS } from "../local-env";
import { namedTestsPass } from "./named-tests";
import { sh } from "./scratch";
import type { Step } from "./step";

const FILE = "services/worker/test/whatsapp-opt-in.test.ts";
const TESTS = [
  "is refused a WhatsApp message: the send_wa job sends nothing and leaves no conversation",
  "an operator records the lead's opt-in and where it came from, and the lead's next WhatsApp message is sent",
  "records the opt-in and its source column, or 'imported list', for new and known leads, and their next message is sent",
  "a withdrawn opt-in refuses the lead's next WhatsApp message",
  "opting in again after a withdrawal is refused (409), by a person and by a list, and the lead stays refused",
];

export const noOptInLeadRefused: Step = {
  does: `Makes a lead's next WhatsApp message through the worker's real send_wa job and guard on the local stack, and checks it is refused while the lead has no recorded opt-in or withdrew it (opting in again refused), and sent once a person through the API or an imported list records the opt-in and where it came from (the ${TESTS.length} tests it names in ${FILE}, each run alone)`,
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
    return `a lead with no opt-in, or a withdrawn one, was refused a WhatsApp message, and an opted-in lead got it; ${namedTestsPass(root, FILE, TESTS, stack)}`;
  },
};
