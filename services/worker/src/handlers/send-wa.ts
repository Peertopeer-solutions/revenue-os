// The send_wa job handler. In ONE withOrg(orgId) tx, with every query also filtered by the job's company:
//   1. reload the run FOR UPDATE (serializes re-deliveries + reads run/contact vars); NO-OP if
//      this send was ALREADY delivered. The scheduler already advanced the run past the whatsapp
//      step, so staleness is a DURABLE marker (a wa_message usage row keyed by a deterministic fn
//      of the job) — NOT the run step. Exactly-once against a re-delivery.
//   2. guard() BEFORE the send (guardrails run before every send) via the channels wa doorway
//      (wa.send).
//   3. MERGE run/contact vars into the step's template vars (the doorway forwards vars as given, so
//      send_wa must not go out empty) — run/contact vars OVERRIDE step vars on key collision — then
//      send; record the outbound message + usage (the usage row is the durable exactly-once marker).
import type { GuardedAction, OrgCtx, Verdict } from "@harness/types";
import { wa } from "@revenue-os/channels";
import { createTask, leadNumber, withOrg } from "@revenue-os/db";
import { emitUsage } from "@revenue-os/harness";
import type { Pool } from "pg";

/** WhatsApp sender port — structural superset of channels' WaSender (local, no channels dep). */
export type WaSenderPort = {
  send(payload: {
    to: string;
    template: string;
    vars: Record<string, string>;
  }): Promise<{ providerRef: string }>;
};

export type WaGuardPort = (
  ctx: OrgCtx,
  action: GuardedAction,
) => Promise<Verdict>;

export type SendWaDeps = {
  pool: Pool;
  guard: WaGuardPort;
  sender: WaSenderPort;
  now?: () => Date;
};

export type SendWaJob = {
  orgId: string;
  runId: string;
  /** Per-send identity from the scheduler (its singleton_key is `<runId>:<step>:<idx>`). Optional
   *  because jobs enqueued before this field existed are still in flight: those fall back to the
   *  old per-template key, which is exactly-once for the only sends they can represent. */
  step?: string;
  idx?: number;
  action: {
    kind: "send_wa";
    contactId: string;
    template: string;
    vars: Record<string, string>;
  };
};

export async function handleSendWa(
  deps: SendWaDeps,
  job: SendWaJob,
): Promise<void> {
  const { orgId, runId, action } = job;

  await withOrg(deps.pool, orgId, async (tx) => {
    const ctx: OrgCtx = { orgId, db: tx };

    // 1. lock the run (serializes re-deliveries) + read run/contact vars; NO-OP if delivered.
    const reload = await tx.query(
      `select state from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    );
    const run = reload.rows[0];
    if (!run) return; // RLS-hidden (cross-tenant) or gone
    const state = (run.state ?? {}) as { vars?: Record<string, string> };

    // Identify the SEND, not the template: a reminder cadence reuses one template across steps,
    // and a template-keyed marker would silently swallow every send after the first.
    const sendKey =
      job.step === undefined ? action.template : `${job.step}:${job.idx ?? 0}`;
    const dedupeKey = `send_wa:${runId}:${sendKey}`;
    const seen = await tx.query(
      `select 1 from usage_events
        where org_id = $1 and kind = 'wa_message' and meta ->> 'dedupeKey' = $2 limit 1`,
      [orgId, dedupeKey],
    );
    if ((seen.rowCount ?? 0) > 0) return; // already delivered — exactly-once

    // 2 + 3. MERGE (run/contact vars WIN) then guard BEFORE the send.
    const vars = { ...action.vars, ...(state.vars ?? {}) };
    const to = await leadNumber(tx, orgId, action.contactId, "whatsapp");
    if (!to) {
      // No WhatsApp number (none on file, or the lead was deleted or merged): nothing is sent, and a person is handed
      // the lead with the reason, never a silent drop.
      await createTask(tx, orgId, {
        contactId: action.contactId,
        workflowRunId: runId,
        kind: "review",
        title: "WhatsApp message not sent — no WhatsApp number",
        payload: { reason: "no_whatsapp_number", template: action.template },
        actor: { type: "system" },
        once: `${dedupeKey}:no-number`,
      });
      return;
    }
    const doorway = await wa.send(
      { sender: deps.sender, guard: deps.guard },
      ctx,
      {
        contactId: action.contactId,
        autonomy: "auto",
        toolName: "send_wa",
        payload: { to, template: action.template, vars },
      },
    );
    if (!doorway.ok) return; // blocked → no send

    // record the outbound message + usage (usage = the durable exactly-once marker). The wamid is
    // the outbound MESSAGE id, not a wa THREAD id — provider_ref (unique per thread) stays NULL and
    // the wamid rides the message's tool_call, so distinct sends never collide on convo_provider_ref_uq.
    const convo = await tx.query(
      `insert into conversations
         (org_id, contact_id, workflow_run_id, channel, direction, status, provider)
       values ($1, $2, $3, 'whatsapp', 'outbound', 'active', 'meta_wa') returning id`,
      [orgId, action.contactId, runId],
    );
    const conversationId = convo.rows[0]?.id as string;
    await tx.query(
      `insert into messages (org_id, conversation_id, seq, role, content, tool_call)
       values ($1, $2, 1, 'agent', $3, $4::jsonb)`,
      [
        orgId,
        conversationId,
        `template:${action.template}`,
        JSON.stringify({ providerRef: doorway.result.providerRef }),
      ],
    );
    await emitUsage(ctx, {
      conversationId,
      kind: "wa_message",
      provider: "meta_wa",
      quantity: 1,
      unit: "messages",
      meta: { dedupeKey, template: action.template },
    });
  });
}
