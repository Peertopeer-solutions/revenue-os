// Transcript read path (transcript-UI task, S7.1) — org-scoped, RLS-gated read of a conversation's
// messages. A conversation the caller's org cannot see is invisible under RLS, so a missing
// conversation row returns null (the route maps that to 404 and never leaks existence); an
// owned-but-empty transcript is a valid empty array.
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import { ConversationIdSchema } from "@revenue-os/shared";
import type pg from "pg";
import { withOrg } from "./client";

export interface TranscriptRow {
  seq: number;
  role: string;
  content: string | null;
  ts: string;
}

export async function conversationMessages(
  pool: pg.Pool,
  orgId: string,
  conversationId: string,
): Promise<TranscriptRow[] | null> {
  const convoId = ConversationIdSchema.parse(conversationId); // S5.1 — boundary parse
  return withOrg(pool, orgId, async (tx) => {
    const convo = await tx.query("select id from conversations where id = $1", [
      convoId,
    ]);
    if (convo.rows.length === 0) return null; // RLS-invisible ⇒ route 404s
    const result = await tx.query(
      `select seq, role, content, ts::text as ts
         from messages where conversation_id = $1 order by seq`,
      [convoId],
    );
    return result.rows.map((row) => ({
      seq: row.seq,
      role: row.role,
      content: row.content ?? null,
      ts: row.ts,
    }));
  });
}

export interface ConversationRow {
  id: string;
  channel: string;
  status: string;
  direction: string;
  contact_name: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export async function listConversations(
  pool: pg.Pool,
  orgId: string,
): Promise<ConversationRow[]> {
  return withOrg(pool, orgId, async (tx) => {
    const result = await tx.query(
      `select c.id, c.channel, c.status, c.direction,
              nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as contact_name,
              c.started_at::text as started_at, c.ended_at::text as ended_at
         from conversations c
         left join contacts ct on ct.id = c.contact_id
        order by c.started_at desc nulls last
        limit 100`,
    );
    return result.rows;
  });
}
