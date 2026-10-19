// A worker process for test/restarts.test.ts to stop and kill: the worker's real job runner (startJobs in
// services/worker/src/jobs.ts) in the test's own pg-boss schema (JOB_SCHEMA), stopped on a signal as the worker is
// (stopOnSignal, as src/index.ts calls it), with a pretend dialer and WhatsApp service. Each reports a send on stdout
// as it takes it, holds it for HOLD_MS, then reports its answer. The runner checks for jobs whose worker died every
// second here, not every 15 seconds.
import { randomUUID } from "node:crypto";
import { startJobs, stopOnSignal } from "../../src/jobs";

const hold = Number(process.env.HOLD_MS ?? 0);
const say = (line: object) => console.log(JSON.stringify(line));
const take =
  (what: string) =>
  async ({ to }: { to: string }) => {
    say({ [what]: to });
    await new Promise((res) => setTimeout(res, hold));
    say({ answered: to });
    return { providerRef: `${what}-${randomUUID()}` };
  };

await startJobs(
  {
    schema: process.env.JOB_SCHEMA,
    schedule: false,
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  },
  {
    voice: { place: take("placed") },
    wa: { send: take("messaged") },
    outcome: async () => "completed",
    provider: {
      complete: async () => ({ text: "Namaste.", usage: { in: 1, out: 1 } }),
    },
  },
);
stopOnSignal(() => process.exit(0));
say({ ready: true });
