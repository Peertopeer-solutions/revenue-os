// bun test preload (bunfig.toml): refuses to run unless every database and sign-in server the tests write to is on
// this machine (the one check, scripts/local-url.ts), then makes sure the tests can log in as app_service, writing
// that login only on a stack that doesn't have it yet (scripts/app-service-login.ts), so runs can start together.
// It also works around a Bun bug that froze whole test runs (below).
import childProcess from "node:child_process";
import { ensureAppServiceLogin } from "../scripts/app-service-login";
import { isLocalUrl } from "../scripts/local-url";

// Bun's synchronous spawn can miss the exit of a command that has finished and wait for it forever, spinning a core:
// a memory clean-up that runs while it waits releases the main event loop's handles against the spawn's own loop
// (oven-sh/bun#34069; the fix, oven-sh/bun#44581, first ships in Bun 1.4.3). It froze one whole-suite run in about five
// when four ran at once here, and the test step on GitHub. A full clean-up just before each synchronous spawn leaves
// nothing for one to release while it waits. Remove this once the pinned Bun has the fix.
for (const name of ["spawnSync", "execFileSync", "execSync"] as const) {
  const real = childProcess[name] as (...args: unknown[]) => unknown;
  Object.assign(childProcess, {
    [name]: (...args: unknown[]) => {
      Bun.gc(true);
      return real(...args);
    },
  });
}
const realSpawnSync = Bun.spawnSync;
Object.assign(Bun, {
  spawnSync: (...args: Parameters<typeof Bun.spawnSync>) => {
    Bun.gc(true);
    return realSpawnSync(...args);
  },
});

const admin =
  process.env.LOCAL_DB_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const app =
  process.env.DATABASE_URL ||
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
const auth = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
if (![admin, app, auth].every(isLocalUrl))
  throw new Error(
    "tests/setup.local.ts refuses to run against a non-local database",
  );
await ensureAppServiceLogin(admin, app);
