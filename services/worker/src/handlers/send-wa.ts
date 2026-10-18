// The send_wa job handler. A WhatsApp message is never blindly repeated: the job may run twice (delivered twice, or
// run again after it failed), but it sends at most once, and no database transaction is open while the provider
// answers. Every query also filters by the job's company. The scheduler already advanced the run past the whatsapp
// step, so what makes a run of this job stale is its saved send (src/sends.ts), never the run's step.
//   1. In one short transaction: lock the run (serializes runs of this job), MERGE run/contact vars into the step's
//      template vars (the doorway forwards vars as given, so send_wa must not go out empty; run/contact vars
//      OVERRIDE step vars on key collision) and save the message about to be sent. A send saved before means this
//      job ran before: never send again; when no answer was saved, hand the lead to a person.
//   2. guard() BEFORE the send (guardrails run before every send) via the channels wa doorway (wa.send), with the
//      guard in a short transaction of its own. A blocking verdict => no send; the send is saved as blocked.
//   3. Save the provider's answer with the outbound message + usage. A send that throws may still have reached the
//      provider, so the lead is handed to a person instead; the run's sequence goes on.
import type { GuardedAction, OrgCtx, Verdict } from "@harness/types";
import { type DoorwayResult, type WaPayload, wa } from "@revenue-os/channels";
import { withOrg } from "@revenue-os/db";
import { emitUsage } from "@revenue-os/harness";
import type { Pool, PoolClient } from "pg";
import {
  handOver,
  type Send,
  type SendJob,
  saveSend,
  sendKey,
  settleSend,
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
  const send: Send = {
    key: sendKey("send_wa", job),
    channel: "whatsapp",
    contactId: action.contactId,
    runId,
    payload: {},
  };

  // 1. lock the run (serializes runs of this job) + read run/contact vars, MERGE them (run/contact vars WIN), and
  //    save the message about to be sent. A send saved before means this job ran before: never send again.
  const claim = await withOrg(deps.pool, orgId, async (tx) => {
    const reload = await tx.query(
      `select state from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    );
    const run = reload.rows[0];
    if (!run) return; // RLS-hidden (cross-tenant) or gone
    const state = (run.state ?? {}) as { vars?: Record<string, string> };
    const payload: WaPayload = {
      to: await resolveTo(tx, orgId, action.contactId),
      template: action.template,
      vars: { ...action.vars, ...(state.vars ?? {}) },
    };
    send.payload = payload;
    return { payload, earlier: await saveSend(tx, orgId, send) };
  });
  if (!claim) return;
  if (claim.earlier) {
    // sent before: done; saved before with no answer: hand over (once); blocked or handed over: nothing to do
    if (claim.earlier.status === "sending")
      await withOrg(deps.pool, orgId, (tx) =>
        handOver(tx, orgId, send, new Error(UNANSWERED)),
      );
    return;
  }

  // 2. guard BEFORE the send, the guard in a short transaction of its own; no transaction is open while it sends.
  let sent: DoorwayResult;
  try {
    sent = await wa.send(
      {
        sender: deps.sender,
        guard: (_ctx, a) =>
          withOrg(deps.pool, orgId, (tx) => deps.guard({ orgId, db: tx }, a)),
      },
      { orgId },
      {
        contactId: action.contactId,
        autonomy: "auto",
        toolName: "send_wa",
        payload: claim.payload,
      },
    );
  } catch (err) {
    // the provider may have taken the message: never send again; a person checks.
    await withOrg(deps.pool, orgId, (tx) => handOver(tx, orgId, send, err));
    return;
  }
  if (!sent.ok) {
    const { reason } = sent;
    await withOrg(deps.pool, orgId, (tx) =>
      settleSend(tx, orgId, send.key, { blocked: reason }),
    );
    return; // blocked → no send
  }

  // 3. save the provider's answer with the outbound message + usage. The wamid is the outbound MESSAGE id, not a wa
  // THREAD id — provider_ref (unique per thread) stays NULL and the wamid rides the message's tool_call, so distinct
  // sends never collide on convo_provider_ref_uq.
  const { providerRef } = sent.result;
  await withOrg(deps.pool, orgId, async (tx) => {
    await settleSend(tx, orgId, send.key, { sent: providerRef });
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

/** Why a run of the job hands the lead over when an earlier run saved the message but not the provider's answer. */
const UNANSWERED =
  "an earlier run of this job saved the message but not the provider's answer";

/** Resolve the company's contact's WhatsApp destination (E.164), primary first. */
async function resolveTo(
  tx: PoolClient,
  orgId: string,
  contactId: string,
): Promise<string> {
  const r = await tx.query(
    `select value from contact_identities
      where org_id = $1 and contact_id = $2 and kind = 'whatsapp'
      order by is_primary desc, created_at asc limit 1`,
    [orgId, contactId],
  );
  return (r.rows[0]?.value as string) ?? "";
}
