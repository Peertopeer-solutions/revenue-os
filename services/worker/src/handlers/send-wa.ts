// The send_wa job handler. A WhatsApp message is never blindly repeated: the job may run twice (delivered twice, or
// run again after it failed), but it sends at most once, and no database transaction is open while the provider
// answers. Every query also filters by the job's company. The scheduler already advanced the run past the whatsapp
// step, so what makes a run of this job stale is its saved send (src/sends.ts), never the run's step.
//   1. In one short transaction: lock the run (serializes runs of this job), MERGE run/contact vars into the step's
//      template vars (the doorway forwards vars as given, so send_wa must not go out empty; run/contact vars
//      OVERRIDE step vars on key collision) and look up this job's saved message. A message saved before means this
//      job ran before: never send again — complete its record when its answer was saved, or hand the lead to a person
//      when none was.
//   2. Send the message at most once (src/sends.ts sendOnce): guard() BEFORE the send (guardrails run before every
//      send) via the channels wa doorway (wa.send), the message saved with the guard's verdict; the send with no
//      transaction open; its answer saved. A blocking verdict => no send. A send that throws may still have reached
//      the provider, so the lead is handed to a person instead; the run's sequence goes on.
//   3. Record the outbound message + usage, once.
import type { GuardedAction, OrgCtx, Verdict } from "@harness/types";
import { type WaPayload, wa } from "@revenue-os/channels";
import { createTask, leadNumber, withOrg } from "@revenue-os/db";
import { emitUsage } from "@revenue-os/harness";
import type { Pool } from "pg";
import {
  findSend,
  handOver,
  type Send,
  type SendJob,
  sendKey,
  sendOnce,
} from "../sends";

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

export type SendWaJob = SendJob & {
  orgId: string;
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

  // 1. lock the run + read run/contact vars, MERGE them (run/contact vars WIN), and look up this job's saved message.
  const claim = await withOrg(deps.pool, orgId, async (tx) => {
    const reload = await tx.query(
      `select state from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    );
    const run = reload.rows[0];
    if (!run) return; // RLS-hidden (cross-tenant) or gone
    const state = (run.state ?? {}) as { vars?: Record<string, string> };
    const key = sendKey("send_wa", job);
    const earlier = await findSend(tx, orgId, key);
    const to = await leadNumber(tx, orgId, action.contactId, "whatsapp");
    if (!earlier && !to) {
      // No WhatsApp number (none on file, or the lead was deleted or merged): nothing is sent, and a person is handed
      // the lead with the reason, never a silent drop.
      await createTask(tx, orgId, {
        contactId: action.contactId,
        workflowRunId: runId,
        kind: "review",
        title: "WhatsApp message not sent — no WhatsApp number",
        payload: { reason: "no_whatsapp_number", template: action.template },
        actor: { type: "system" },
        once: `${key}:no-number`,
      });
      return;
    }
    const payload: WaPayload = {
      to: to ?? "", // a message saved before is never sent again: only a new one needs the number
      template: action.template,
      vars: { ...action.vars, ...(state.vars ?? {}) },
    };
    const send: Send = {
      key,
      channel: "whatsapp",
      contactId: action.contactId,
      runId,
      payload,
    };
    return { payload, send, earlier };
  });
  if (!claim) return;
  const { payload, send, earlier } = claim;
  if (earlier?.status === "sent" && earlier.providerRef)
    return record(deps, job, send, earlier.providerRef); // sent before; its record may still be missing
  if (earlier) {
    // saved before with no answer: hand over (once); blocked or handed over: nothing to do
    if (earlier.status === "sending")
      await withOrg(deps.pool, orgId, (tx) =>
        handOver(tx, orgId, send, new Error(UNANSWERED)),
      );
    return;
  }

  // 2. guard BEFORE the send; the message is saved with the guard's verdict, then sent with no transaction open.
  const sent = await sendOnce(deps.pool, orgId, send, deps.guard, (guard) =>
    wa.send(
      { sender: deps.sender, guard },
      { orgId },
      {
        contactId: action.contactId,
        autonomy: "auto",
        toolName: "send_wa",
        payload,
      },
    ),
  );
  if (sent && "sent" in sent) await record(deps, job, send, sent.sent);
  // blocked → no send; handed over, or another run of the job sends: nothing more
}

/** Why a run of the job hands the lead over when an earlier run saved the message but not the provider's answer. */
const UNANSWERED =
  "an earlier run of this job saved the message but not the provider's answer";

/**
 * 3. record the outbound message + usage, once: the usage row names the send (meta.sendKey), so a later run of the
 * job finds it and records nothing more, and the send's row is locked while it looks, so two runs never both record. The wamid is the outbound MESSAGE id, not a wa THREAD id — provider_ref
 * (unique per thread) stays NULL and the wamid rides the message's tool_call, so distinct sends never collide on
 * convo_provider_ref_uq.
 */
async function record(
  deps: SendWaDeps,
  job: SendWaJob,
  send: Send,
  providerRef: string,
): Promise<void> {
  const { orgId, runId, action } = job;
  await withOrg(deps.pool, orgId, async (tx) => {
    // the send locked first: two runs of the job recording it at once take turns, and the second finds the record
    await tx.query(
      `select 1 from sends where org_id = $1 and send_key = $2 for update`,
      [orgId, send.key],
    );
    const recorded = await tx.query(
      `select 1 from usage_events
        where org_id = $1 and kind = 'wa_message' and meta ->> 'sendKey' = $2 limit 1`,
      [orgId, send.key],
    );
    if (recorded.rowCount) return;
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
        JSON.stringify({ providerRef }),
      ],
    );
    await emitUsage({ orgId, db: tx } satisfies OrgCtx, {
      conversationId,
      kind: "wa_message",
      provider: "meta_wa",
      quantity: 1,
      unit: "messages",
      meta: { sendKey: send.key, template: action.template },
    });
  });
}
