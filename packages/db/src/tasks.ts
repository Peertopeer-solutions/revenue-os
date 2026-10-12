// The console's task queue: the company's tasks, open ones first.
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import type pg from "pg";
import { withOrg } from "./client";

export interface TaskRow {
  id: string;
  kind: string;
  status: string;
  priority: number | null;
  title: string;
  contact_id: string | null;
  conversation_id: string | null;
  due_at: string | null;
  created_at: string;
}

export async function listTasks(
  pool: pg.Pool,
  orgId: string,
): Promise<TaskRow[]> {
  return withOrg(pool, orgId, async (tx) => {
    const result = await tx.query(
      `select id, kind, status, priority::float8 as priority, title, contact_id, conversation_id,
              due_at::text as due_at, created_at::text as created_at
         from tasks
        where org_id = $1
        order by (status = 'open') desc, priority asc nulls last, created_at desc
        limit 100`,
      [orgId],
    );
    return result.rows;
  });
}
