-- 026 — a role is rows, never code (ROADMAP.md: "A role is rows, never code"; docs/brain.md, part 2). Everything that
-- makes one role differ from another is a row of `agents`, a role version: its model, prompt (system_prompt), goal,
-- rules, the tools it may use (tools_allowed), the company-facts sections it reads and its test set. The engine reads
-- each of them from the version (packages/db/src/agents.ts, liveVersion), so a new role needs no change to the engine.
--
-- A version is a draft, tested or live ('active', the word the code already uses), then archived. Only a draft
-- changes; once tested, only its status may change, and a change is a new version. It is tested, and then put live,
-- only with a passing stored run of its whole test set: one run (eval_runs.set_run) whose rows cover every scenario
-- the set names, all passed, against exactly this version's content (eval_runs.agent_digest, stamped by the database
-- when the row is written, so a run of an earlier draft never counts). So "a live version never changes" and "nothing
-- goes live untested" hold whoever writes, enforced here rather than by care.
--
-- Which role works a lead is one row per lead, agent_assignments: active, paused, with a person or ended. A lead is
-- enrolled with a role or in a sequence, never both: the one enrolment function (startRun, services/worker/src/runs.ts)
-- refuses a lead whose assignment has not ended, and the assignment's one writer (setAssignment,
-- packages/db/src/assignments.ts) refuses a lead with an open run; each locks the lead's contacts row first, so two
-- at once can't both pass.
--
-- All additive: new columns with defaults, a wider status check, a new table. A row written before it keeps working.

-- What a version names beside its model, prompt and tools. `model` stays text: a `provider:model-id` from the platform's
-- model list (packages/shared/src/models.ts), which lives in code, so the engine refuses one off the list when it reads
-- the version. `rules` is checked by RoleRulesSchema (packages/shared/src/role.ts) on every read.
alter table agents
  add column goal text not null default '',
  add column rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  add column facts_sections text[] not null default '{}',
  add column test_set text[] not null default '{}',
  add column engine text not null default 'v1' check (engine in ('v1', 'brain'));
alter table agents
  drop constraint agents_status_check,
  add constraint agents_status_check check (status in ('draft', 'tested', 'active', 'archived'));

-- Which run of a version's whole test set a row belongs to, and the version content it ran against.
alter table eval_runs
  add column set_run uuid,
  add column agent_digest text;

-- A fingerprint of a version's content: every column but its status, its id included, so it names one row as it
-- stood. jsonb prints its keys in one order, so the same content always gives the same text.
create function app.agent_digest(a public.agents) returns text
language sql stable set search_path = '' as $$
  select md5((to_jsonb(a) - 'status')::text)
$$;

-- An eval run is stamped with the content of the version it ran against as it is written; an update keeps the stamp,
-- so no later change can make an old run look like a run of new content.
create function app.stamp_eval_run() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.agent_digest := old.agent_digest;
  else
    select app.agent_digest(a) into new.agent_digest from public.agents a where a.id = new.agent_id;
  end if;
  return new;
end $$;
create trigger eval_runs_stamp before insert or update on eval_runs
  for each row execute function app.stamp_eval_run();

-- Whether a version has a passing stored run of its whole test set: an empty set never passes.
create function app.version_passed(a public.agents) returns boolean
language sql stable security definer set search_path = '' as $$
  select cardinality(a.test_set) > 0 and exists (
    select 1
      from public.eval_runs r
      join public.eval_scenarios s on s.id = r.scenario_id
     where r.agent_id = a.id
       and r.set_run is not null
       and r.agent_digest = app.agent_digest(a)
     group by r.set_run
    having bool_and(r.passed) and array_agg(s.key) @> a.test_set)
$$;

-- The lifecycle: draft → tested → active (live) → archived, a draft or tested version may be archived, and nothing
-- goes back. A new version starts as a draft; a version that is not a draft changes only its status; tested and live
-- each need the passing run above.
create function app.agent_version_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'version % of % starts as a draft: it is tested, then put live, only once its test set passes',
        new.version, new.key
        using errcode = 'check_violation', constraint = tg_name, table = tg_table_name, column = 'status';
    end if;
    return new;
  end if;
  if old.status <> 'draft' and (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'version % of % is %: only its status may change, and a change is a new version',
      old.version, old.key, old.status
      using errcode = 'check_violation', constraint = tg_name, table = tg_table_name;
  end if;
  if new.status is distinct from old.status then
    if (old.status, new.status) not in (('draft', 'tested'), ('tested', 'active'), ('draft', 'archived'),
                                        ('tested', 'archived'), ('active', 'archived')) then
      raise exception 'version % of % can''t go from % to %', old.version, old.key, old.status, new.status
        using errcode = 'check_violation', constraint = tg_name, table = tg_table_name, column = 'status';
    end if;
    if new.status in ('tested', 'active') and not app.version_passed(new) then
      raise exception 'version % of % has no passing stored run of its whole test set (%), so it can''t be %',
        new.version, new.key, coalesce(nullif(array_to_string(new.test_set, ', '), ''), 'it names none'), new.status
        using errcode = 'check_violation', constraint = tg_name, table = tg_table_name, column = 'status';
    end if;
  end if;
  return new;
end $$;
create trigger agents_version_lifecycle before insert or update on agents
  for each row execute function app.agent_version_lifecycle();

-- Default grants reach these roles (migrations 002 and 010); a trigger fires without them.
revoke all on function app.agent_digest(public.agents) from public, anon, authenticated, service_role, app_service;
revoke all on function app.stamp_eval_run() from public, anon, authenticated, service_role, app_service;
revoke all on function app.version_passed(public.agents) from public, anon, authenticated, service_role, app_service;
revoke all on function app.agent_version_lifecycle() from public, anon, authenticated, service_role, app_service;

-- Which role works a lead: one row per lead. since: when this status began; why: what put it there.
create table agent_assignments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  contact_id uuid not null,
  role_key   text not null check (length(role_key) between 1 and 100),
  status     text not null default 'active' check (status in ('active', 'paused', 'with_person', 'ended')),
  since      timestamptz not null default now(),
  why        text not null check (length(btrim(why)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_assignments_org_id_contact_id_key unique (org_id, contact_id),
  constraint agent_assignments_contact_id_fkey foreign key (org_id, contact_id)
    references contacts (org_id, id) on delete cascade
);

-- agent_assignments: written by people in the console and by the worker, through setAssignment; no delete, a change
-- is an update (each one audited)
alter table agent_assignments enable row level security;
create policy sel on agent_assignments for select
  using (org_id = app.current_org_id() and app.is_member(org_id, 'viewer'));
create policy ins on agent_assignments for insert
  with check (org_id = app.current_org_id() and app.is_member(org_id, 'operator'));
create policy upd on agent_assignments for update
  using (org_id = app.current_org_id() and app.is_member(org_id, 'operator'))
  with check (org_id = app.current_org_id());
