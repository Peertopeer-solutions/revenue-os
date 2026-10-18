// Tasks for people: the one way a task is made (createTask; `bun run guards` fails any other insert into tasks) and
// the console's task queue (listTasks), the company's tasks, open ones first.
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import type pg from "pg";
import { type ActorType, audit } from "./audit";
import { type Db, withOrg } from "./client";

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

export type TaskKind =
  | "approval"
  | "callback"
  | "review"
  | "handoff"
  | "manual";

/**
 * The one way a task for a person is made (a hand-over, a callback, an approval, a review): always for a lead, inside
 * the caller's transaction, with its `task.create` audit row, so the task and its record commit or roll back together.
 * A job that can be delivered twice passes `once`, a key naming what it asks for: a task already made under that key
 * in the company is returned and nothing new is written, even when two deliveries ask at the same moment (the second
 * waits for the first's transaction). The task's id.
 */
export async function createTask(
  db: Db,
  orgId: string,
  task: {
    contactId: string;
    kind: TaskKind;
    title: string;
    workflowRunId?: string;
    conversationId?: string;
    payload?: Record<string, unknown>;
    actor: { type: ActorType };
    once?: string;
  },
): Promise<string> {
  if (!task.contactId)
    throw new Error("a task is always for a lead: its contactId is missing");
  if (task.once) {
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `task:${orgId}:${task.once}`,
    ]);
    const made = await db.query(
      `select id from tasks where org_id = $1 and payload ->> 'once' = $2 limit 1`,
      [orgId, task.once],
    );
    if (made.rows[0]) return String(made.rows[0].id);
  }
  const made = await db.query(
    `insert into tasks (org_id, contact_id, workflow_run_id, conversation_id, kind, title, payload)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
    [
      orgId,
      task.contactId,
      task.workflowRunId ?? null,
      task.conversationId ?? null,
      task.kind,
      task.title,
      JSON.stringify({
        ...task.payload,
        ...(task.once && { once: task.once }),
      }),
    ],
  );
  const id = String(made.rows[0]?.id);
  await audit(db, orgId, {
    actorType: task.actor.type,
    action: "task.create",
    resourceType: "task",
    resourceId: id,
    after: {
      kind: task.kind,
      title: task.title,
      contact_id: task.contactId,
      workflow_run_id: task.workflowRunId ?? null,
      conversation_id: task.conversationId ?? null,
    },
  });
  return id;
}
