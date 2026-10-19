-- 022 — a lead has at most one open thread per channel (ROADMAP.md, Slice 1: "Each conversation operation has one
-- authoritative implementation…: opening a conversation (start time set, the lead's open thread reused)"). A thread is
-- a lead's conversation with no call id: WhatsApp now, later SMS and email. A call is its own conversation under its
-- call id, so calls stay out of the key. openConversation (packages/db/src/conversations.ts) reuses the open thread
-- through this index.
--
-- Before the index, any lead with more than one open thread keeps its newest open and the rest are closed as canceled
-- (each WhatsApp send used to open a conversation of its own). Their messages stay where they are.
update conversations c
   set status = 'canceled', ended_at = coalesce(c.ended_at, now())
 where c.contact_id is not null and c.provider_ref is null and c.status in ('queued', 'ringing', 'active')
   and exists (
     select 1 from conversations n
      where n.org_id = c.org_id and n.contact_id = c.contact_id and n.channel = c.channel
        and n.provider_ref is null and n.status in ('queued', 'ringing', 'active')
        and (n.created_at, n.id) > (c.created_at, c.id));

create unique index convo_open_thread_uq on conversations (org_id, contact_id, channel)
  where contact_id is not null and provider_ref is null and status in ('queued', 'ringing', 'active');
