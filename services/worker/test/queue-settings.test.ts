// The worker's start-up gives its send queues their settings even where they already exist: pg-boss's createQueue
// leaves an existing queue as it was, so a database whose queues an older worker (or a test) made would keep them
// without the dead letter, and every call or WhatsApp job the scheduler queues there would copy that. Real pg-boss on
// the real local database, in a pg-boss schema of this test's own (fixtures/test-job-schema.ts).
import { afterAll, beforeAll, expect, it } from "bun:test";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { startJobs, stopJobs } from "../src/jobs";
import { testJobSchema } from "./fixtures/test-job-schema";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 1,
});
let jobs: Awaited<ReturnType<typeof testJobSchema>>;

beforeAll(async () => {
  jobs = await testJobSchema(admin);
  // An older worker made the queues with no dead letter.
  const older = new PgBoss({
    connectionString: DB_URL,
    schema: jobs.settings.schema,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  await older.start();
  for (const q of ["call.post", "place_call", "send_wa"])
    await older.createQueue(q, q === "call.post" ? {} : { policy: "short" });
  await older.stop({ graceful: false });
  await startJobs(jobs.settings);
}, 60_000);

afterAll(async () => {
  await stopJobs();
  await jobs.drop();
  await admin.end();
});

it("the call and WhatsApp queues an older worker made get the dead letter call.post when the worker starts", async () => {
  const r = await admin.query<{ name: string; dead_letter: string | null }>(
    `select name, dead_letter from ${jobs.settings.schema}.queue where name = any($1) order by name`,
    [["place_call", "run_agent_turn", "send_wa"]],
  );
  expect(r.rows).toEqual([
    { name: "place_call", dead_letter: "call.post" },
    { name: "run_agent_turn", dead_letter: null },
    { name: "send_wa", dead_letter: "call.post" },
  ]);
});
