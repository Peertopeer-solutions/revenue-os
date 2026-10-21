-- 025 — a lead can be in the same sequence only once at a time (ROADMAP.md, Slice 1). A run is open while its
-- status is pending, running or waiting; completed, failed and canceled runs have ended. This key lets a company hold
-- at most one open run per lead and sequence, so a lead enrolled twice is never messaged or called twice by the same
-- sequence, whoever enrols them and however close together. Once that run has ended, the lead may be enrolled again.
-- Enrolment (startRun, services/worker/src/runs.ts) refuses a second open run with a clear error.
--
-- A database that already holds two open runs for one lead and sequence keeps the newest open and cancels the older
-- ones, naming why in last_error, so the key can be built; runs are history and are never deleted.
update workflow_runs r
   set status = 'canceled',
       last_error = 'canceled by migration 025: the lead had a newer open run in the same sequence',
       completed_at = coalesce(r.completed_at, now()),
       updated_at = now()
 where r.status in ('pending', 'running', 'waiting')
   and exists (
     select 1 from workflow_runs n
      where n.org_id = r.org_id
        and n.workflow_id = r.workflow_id
        and n.contact_id = r.contact_id
        and n.status in ('pending', 'running', 'waiting')
        and (n.created_at, n.id) > (r.created_at, r.id)
   );

create unique index workflow_runs_one_open_per_sequence
  on workflow_runs (org_id, workflow_id, contact_id)
  where status in ('pending', 'running', 'waiting');
