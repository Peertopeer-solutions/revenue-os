// The dashboard's numbers: the company's 30-day funnel tiles and the daily series behind them.
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import type pg from "pg";
import { withOrg } from "./client";

export interface FunnelMetrics {
  new_leads: number;
  conversations_started: number;
  conversations_completed: number;
  qualified: number;
  bookings: number;
  open_tasks: number;
}

export async function funnelMetrics(
  pool: pg.Pool,
  orgId: string,
): Promise<FunnelMetrics> {
  return withOrg(pool, orgId, async (tx) => {
    // Sequential — one PoolClient can only run one query at a time (Promise.all here would
    // interleave on the same connection, which pg deprecation-warns on and can misbehave).
    const newLeads = await tx.query(
      `select count(*)::int as n from contacts
        where org_id = $1 and deleted_at is null and created_at >= now() - interval '30 days'`,
      [orgId],
    );
    const conversationsStarted = await tx.query(
      `select count(*)::int as n from conversations
        where org_id = $1 and started_at >= now() - interval '30 days'`,
      [orgId],
    );
    const conversationsCompleted = await tx.query(
      `select count(*)::int as n from conversations
        where org_id = $1 and status = 'completed' and ended_at >= now() - interval '30 days'`,
      [orgId],
    );
    const qualified = await tx.query(
      `select count(*)::int as n from outcomes
        where org_id = $1 and kind = 'qualified' and occurred_at >= now() - interval '30 days'`,
      [orgId],
    );
    const bookings = await tx.query(
      `select count(*)::int as n from outcomes
        where org_id = $1 and kind = 'booking' and occurred_at >= now() - interval '30 days'`,
      [orgId],
    );
    const openTasks = await tx.query(
      `select count(*)::int as n from tasks where org_id = $1 and status = 'open'`,
      [orgId],
    );
    return {
      new_leads: newLeads.rows[0].n,
      conversations_started: conversationsStarted.rows[0].n,
      conversations_completed: conversationsCompleted.rows[0].n,
      qualified: qualified.rows[0].n,
      bookings: bookings.rows[0].n,
      open_tasks: openTasks.rows[0].n,
    };
  });
}

export interface TrendRow {
  day: string;
  new_leads: number;
  conversations_started: number;
  bookings: number;
}

// The dashboard's trends chart: the 30-day daily series behind funnelMetrics' tiles. The three
// series count what the tiles count — new_leads = live contacts by created_at::date,
// conversations_started = conversations by started_at::date, bookings = 'booking' outcomes by
// occurred_at::date — but per calendar day over current_date - 29 … current_date, while the tiles
// count the rolling 30 days before now(). So a tile and its series' sum can differ by the partial
// first day of the tile's window. Gap-filled to EXACTLY 30 rows via generate_series(0..29),
// ascending: a no-activity day is a zero row, never omitted. Like each of funnelMetrics' counts,
// every series filters by company (`org_id = $1`) on top of the database's per-company rules
// (docs/patterns/drizzle-query.md).
export async function funnelTrends(
  pool: pg.Pool,
  orgId: string,
): Promise<TrendRow[]> {
  return withOrg(pool, orgId, async (tx) => {
    const result = await tx.query(
      `select to_char(current_date - gs.n, 'YYYY-MM-DD') as day,
              coalesce(nl.c, 0)::int as new_leads,
              coalesce(cs.c, 0)::int as conversations_started,
              coalesce(bk.c, 0)::int as bookings
         from generate_series(0, 29) as gs(n)
         left join (
                select created_at::date as d, count(*) as c
                  from contacts
                 where org_id = $1 and deleted_at is null
                   and created_at::date between current_date - 29 and current_date
                 group by created_at::date
              ) nl on nl.d = current_date - gs.n
         left join (
                select started_at::date as d, count(*) as c
                  from conversations
                 where org_id = $1
                   and started_at::date between current_date - 29 and current_date
                 group by started_at::date
              ) cs on cs.d = current_date - gs.n
         left join (
                select occurred_at::date as d, count(*) as c
                  from outcomes
                 where org_id = $1 and kind = 'booking'
                   and occurred_at::date between current_date - 29 and current_date
                 group by occurred_at::date
              ) bk on bk.d = current_date - gs.n
        order by gs.n desc`,
      [orgId],
    );
    return result.rows;
  });
}
