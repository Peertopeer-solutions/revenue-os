// The worker's API on the local postgres login, which the database's per-company rules let through, so only the
// company filter in each read keeps another company's rows out. company-filter-api.test.ts runs it in a process of
// its own, because the API's pool is made from DATABASE_URL when the app loads (src/db.ts): the login is set first.
// Arguments: a signed-in person's token, then the paths to GET. Prints one line, `RESULT <json>`, each path's status
// and body, after whatever the worker logs.
import { isLocalUrl } from "../../../../scripts/local-url";

const [token, ...paths] = process.argv.slice(2);
const login =
  process.env.LOCAL_DB_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
if (!token || ![login, process.env.SUPABASE_URL].every(isLocalUrl))
  throw new Error(
    "company-filter-api runs only on this machine's database and sign-in server, with a token",
  );
process.env.DATABASE_URL = login;
// Imported, not run: as the main module index.ts would also start the job runner.
const { default: worker } = await import("../../src/index");

const results = [];
for (const path of paths) {
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  results.push({ path, status: res.status, body: await res.json() });
}
// The open database pool would keep the process alive: exit once the line is written.
process.stdout.write(`RESULT ${JSON.stringify(results)}\n`, () =>
  process.exit(0),
);
