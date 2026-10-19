-- 021 — every call and WhatsApp message the worker sends, saved before the provider is called (ROADMAP.md, Slice 1:
-- "A call or WhatsApp send is never blindly repeated"). A job can run twice: delivered twice, or run again after it
-- failed once the provider had already taken the send. The worker saves the send here first, under a key that is the
-- same however often its job runs, and a second run that finds the key never sends again: it goes on from the saved
-- result, or, when the provider's answer was never saved, hands the lead to a person (services/worker/src/sends.ts).
--
-- status:
--   sending  saved before the provider is called; it stays so until the provider's answer is saved
--   sent     the provider took it; provider_ref is its id there
--   blocked  the guardrail check before the send refused it, so nothing went out; reason names the check
--   unknown  the worker could not tell whether the provider took it, so it did not send again and handed the lead to a
--            person; reason says what happened
create table sends (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  send_key        text not null,                 -- '<job kind>:<run id>:<send id>', the same for every run of a job
  channel         app.channel not null,
  contact_id      uuid not null,
  workflow_run_id uuid,
  status          text not null default 'sending' check (status in ('sending', 'sent', 'blocked', 'unknown')),
  payload         jsonb not null default '{}',   -- what was about to be sent: the number, a template and its values
  provider_ref    text,
  reason          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint sends_org_id_send_key_key unique (org_id, send_key),
  constraint sends_contact_id_fkey foreign key (org_id, contact_id)
    references contacts (org_id, id) on delete cascade,
  constraint sends_workflow_run_id_fkey foreign key (org_id, workflow_run_id)
    references workflow_runs (org_id, id) on delete cascade
);
create index sends_contact on sends (org_id, contact_id, created_at desc);

-- sends: worker-owned writes (backend path), as workflow_runs; no delete, a send is history
alter table sends enable row level security;
create policy sel on sends for select
  using (org_id = app.current_org_id() and app.is_member(org_id, 'viewer'));
create policy ins on sends for insert
  with check (org_id = app.current_org_id() and app.is_member(org_id, 'operator'));
create policy upd on sends for update
  using (org_id = app.current_org_id() and app.is_member(org_id, 'operator'))
  with check (org_id = app.current_org_id());
