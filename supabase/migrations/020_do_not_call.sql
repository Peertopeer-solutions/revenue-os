-- 020 — a do-not-call block, once recorded, stays (ROADMAP.md, Slice 1). The block lives in the one place the guard
-- before every send reads it, contacts.consent -> 'dnc' (dncHook, packages/harness/src/policies.ts), and every way
-- of recording it (a call's AI reading, a person in the console, an imported list) only adds it
-- (recordDoNotCall, packages/db/src/consent.ts). Only the lead's own written YES may lift it, and Slice 2 builds
-- that (docs/decisions-in-force/2026-10-02-a-blocked-lead-is-unblocked-only-by-their-own-written-yes.md), so until
-- then this trigger refuses every change that would, from any login: a later list saying "no", a mistaken update,
-- a model's output. It adds a rule and changes no row, so it is safe to apply before the code that relies on it.
create function app.keep_do_not_call() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (old.consent -> 'dnc') = 'true'::jsonb and (new.consent -> 'dnc') is distinct from 'true'::jsonb then
    raise exception 'a do-not-call block is lifted only by the lead''s own written YES'
      using errcode = 'check_violation', table = tg_table_name, column = 'consent';
  end if;
  return new;
end $$;
-- Default grants reach these roles (migrations 002 and 010); a trigger fires without them.
revoke all on function app.keep_do_not_call() from public, anon, authenticated, service_role, app_service;

create trigger contacts_keep_do_not_call before update of consent on contacts
  for each row execute function app.keep_do_not_call();
