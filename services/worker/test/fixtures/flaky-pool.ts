// A database pool for a job handler whose connection fails once `trip()` is called: a pretend provider calls it as
// it takes a send, so the handler meets the database going away right after the provider accepted. `trip()` fails the
// next connection, the one that saves the provider's answer; `trip(1)` lets that one through and fails the one after
// it. Every other connection is the real app_service one.
import { createPool } from "@revenue-os/db";

export function flakyPool(
  url = process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
) {
  const pool = createPool(url);
  const connect = pool.connect.bind(pool);
  let failIn = -1; // connections still to let through before the one that fails; -1: none fails
  pool.connect = (() => {
    if (failIn < 0) return connect();
    if (failIn-- > 0) return connect();
    return Promise.reject(new Error("the database went away"));
  }) as typeof pool.connect;
  return {
    pool,
    trip: (after = 0) => {
      failIn = after;
    },
  };
}
