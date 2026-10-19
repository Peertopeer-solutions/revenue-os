// audit() — the one writer of audit_log rows (`bun run guards` fails any other insert into it). Called INSIDE the same
// withOrg transaction as the change it describes, so the row commits or rolls back with the change; the AI engine
// writes its tool rows through it too. audit_log is append-only by RLS (sel+ins policies only).
// G1: runtime-agnostic.
import type { Db } from "./client";

export type ActorType = "user" | "agent" | "system" | "integration";

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string;
  action: string; // 'org.create', 'contact.update', 'tool.book_appointment', …
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>; // request id, workflow_run_id, model, latency, …
}

export async function audit(
  tx: Db,
  orgId: string,
  entry: AuditEntry,
): Promise<void> {
  await tx.query(
    `insert into audit_log (org_id, actor_type, actor_id, action, resource_type, resource_id, before, after, meta)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      JSON.stringify(entry.meta ?? {}),
    ],
  );
}
