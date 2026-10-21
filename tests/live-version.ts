// The one way a test puts a role version live: as a draft, then a passing stored run of its whole test set (one
// scenario of its own), then tested, then live — the path migration 026 holds every version to, so a test's agent goes
// live exactly as a real one does. `db` writes as the local superuser (`postgres`). The version's company, or for a
// shared template (orgId null) `runIn`, is one tests/test-companies.ts made: the run and its scenario are that
// company's, so its clean-up deletes them (a test that makes a template deletes the template itself).
import type { Pool } from "pg";

type Db = Pick<Pool, "query">;

/** What a test's version names; anything left out gets a plain value. Returns the live version's id. */
export async function putLive(
  db: Db,
  orgId: string | null,
  v: {
    key: string;
    version?: number;
    model?: string;
    systemPrompt?: string;
    toolsAllowed?: string[];
    goal?: string;
    rules?: unknown;
  },
  runIn: string | null = orgId,
): Promise<string> {
  if (!runIn)
    throw new Error("a template's run belongs to a company: pass runIn");
  const version = v.version ?? 1;
  const check = `${v.key}-v${version}-check`;
  const id = (
    await db.query<{ id: string }>(
      `insert into agents (org_id, key, version, status, model, system_prompt, tools_allowed, goal, rules, test_set)
       values ($1, $2, $3, 'draft', $4, $5, $6, $7, $8::jsonb, $9) returning id`,
      [
        orgId,
        v.key,
        version,
        v.model ?? "anthropic:claude-sonnet-5-5",
        v.systemPrompt ?? "You are a test agent.",
        v.toolsAllowed ?? [],
        v.goal ?? "",
        JSON.stringify(v.rules ?? {}),
        [check],
      ],
    )
  ).rows[0]?.id;
  if (!id) throw new Error(`version ${version} of ${v.key} was not written`);
  const scenario = (
    await db.query<{ id: string }>(
      `insert into eval_scenarios (org_id, key, persona, script, assertions)
       values ($1, $2, '{}', '{}', '{}')
       on conflict (org_id, key) do update set key = excluded.key returning id`,
      [runIn, check],
    )
  ).rows[0]?.id;
  await db.query(
    `insert into eval_runs (org_id, scenario_id, agent_id, passed, set_run)
     values ($1, $2, $3, true, gen_random_uuid())`,
    [runIn, scenario, id],
  );
  for (const status of ["tested", "active"])
    await db.query(`update agents set status = $2 where id = $1`, [id, status]);
  return id;
}
