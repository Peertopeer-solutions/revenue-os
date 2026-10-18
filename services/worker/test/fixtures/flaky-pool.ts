// A database pool for a job handler whose next connection fails once `trip()` is called: a pretend provider calls it
// as it takes a send, so the handler meets the database going away right after the provider accepted, before the
// answer is saved. Every other connection is the real app_service one.
import { createPool } from "@revenue-os/db";

export function flakyPool(
  url = process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
) {
  const pool = createPool(url);
  const connect = pool.connect.bind(pool);
  let down = false;
  pool.connect = (() => {
    if (!down) return connect();
    down = false;
    return Promise.reject(new Error("the database went away"));
  }) as typeof pool.connect;
  return { pool, trip: () => (down = true) };
}
