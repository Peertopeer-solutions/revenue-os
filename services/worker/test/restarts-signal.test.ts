// The worker's stop on a signal (stopOnSignal in services/worker/src/jobs.ts, as src/index.ts calls it), in this
// process: SIGTERM, as a restart or deploy sends it, stops the job runner, so the worker no longer answers ready, and
// then the worker exits; Ctrl-C's SIGINT does the same. restarts.test.ts sends SIGTERM to a real worker process.
import { afterAll, beforeAll, expect, it } from "bun:test";
import pg from "pg";
import {
  jobQueueReachable,
  startJobs,
  stopJobs,
  stopOnSignal,
} from "../src/jobs";
import { testJobSchema } from "./fixtures/test-job-schema";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 1,
});
let jobs: Awaited<ReturnType<typeof testJobSchema>>;

beforeAll(async () => {
  jobs = await testJobSchema(admin);
}, 30_000);

afterAll(async () => {
  await stopJobs();
  await jobs.drop();
  await admin.end();
});

async function until(ok: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((res) => setTimeout(res, 50));
  }
}

it("SIGTERM stops the worker's job runner (it no longer answers ready), then the worker exits; SIGINT the same", async () => {
  await startJobs(jobs.settings);
  expect(await jobQueueReachable()).toBe(true);
  let exits = 0;
  stopOnSignal(() => exits++);

  process.emit("SIGTERM");
  await until(() => exits === 1, "the worker never exited on SIGTERM");
  expect(await jobQueueReachable()).toBe(false);

  await startJobs(jobs.settings);
  process.emit("SIGINT");
  await until(() => exits === 2, "the worker never exited on SIGINT");
  expect(await jobQueueReachable()).toBe(false);
}, 30_000);
