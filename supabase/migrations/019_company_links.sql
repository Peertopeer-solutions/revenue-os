-- 019 — every link between company records stays inside one company, and every duplicate-protection key and call
-- id is kept per company (ROADMAP.md, Slice 1). Before this, each of the 43 links checked only that the record it
-- points at exists, so a bug could attach company A's site visit to company B's lead; a provider's event id and
-- call id were unique across all companies, so company B's event was dropped as company A's duplicate, or filed on
-- company A's conversation. tests/rls_coverage.sql fails any new link or key that could cross companies again.
--
-- One step, not expand then contract: no deployed worker uses the keys this replaces (the worker runs only by hand
-- until Slice 2 builds the tested deploy; STATE.md → Decisions in force).

-- A link from a record whose company may be empty is never checked, so only shared templates may have none
-- (AGENTS.md hard rail 3). Every row has one already: row-level security lets no role write one without.
alter table webhook_events alter column org_id set not null;
alter table eval_runs alter column org_id set not null;

-- The (company, id) key each link below points at.
alter table companies add constraint companies_org_id_id_key unique (org_id, id);
alter table contacts add constraint contacts_org_id_id_key unique (org_id, id);
alter table pipelines add constraint pipelines_org_id_id_key unique (org_id, id);
alter table pipeline_stages add constraint pipeline_stages_org_id_id_key unique (org_id, id);
alter table deals add constraint deals_org_id_id_key unique (org_id, id);
alter table dispositions add constraint dispositions_org_id_id_key unique (org_id, id);
alter table campaigns add constraint campaigns_org_id_id_key unique (org_id, id);
alter table workflow_runs add constraint workflow_runs_org_id_id_key unique (org_id, id);
alter table conversations add constraint conversations_org_id_id_key unique (org_id, id);
alter table appointments add constraint appointments_org_id_id_key unique (org_id, id);
alter table contact_memories add constraint contact_memories_org_id_id_key unique (org_id, id);
alter table knowledge_documents add constraint knowledge_documents_org_id_id_key unique (org_id, id);

-- 36 links: each now names the company with the record, so the record it points at must be the same company's.
-- Names and delete rules stay as they were.
alter table contacts
  drop constraint contacts_company_id_fkey,
  add constraint contacts_company_id_fkey foreign key (org_id, company_id) references companies (org_id, id),
  drop constraint contacts_merged_into_id_fkey,
  add constraint contacts_merged_into_id_fkey foreign key (org_id, merged_into_id) references contacts (org_id, id);
alter table contact_identities
  drop constraint contact_identities_contact_id_fkey,
  add constraint contact_identities_contact_id_fkey foreign key (org_id, contact_id)
    references contacts (org_id, id) on delete cascade;
alter table pipeline_stages
  drop constraint pipeline_stages_pipeline_id_fkey,
  add constraint pipeline_stages_pipeline_id_fkey foreign key (org_id, pipeline_id)
    references pipelines (org_id, id) on delete cascade;
alter table deals
  drop constraint deals_company_id_fkey,
  add constraint deals_company_id_fkey foreign key (org_id, company_id) references companies (org_id, id),
  drop constraint deals_contact_id_fkey,
  add constraint deals_contact_id_fkey foreign key (org_id, contact_id) references contacts (org_id, id),
  drop constraint deals_pipeline_id_fkey,
  add constraint deals_pipeline_id_fkey foreign key (org_id, pipeline_id) references pipelines (org_id, id),
  drop constraint deals_stage_id_fkey,
  add constraint deals_stage_id_fkey foreign key (org_id, stage_id) references pipeline_stages (org_id, id);
alter table conversations
  drop constraint conversations_contact_id_fkey,
  add constraint conversations_contact_id_fkey foreign key (org_id, contact_id) references contacts (org_id, id),
  drop constraint convo_campaign_fk,
  add constraint convo_campaign_fk foreign key (org_id, campaign_id) references campaigns (org_id, id),
  drop constraint convo_disposition_fk,
  add constraint convo_disposition_fk foreign key (org_id, disposition_id) references dispositions (org_id, id),
  drop constraint convo_run_fk,
  add constraint convo_run_fk foreign key (org_id, workflow_run_id) references workflow_runs (org_id, id);
alter table messages
  drop constraint messages_conversation_id_fkey,
  add constraint messages_conversation_id_fkey foreign key (org_id, conversation_id)
    references conversations (org_id, id) on delete cascade;
