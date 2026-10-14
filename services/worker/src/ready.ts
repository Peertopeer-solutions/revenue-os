// GET /ready answers ready only when the worker reaches its database and its job queue, each within a time limit so a
// hung database can't hang the answer; GET /release names the commit the worker was built from. Both sit behind the
// ready token (docs/security.md S5.9; the decision on /ready's token in docs/decisions-in-force/). A caller sees only
// what failed, in plain words; the error itself goes to the log, never to the caller (docs/security.md S5.8).
import { Hono } from "hono";
import type { Pool } from "pg";
import { requireReadyToken } from "./auth";
import { logger } from "./logger";

/** One thing the worker must reach: true when it answered. */
export type Check = () => Promise<boolean>;

export const READY_LIMIT_MS = 2_000;

/** The database answers a query through `db`, the pool the worker uses. */
export const databaseReachable =
  (db: Pick<Pool, "query">): Check =>
  async () =>
    (await db.query("select 1 as ok")).rows.length === 1;

/** False when `check` throws, says no, or gives no answer within `ms`. */
async function passes(name: string, check: Check, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<never>((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`no answer within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } catch (err) {
    logger.warn({ err, check: name }, "readiness check failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function opsRoutes(o: {
  token: string | undefined;
  release: string | undefined;
  checks: Record<string, Check>;
  limitMs?: number;
}) {
  const guard = requireReadyToken(o.token);
  return new Hono()
    .get("/ready", guard, async (c) => {
      const results = await Promise.all(
        Object.entries(o.checks).map(async ([name, check]) =>
          (await passes(name, check, o.limitMs ?? READY_LIMIT_MS))
            ? []
            : [name],
        ),
      );
      const unreachable = results.flat();
      return unreachable.length
        ? c.json({ ok: false, unreachable }, 503)
        : c.json({ ok: true });
    })
    .get("/release", guard, (c) => c.json({ release: o.release ?? "unknown" }));
}
