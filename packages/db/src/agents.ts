// The agents table's reads: the console's list of the company's agents and sequences (listAgentsAndWorkflows), and the
// engine's read of a role's live version (liveVersion), whole and checked, so a turn takes its model, prompt, goal,
// rules, tools, facts sections and test set from the version and the engine holds nothing about any one role
// (migration 026; docs/brain.md, part 2). The console's list filters by `org_id = $1` alone, so the shared templates
// (org_id null, readable by every member) stay off it until a screen needs them, and it sends lean columns only: never
// a prompt, a voice setting or the tools (agents) or the step map (workflows).
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import { type RoleVersion, RoleVersionSchema } from "@revenue-os/shared";
import type pg from "pg";
import { type Db, withOrg } from "./client";

export interface AgentRow {
  id: string;
  key: string;
  version: number;
  status: string;
  model: string;
  created_at: string;
}

export interface WorkflowRow {
  id: string;
  key: string;
  version: number;
  status: string;
  created_at: string;
}

export async function listAgentsAndWorkflows(
  pool: pg.Pool,
  orgId: string,
): Promise<{ agents: AgentRow[]; workflows: WorkflowRow[] }> {
  return withOrg(pool, orgId, async (tx) => {
    // Sequential — one PoolClient runs one query at a time (Promise.all would interleave on the
    // same connection; pg deprecation-warns and can misbehave). Mirrors funnelMetrics.
    const agents = await tx.query(
      `select id, key, version, status, model, created_at::text as created_at
         from agents
        where org_id = $1
        order by key asc, version desc`,
      [orgId],
    );
    const workflows = await tx.query(
      `select id, key, version, status, created_at::text as created_at
         from workflows
        where org_id = $1
        order by key asc, version desc`,
      [orgId],
    );
    return { agents: agents.rows, workflows: workflows.rows };
  });
}

/**
 * The version of role `key` that is live for the company now: its own before a shared template, the newest first.
 * Null when the role has none live. A live row the version schema refuses (a model off the platform's list, rules
 * that don't parse) throws, naming the version, so no turn ever runs on half a role.
 */
export async function liveVersion(
  db: Db,
  orgId: string,
  key: string,
): Promise<RoleVersion | null> {
  const r = await db.query(
    `select id, org_id, key, version, status, engine, model, system_prompt, goal, rules, tools_allowed,
            facts_sections, test_set
       from agents
      where key = $1 and status = 'active' and (org_id = $2 or org_id is null)
      order by org_id is null, version desc
      limit 1`,
    [key, orgId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const read = RoleVersionSchema.safeParse(row);
  if (!read.success)
    throw new Error(
      `live version ${row.version} of role ${key} can't be used: ${read.error.issues.map((i) => `${i.path.join(".") || "row"} ${i.message}`).join("; ")}`,
    );
  return read.data;
}
