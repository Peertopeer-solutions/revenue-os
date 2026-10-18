# Pattern: pg-boss job handler that sends (save the send, call the provider outside any transaction, save the answer)

A job can run more than once: pg-boss delivers it again after a crash, retries it after it throws, or the same send
is queued twice. A handler whose job calls an outside service must still send at most once. So it saves what it is
about to send before it calls the provider, under a key that is the same however often the job runs, and a run that
finds that key saved never sends again. The WhatsApp job is the example (`services/worker/src/handlers/send-wa.ts`;
the call job, `services/worker/src/handlers/place-call.ts`, has the same shape, and the send record is
`services/worker/src/sends.ts`).

First, one short transaction reloads the job's row (a job for another company finds nothing) and saves the send:

```ts
// services/worker/src/handlers/send-wa.ts
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
…
  const claim = await withOrg(deps.pool, orgId, async (tx) => {
    const reload = await tx.query(
      `select state from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    );
    const run = reload.rows[0];
    if (!run) return; // RLS-hidden (cross-tenant) or gone
…
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
```

Then the send goes through the channel's doorway, which runs the guardrail check first; the check gets a short
transaction of its own, so no transaction is open while the provider answers. A send that throws may still have
reached the provider, so the lead is handed to a person instead of sending again; a refusal is saved with its reason:

```ts
// services/worker/src/handlers/send-wa.ts
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
```

Last, one transaction saves the provider's answer with what the send produced, so the send is either fully
recorded or still `sending`, which a later run hands to a person:

```ts
// services/worker/src/handlers/send-wa.ts
  const { providerRef } = sent.result;
  await withOrg(deps.pool, orgId, async (tx) => {
    await settleSend(tx, orgId, send.key, { sent: providerRef });
…
  });
}
```

Rules:
- Jobs carry ids only (`orgId`, `runId`, a `sendId`); the `pgboss` schema has no row-level security by design, so a
  handler re-enters `withOrg(pool, orgId, …)` (`packages/db/src/client.ts`) before it reads anything, and every query
  names the company.
- Reload the row first and do nothing when the job is stale or a duplicate: the row is gone or has moved on, or its
  send is already saved.
- Save the send before the provider is called (`saveSend`), and never send again for a key already saved: go on from
  its saved answer, or hand the lead to a person (`handOver`) when no answer was saved. Never retry a send.
- Every send goes through a doorway in `packages/channels`, which runs `guard()` first and, when it blocks, sends
  nothing and returns the reason.
- No transaction is open while an outside service answers: each step is its own short `withOrg`.
- The handler stays small; the logic lives in `packages/harness`. Each queue is created, with its settings, in
  `services/worker/src/jobs.ts`, and the scheduler queues jobs with those settings (`enqueueJob` in
  `services/worker/src/scheduler.ts`).
