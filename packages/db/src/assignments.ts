// Which role works a lead (agent_assignments, migration 026): one row per lead, active, paused, with a person or ended.
// setAssignment is the one way it is written (`bun run guards` fails any other write). A lead is enrolled with a role
// or in a sequence, never both: setAssignment refuses a lead with an open run, as startRun (services/worker/src/runs.ts)
// refuses a lead whose assignment has not ended (openAssignment); each first locks the lead's row (lockLead), so two
// at once can't both pass. Every change is audited.
// G1: runtime-agnostic.
import type { AssignmentStatus } from "@revenue-os/shared";
import { type ActorType, audit } from "./audit";
import type { Db } from "./client";

export type Assignment = {
  roleKey: string;
  status: AssignmentStatus;
  since: string; // when this status began
  why: string;
};

export type AssignmentResult =
  | { ok: true; assignment: Assignment }
  | { ok: false; refused: "not_found" | "unknown_role" }
  | { ok: false; refused: "in_sequence"; runId: string };

const asAssignment = (r: Record<string, unknown>): Assignment => ({
  roleKey: String(r.role_key),
  status: r.status as AssignmentStatus,
  since: String(r.since),
  why: String(r.why),
});

/**
 * Locks the company's lead against another enrolment until the caller's transaction ends (a lock that leaves the
 * links other rows make to the lead alone). False when the company has no such lead.
 */
export async function lockLead(
  db: Db,
  orgId: string,
  contactId: string,
): Promise<boolean> {
  const r = await db.query(
    `select 1 from contacts where id = $1 and org_id = $2 for no key update`,
    [contactId, orgId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The lead's assignment while it lasts (any status but ended), or undefined. */
export async function openAssignment(
  db: Db,
  orgId: string,
  contactId: string,
): Promise<Assignment | undefined> {
  const r = await db.query(
    `select role_key, status, since::text as since, why from agent_assignments
      where org_id = $1 and contact_id = $2 and status <> 'ended'`,
    [orgId, contactId],
  );
  return r.rows[0] && asAssignment(r.rows[0]);
}

/**
 * Sets which role works the company's lead, in the caller's transaction (withOrg's), and audits who changed it and
 * why. Refused for a lead the company doesn't have, a role with no version the company can use, and, unless the
 * assignment ends, a lead with an open run in a sequence (the run's id is given).
 */
export async function setAssignment(
  db: Db,
  orgId: string,
  contactId: string,
  change: {
    roleKey: string;
    status: AssignmentStatus;
    why: string;
    actor: { type: ActorType; id?: string };
  },
): Promise<AssignmentResult> {
  if (!(await lockLead(db, orgId, contactId)))
    return { ok: false, refused: "not_found" };
  const role = await db.query(
    `select 1 from agents where key = $1 and (org_id = $2 or org_id is null) limit 1`,
    [change.roleKey, orgId],
  );
  if (!role.rowCount) return { ok: false, refused: "unknown_role" };
  if (change.status !== "ended") {
    const run = await db.query(
      `select id from workflow_runs
        where org_id = $1 and contact_id = $2 and status in ('pending', 'running', 'waiting') limit 1`,
      [orgId, contactId],
    );
    const runId = run.rows[0]?.id;
    if (runId)
      return { ok: false, refused: "in_sequence", runId: String(runId) };
  }
  const before = (
    await db.query(
      `select role_key, status, since::text as since, why from agent_assignments
        where org_id = $1 and contact_id = $2`,
      [orgId, contactId],
    )
  ).rows[0];
  const saved = await db.query(
    `insert into agent_assignments (org_id, contact_id, role_key, status, why)
     values ($1, $2, $3, $4, $5)
     on conflict (org_id, contact_id) do update
       set role_key = excluded.role_key, status = excluded.status, why = excluded.why, updated_at = now(),
           since = case when (agent_assignments.role_key, agent_assignments.status)
                             is distinct from (excluded.role_key, excluded.status)
                        then now() else agent_assignments.since end
     returning role_key, status, since::text as since, why`,
    [orgId, contactId, change.roleKey, change.status, change.why],
  );
  const assignment = asAssignment(saved.rows[0] ?? {});
  await audit(db, orgId, {
    actorType: change.actor.type,
    actorId: change.actor.id,
    action: "assignment.set",
    resourceType: "contact",
    resourceId: contactId,
    before: before && asAssignment(before),
    after: assignment,
  });
  return { ok: true, assignment };
}
