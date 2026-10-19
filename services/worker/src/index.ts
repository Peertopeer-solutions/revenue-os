// ONE process: Hono API + webhook receivers + pg-boss consumers + scheduler (docs/tech-stack.md, its API framework,
// jobs and hosting sections; the agent harness is its harness architecture section). The routes are in app.ts.
// Bun-specific code is allowed HERE (app entrypoint) — never in packages/* (AGENTS.md → Conventions).
import { app } from "./app";
import { env } from "./env";
import { startJobs, stopOnSignal } from "./jobs";
import { logger } from "./logger";

// pg-boss consumers boot with the server, never on test import (import.meta.main is
// false under bun test). Half-configured boot = refuse to run, same posture as env.ts. On a restart or deploy the
// worker takes no new job and lets running ones finish before it exits (test/restarts.test.ts stops and kills one).
if (import.meta.main) {
  stopOnSignal(() => process.exit(0)); // coverage gap: runs only in the started worker process; restarts.test.ts starts one with the same call
  startJobs().catch((err) => {
    logger.error({ err }, "pg-boss failed to start — worker refuses to boot");
    process.exit(1);
  });
}

export default { port: env.PORT, fetch: app.fetch };