alter table appointments
  drop constraint appointments_contact_id_fkey,
  add constraint appointments_contact_id_fkey foreign key (org_id, contact_id) references contacts (org_id, id),
  drop constraint appointments_deal_id_fkey,
  add constraint appointments_deal_id_fkey foreign key (org_id, deal_id) references deals (org_id, id);
alter table outcomes
  drop constraint outcome_campaign_fk,
  add constraint outcome_campaign_fk foreign key (org_id, campaign_id) references campaigns (org_id, id),
  drop constraint outcome_run_fk,
  add constraint outcome_run_fk foreign key (org_id, workflow_run_id) references workflow_runs (org_id, id),
  drop constraint outcomes_appointment_id_fkey,
  add constraint outcomes_appointment_id_fkey foreign key (org_id, appointment_id)
    references appointments (org_id, id),
  drop constraint outcomes_contact_id_fkey,
  add constraint outcomes_contact_id_fkey foreign key (org_id, contact_id) references contacts (org_id, id),
  drop constraint outcomes_conversation_id_fkey,
  add constraint outcomes_conversation_id_fkey foreign key (org_id, conversation_id)
    references conversations (org_id, id),
  drop constraint outcomes_deal_id_fkey,
  add constraint outcomes_deal_id_fkey foreign key (org_id, deal_id) references deals (org_id, id);
alter table workflow_runs
  drop constraint workflow_runs_campaign_id_fkey,
  add constraint workflow_runs_campaign_id_fkey foreign key (org_id, campaign_id) references campaigns (org_id, id),
  drop constraint workflow_runs_contact_id_fkey,
  add constraint workflow_runs_contact_id_fkey foreign key (org_id, contact_id) references contacts (org_id, id);
alter table tasks
  drop constraint tasks_contact_id_fkey,
  add constraint tasks_contact_id_fkey foreign key (org_id, contact_id) references contacts (org_id, id),
  drop constraint tasks_conversation_id_fkey,
  add constraint tasks_conversation_id_fkey foreign key (org_id, conversation_id)
    references conversations (org_id, id),
  drop constraint tasks_deal_id_fkey,
  add constraint tasks_deal_id_fkey foreign key (org_id, deal_id) references deals (org_id, id),
  drop constraint tasks_workflow_run_id_fkey,
  add constraint tasks_workflow_run_id_fkey foreign key (org_id, workflow_run_id)
    references workflow_runs (org_id, id);
alter table contact_memories
  drop constraint contact_memories_contact_id_fkey,
  add constraint contact_memories_contact_id_fkey foreign key (org_id, contact_id)
    references contacts (org_id, id) on delete cascade,
  drop constraint contact_memories_source_conversation_id_fkey,
  add constraint contact_memories_source_conversation_id_fkey foreign key (org_id, source_conversation_id)
    references conversations (org_id, id),
  drop constraint contact_memories_superseded_by_fkey,
  add constraint contact_memories_superseded_by_fkey foreign key (org_id, superseded_by)
    references contact_memories (org_id, id);
alter table knowledge_chunks
  drop constraint knowledge_chunks_document_id_fkey,
  add constraint knowledge_chunks_document_id_fkey foreign key (org_id, document_id)
    references knowledge_documents (org_id, id) on delete cascade;
alter table contact_scores
  drop constraint contact_scores_contact_id_fkey,
  add constraint contact_scores_contact_id_fkey foreign key (org_id, contact_id)
    references contacts (org_id, id) on delete cascade;
alter table usage_events
  drop constraint usage_events_conversation_id_fkey,
  add constraint usage_events_conversation_id_fkey foreign key (org_id, conversation_id)
    references conversations (org_id, id);
alter table eval_runs
  drop constraint eval_runs_transcript_ref_fkey,
  add constraint eval_runs_transcript_ref_fkey foreign key (org_id, transcript_ref)
    references conversations (org_id, id);
alter table prospect_candidates
  drop constraint prospect_candidates_duplicate_of_contact_fkey,
  add constraint prospect_candidates_duplicate_of_contact_fkey foreign key (org_id, duplicate_of_contact)
    references contacts (org_id, id),
  drop constraint prospect_candidates_promoted_contact_id_fkey,
  add constraint prospect_candidates_promoted_contact_id_fkey foreign key (org_id, promoted_contact_id)
    references contacts (org_id, id);

