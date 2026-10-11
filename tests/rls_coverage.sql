-- Gate fails (psql exit 3 with ON_ERROR_STOP=1) if any public table lacks RLS (docs/security.md S1.1).
-- A bare SELECT always exits 0 no matter how many offenders it lists — that shape was verification theater.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if offenders is not null then
    raise exception 'RLS disabled on: %', offenders;
  end if;

  raise notice 'rls_coverage: 0 offenders';
end $$;

-- Gate fails if a record could point at, or collide with, another company's (ROADMAP.md, Slice 1; migration 019
-- shows how to keep each in one company). A company table is a public table with an org_id column. It fails:
--   1. a company table whose org_id may be empty, but the shared templates' (agents, workflows, eval_scenarios,
--      AGENTS.md hard rail 3): a link from a row with no company is never checked;
--   2. a link (foreign key) between two company tables that doesn't pair org_id with org_id, unless it points at a
--      shared-template table and app.same_company_or_template guards its column on every insert and update;
--   3. a duplicate-protection key (a unique index, or a primary key other than id) on a company table that leaves
--      org_id out, or on a shared-template table lets two templates share it. api_keys.key_hash stays unique across
--      companies: it is how a request's key finds its company.
do $$
declare
  offenders text;
begin
  with company as (
    select c.oid, c.relname, a.attnum as org, a.attnotnull as required,
           c.relname in ('agents', 'workflows', 'eval_scenarios') as shared
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  ),
  link as (
    select ch.oid as child_oid, ch.relname as child, pa.relname as parent, ch.required, pa.shared, con.conkey,
           exists (select 1 from unnest(con.conkey, con.confkey) k(c, p) where k.c = ch.org and k.p = pa.org) as paired
    from pg_constraint con
    join company ch on ch.oid = con.conrelid
    join company pa on pa.oid = con.confrelid
    where con.contype = 'f'
  ),
  keys as (
    select c.relname, c.shared, i.indisprimary as primary_key, i.indnullsnotdistinct as templates_alike,
           c.org = any (i.indkey::int2[]) as has_org,
           (select string_agg(a.attname, ', ' order by k.ord)
              from unnest(i.indkey::int2[]) with ordinality k(n, ord)
              join pg_attribute a on a.attrelid = c.oid and a.attnum = k.n) as cols
    from company c
    join pg_index i on i.indrelid = c.oid and i.indisunique
  ),
  offender as (
    select format('%s.org_id may be empty', relname) as what from company where not required and not shared
    union all
    select format('%s.%s → %s', l.child, a.attname, l.parent)
    from link l
    join pg_attribute a on a.attrelid = l.child_oid and a.attnum = any (l.conkey) and a.attname <> 'org_id'
    where not l.required or (not l.paired and not (l.shared and cardinality(l.conkey) = 1 and exists (
      select 1 from pg_trigger t
      where t.tgrelid = l.child_oid
        and t.tgfoid = 'app.same_company_or_template()'::regprocedure
        and t.tgenabled <> 'D'
        and (t.tgtype & 21) = 21 -- for each row, on insert and on update
        and t.tgattr::text = '' -- on every update, whichever columns it sets
        and encode(t.tgargs, 'escape') = a.attname || '\000' || l.parent || '\000')))
    union all
    select format('%s (%s)', relname, cols) from keys
    where not (primary_key and cols = 'id')
      and not (relname = 'api_keys' and cols = 'key_hash')
      and (not has_org or (shared and not templates_alike))
  )
  select string_agg(what, '; ' order by what) into offenders from offender;

  if offenders is not null then
    raise exception 'records that could cross companies: %', offenders;
  end if;

  raise notice 'company_links: 0 offenders';
end $$;
