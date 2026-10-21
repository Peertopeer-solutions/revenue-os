// The run writer. Creates a workflow_run at the definition's entry step, schedulable at once
// (wake_at = now, status 'pending'). The scheduler tick (scheduler.ts) drives it from there. The
// only DB door is withOrg (docs/security.md, "Tenancy & identity"): one org-scoped tx. The sequence is the company's
// own or a shared template; another company's sequence is "not found". A lead already in the sequence (an open run:
// pending, running or waiting) is refused with AlreadyInSequenceError; migration 025's key makes that hold however
// close together two enrolments come. A lead a role works (an assignment that has not ended, migration 026) is refused
// with LeadHasRoleError: a lead is enrolled with a role or in a sequence, never both. The lead's row is locked first, as
// the assignment's one writer (setAssignment, packages/db/src/assignments.ts) locks it, so an enrolment and an
// assignment made at the same moment can't both pass.
import { lockLead, openAssignment, withOrg } from "@revenue-os/db";
import { WorkflowDefinitionSchema } from "@revenue-os/harness";
import type { Pool } from "pg";

/** A second enrolment of a lead whose run in the same sequence is still open. `runId` is that open run. */
export class AlreadyInSequenceError extends Error {
  constructor(
    readonly workflowId: string,
    readonly contactId: string,
    readonly runId: string,
  ) {
    super(
      `lead ${contactId} is already in sequence ${workflowId} (open run ${runId})`,
    );
    this.name = "AlreadyInSequenceError";
  }
}

/** An enrolment of a lead a role works: its assignment (`roleKey`, `status`) has not ended. */
export class LeadHasRoleError extends Error {
  constructor(
    readonly contactId: string,
    readonly roleKey: string,
    readonly status: string,
  ) {
    super(
      `lead ${contactId} is worked by the role ${roleKey} (${status}), so it can't be enrolled in a sequence too`,
    );
    this.name = "LeadHasRoleError";
  }
}

/** Input to startRun. `state` seeds the run's WorkflowState jsonb (contactId is always set
 *  from `contactId`; callers may add timezone / vars). */
export type StartRunInput = {
  workflowId: string;
  contactId: string;
  campaignId?: string;
  state?: Record<string, unknown>;
};

/**
 * Create a workflow_run at the definition's entry step: status 'pending', current_step =
 * definition.entry, state seeded { …caller state, contactId }, attempts = {} (the per-channel
 * timestamp arrays fill in on the first tick), wake_at = now() so the tick's due-selection can
 * pick it up. Returns the new run id. Runs inside one withOrg(orgId) tx. Throws AlreadyInSequenceError when the lead
 * already has an open run in this sequence, and LeadHasRoleError when a role works the lead.
 */
export async function startRun(
  pool: Pool,
  orgId: string,
  input: StartRunInput,
): Promise<string> {
  return withOrg(pool, orgId, async (tx) => {
    await lockLead(tx, orgId, input.contactId); // a lead the company doesn't have fails at the insert, as before
    const role = await openAssignment(tx, orgId, input.contactId);
    if (role)
      throw new LeadHasRoleError(input.contactId, role.roleKey, role.status);
    const wf = await tx.query<{ definition: unknown }>(
      `select definition from workflows where id = $1 and (org_id = $2 or org_id is null)`,
      [input.workflowId, orgId],
    );
    const wfRow = wf.rows[0];
    if (!wfRow) {
      throw new Error(`workflow not found: ${input.workflowId}`);
    }
    // The definition jsonb is a boundary — validate it before we trust definition.entry.
    const def = WorkflowDefinitionSchema.parse(wfRow.definition);
    const state = { ...input.state, contactId: input.contactId };

    const r = await tx.query<{ id: string }>(
      `insert into workflow_runs
         (org_id, workflow_id, campaign_id, contact_id, status, current_step, state, wake_at, attempts)
       values ($1, $2, $3, $4, 'pending', $5, $6::jsonb, now(), '{}'::jsonb)
       on conflict (org_id, workflow_id, contact_id) where status in ('pending', 'running', 'waiting')
         do nothing
       returning id`,
      [
        orgId,
        input.workflowId,
        input.campaignId ?? null,
        input.contactId,
        def.entry,
        JSON.stringify(state),
      ],
    );
    const runRow = r.rows[0];
    if (runRow) return runRow.id;
    const open = await tx.query<{ id: string }>(
      `select id from workflow_runs
        where org_id = $1 and workflow_id = $2 and contact_id = $3
          and status in ('pending', 'running', 'waiting')`,
      [orgId, input.workflowId, input.contactId],
    );
    throw new AlreadyInSequenceError(
      input.workflowId,
      input.contactId,
      open.rows[0]?.id ?? "unknown",
    );
  });
}