-- The other 7 links point at a table that also holds shared templates (agents, workflows, eval scenarios with no
-- company), which a key naming the company can't match. Each keeps its plain link, so the record must exist, and
-- this trigger refuses a record of another company. Its arguments: the linking column and the table it points at.
-- It reads that row whatever row-level security would show (security definer), as a hidden row is exactly another
-- company's. No API role can move a row to another company (each update policy checks the company after), and the
-- row is locked against change until the linking transaction ends.
create function app.same_company_or_template() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  link text := tg_argv[0];
  target uuid := (to_jsonb(new) ->> link)::uuid;
  owner uuid;
begin
  if target is null or (tg_op = 'UPDATE'
      and target is not distinct from (to_jsonb(old) ->> link)::uuid and new.org_id = old.org_id) then
    return null;
  end if;
  execute format('select org_id from public.%I where id = $1 for share', tg_argv[1]) into owner using target;
  if owner is not null and owner <> new.org_id then
    raise exception '%.% points at another company''s %', tg_table_name, link, tg_argv[1]
      using errcode = 'foreign_key_violation', constraint = tg_name, table = tg_table_name, column = link;
  end if;
  return null;
end $$;
-- Default grants reach these roles (migrations 002 and 010); a trigger fires without them.
revoke all on function app.same_company_or_template() from public, anon, authenticated, service_role, app_service;

create trigger conversations_agent_id_same_company after insert or update on conversations
  for each row execute function app.same_company_or_template('agent_id', 'agents');
create trigger campaigns_agent_id_same_company after insert or update on campaigns
  for each row execute function app.same_company_or_template('agent_id', 'agents');
create trigger campaigns_workflow_id_same_company after insert or update on campaigns
  for each row execute function app.same_company_or_template('workflow_id', 'workflows');
create trigger workflow_runs_workflow_id_same_company after insert or update on workflow_runs
  for each row execute function app.same_company_or_template('workflow_id', 'workflows');
create trigger eval_runs_agent_id_same_company after insert or update on eval_runs
  for each row execute function app.same_company_or_template('agent_id', 'agents');
create trigger eval_runs_workflow_id_same_company after insert or update on eval_runs
  for each row execute function app.same_company_or_template('workflow_id', 'workflows');
create trigger eval_runs_scenario_id_same_company after insert or update on eval_runs
  for each row execute function app.same_company_or_template('scenario_id', 'eval_scenarios');

-- Duplicate-protection keys, per company. A call id (conversations.provider_ref) and a provider's event id
-- (webhook_events.dedupe_key) are the provider's, so two companies can be sent the same one.
drop index convo_provider_ref_uq;
create unique index convo_provider_ref_uq on conversations (org_id, provider, provider_ref)
  where provider_ref is not null;
drop index convo_provider; -- every lookup by call id names the company, and the key above serves it
alter table webhook_events
  drop constraint webhook_events_dedupe_key_key,
  add constraint webhook_events_org_id_provider_dedupe_key_key unique (org_id, provider, dedupe_key);
-- These three were per company already through their parent; naming the company keeps every key alike.
alter table messages
  drop constraint messages_conversation_id_seq_key,
  add constraint messages_org_id_conversation_id_seq_key unique (org_id, conversation_id, seq);
drop index messages_org_convo; -- the same columns as the key above
alter table pipeline_stages
  drop constraint pipeline_stages_pipeline_id_key_key,
  add constraint pipeline_stages_org_id_pipeline_id_key_key unique (org_id, pipeline_id, key);
alter table knowledge_chunks
  drop constraint knowledge_chunks_document_id_chunk_index_key,
  add constraint knowledge_chunks_org_id_document_id_chunk_index_key unique (org_id, document_id, chunk_index);
-- Shared templates have no company, and two empty companies counted as different, so two templates could share a
-- key and version. Now they can't.
alter table agents
  drop constraint agents_org_id_key_version_key,
  add constraint agents_org_id_key_version_key unique nulls not distinct (org_id, key, version);
alter table workflows
  drop constraint workflows_org_id_key_version_key,
  add constraint workflows_org_id_key_version_key unique nulls not distinct (org_id, key, version);
alter table eval_scenarios
  drop constraint eval_scenarios_org_id_key_key,
  add constraint eval_scenarios_org_id_key_key unique nulls not distinct (org_id, key);
-- api_keys.key_hash stays unique across companies: it is how a request's key finds its company.
