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
 * The task's id.
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
    actor: { type: ActorType; id?: string };
  },
): Promise<string> {
  if (!task.contactId)
    throw new Error("a task is always for a lead: its contactId is missing");
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
      JSON.stringify(task.payload ?? {}),
    ],
  );
  const id = String(made.rows[0]?.id);
  await audit(db, orgId, {
    actorType: task.actor.type,
    actorId: task.actor.id,
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
