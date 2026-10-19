# Pattern: pg-boss job handler that sends (save the send, call the provider outside any transaction, save the answer)

A job can run more than once: pg-boss delivers it again after a crash, retries it after it throws, or the same send
is queued twice. A handler whose job calls an outside service must still send at most once. So it saves what it is
about to send before it calls the provider, under a key that is the same however often the job runs, and a run that
finds that key saved never sends again. The WhatsApp job is the example (`services/worker/src/handlers/send-wa.ts`;
the call job, `services/worker/src/handlers/place-call.ts`, has the same shape). The one way to send at most once
is `sendOnce` in `services/worker/src/sends.ts`.

First, one short transaction reloads the job's row (a job for another company finds nothing) and looks up the send
this job saved, if it did. A send saved before means the job ran before: never send again.

```ts
// services/worker/src/handlers/send-wa.ts
export async function handleSendWa(
  deps: SendWaDeps,
  job: SendWaJob,
): Promise<void> {
  const { orgId, runId, action } = job;
…
  const claim = await withOrg(deps.pool, orgId, async (tx) => {
    const reload = await tx.query(
      `select state from workflow_runs where id = $1 and org_id = $2 for update`,
      [runId, orgId],
    );
    const run = reload.rows[0];
    if (!run) return; // RLS-hidden (cross-tenant) or gone
…
    const key = sendKey("send_wa", job);
    const earlier = await findSend(tx, orgId, key);
…
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
```

Then the send goes through the channel's doorway, which runs the guardrail check first. The check and the saving of
the send share one short transaction, so a failure before the provider is called saves and sends nothing, and the
job may simply run again. Once saved, the provider is called with no transaction open. A provider call that throws
may still have reached the provider, so the lead is handed to a person instead of sending again; the provider's
answer is saved on its own, so nothing that follows can undo it:

```ts
// services/worker/src/sends.ts
  let saved = false;
  let answer: DoorwayResult;
  try {
    answer = await through(async (_ctx, action) => {
      const verdict = await withOrg(pool, orgId, async (tx) => {
        const v = await guard({ orgId, db: tx }, action);
        const blocked = v.ok ? null : v.reason;
        if (!(await saveSend(tx, orgId, send, blocked)))
          throw new SavedMeanwhile();
        return v;
      });
      saved = true;
      return verdict;
    });
  } catch (err) {
    if (err instanceof SavedMeanwhile) return;
    if (!saved) throw err; // nothing was saved, nothing sent: the job may run again
    await withOrg(pool, orgId, (tx) => handOver(tx, orgId, send, err));
    return;
  }
```

Last, what the send produced is recorded once, so a later run of the job finds it and records nothing more. The
`sender` handed to the doorway is the provider wrapped in its time limit (`services/worker/src/time-limits.ts`), so a
provider that never answers throws too, and its lead is handed to a person:

```ts
// services/worker/src/handlers/send-wa.ts
  const sent = await sendOnce(deps.pool, orgId, send, deps.guard, (guard) =>
    wa.send(
      { sender, guard },
…
  );
  if (sent && "sent" in sent) await record(deps, job, send, sent.sent);
```

Rules:
- Jobs carry ids only (`orgId`, `runId`, a `sendId`); the `pgboss` schema has no row-level security by design, so a
  handler re-enters `withOrg(pool, orgId, …)` (`packages/db/src/client.ts`) before it reads anything, and every query
  names the company.
- Reload the row first and do nothing when the job is stale or a duplicate: the row is gone or has moved on (a call's
  run waits for a newer call job), or its send is already saved.
- Send only through `sendOnce`: never call a provider any other way, and never retry a send. A job that keeps failing
  reaches its queue's dead letter (`services/worker/src/handlers/call-post.ts`), which hands the lead to a person.
- Every send goes through a doorway in `packages/channels`, which runs `guard()` first and, when it blocks, sends
  nothing and returns the reason.
- No transaction is open while the dialer or the WhatsApp provider answers: each step is its own short `withOrg`. The
  call job's outcome fold still runs the AI model inside its transaction, until Slice 1 · "A slow or stuck AI model,
  dialer or WhatsApp service can't freeze the worker…" moves it out.
- The handler stays small; the logic lives in `packages/harness`. Each queue is created, with its settings, in
  `services/worker/src/jobs.ts`, and the scheduler queues jobs with those settings (`enqueueJob` in
  `services/worker/src/scheduler.ts`).
