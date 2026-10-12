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
        where deleted_at is null and created_at >= now() - interval '30 days'`,
    );
    const conversationsStarted = await tx.query(
      `select count(*)::int as n from conversations
        where started_at >= now() - interval '30 days'`,
    );
    const conversationsCompleted = await tx.query(
      `select count(*)::int as n from conversations
        where status = 'completed' and ended_at >= now() - interval '30 days'`,
    );
    const qualified = await tx.query(
      `select count(*)::int as n from outcomes
        where kind = 'qualified' and occurred_at >= now() - interval '30 days'`,
    );
    const bookings = await tx.query(
      `select count(*)::int as n from outcomes
        where kind = 'booking' and occurred_at >= now() - interval '30 days'`,
    );
    const openTasks = await tx.query(
      `select count(*)::int as n from tasks where status = 'open'`,
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

// Task 51 (spec §12 — Analytics "Trends"): the 30-day daily series behind funnelMetrics' tiles.
// The three series predicates MIRROR funnelMetrics exactly — new_leads = live contacts by
// created_at::date, conversations_started = conversations by started_at::date, bookings = 'booking'
// outcomes by occurred_at::date — so each daily total sums to the matching tile. Gap-filled to
// EXACTLY 30 rows via generate_series(0..29) → current_date-29 … current_date (ascending): a
// no-activity day is a zero row, never omitted. Series are windowed by the same 30 calendar days
// the tiles span, so out-of-window rows count in neither. Explicit `org_id = $1` in every series is
// the drizzle-query.md belt-and-suspenders (withOrg RLS is the net; funnelMetrics omits it, this
// doesn't — agreement is unaffected, both run inside the same org scope).
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
