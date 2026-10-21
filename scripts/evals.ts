// `bun run evals`, the eval command line. Thin shell by design: arguments → runEvals → process.exit. All the
// testable logic lives in ./eval-runner (scripts/eval-runner.test.ts); this file only wires the runtime parts the
// tests replace with fakes: the real Anthropic provider (from ANTHROPIC_API_KEY), a v1 persona player that replays
// script.turns in order, and the eval-mode capture send. Refuses a database that is not on this machine, with the
// same check as scripts/seed.ts (scripts/local-url.ts): no eval ever writes to staging or production from here.
import { createPool, withOrg } from "@revenue-os/db";
import { createAnthropicProvider } from "@revenue-os/harness";
import { RoleVersionSchema } from "@revenue-os/shared";
import {
  createCaptureSend,
  type EvalDeps,
  type PersonaPlayer,
  runEvals,
} from "./eval-runner";
import { isLocalUrl } from "./local-url";

/** --flag <value> / --flag=value; bare flags are ignored (we take only the ones we know). */
function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${flag}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${flag}=`));
  return eq ? eq.slice(flag.length + 3) : undefined;
}

/** v1 persona player: replay the scripted contact turns in order, then end the conversation. */
const scriptPlayer: PersonaPlayer = async (scenario, turnIndex) =>
  scenario.script.turns[turnIndex] ?? null;

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL ||
    "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
  if (!isLocalUrl(url)) {
    throw new Error("evals refuses to run against a non-local database");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new Error("evals needs ANTHROPIC_API_KEY to run the agent");

  const orgArg = argValue("org");
  const agentArg = argValue("agent");
  const scenarioArg = argValue("scenario");

  const pool = createPool(url);
  try {
    // Resolve the target org: an explicit id/slug, else the sole local org.
    const orgRow = orgArg
      ? await pool.query(
          "select id from orgs where id::text = $1 or slug = $1 limit 1",
          [orgArg],
        )
      : await pool.query("select id from orgs");
    if (orgArg && orgRow.rowCount === 0)
      throw new Error(`no org matches '${orgArg}'`);
    if (!orgArg && orgRow.rowCount !== 1)
      throw new Error(
        `expected exactly one local org (found ${orgRow.rowCount}); pass --org <id|slug>`,
      );
    const orgId = orgRow.rows[0].id as string;

    const summary = await withOrg(pool, orgId, async (tx) => {
      // Resolve the agent under test, the org's own or a shared template: --agent <key> (newest
      // version) or the only one there is.
      const agentRow = agentArg
        ? await tx.query(
            "select id, org_id, key, version, status, engine, model, system_prompt, goal, rules, tools_allowed, facts_sections, test_set from agents where key = $1 and (org_id = $2 or org_id is null) order by version desc limit 1",
            [agentArg, orgId],
          )
        : await tx.query(
            "select id, org_id, key, version, status, engine, model, system_prompt, goal, rules, tools_allowed, facts_sections, test_set from agents where (org_id = $1 or org_id is null)",
            [orgId],
          );
      if (agentArg && agentRow.rowCount === 0)
        throw new Error(`no agent matches '${agentArg}'`);
      if (!agentArg && agentRow.rowCount !== 1)
        throw new Error(
          `expected exactly one agent (found ${agentRow.rowCount}); pass --agent <key>`,
        );
      // The version under test, whole and checked: its model, prompt, tools and rules drive every turn.
      const version = RoleVersionSchema.parse(agentRow.rows[0]);

      const deps: EvalDeps = {
        provider: createAnthropicProvider({ apiKey }),
        player: scriptPlayer,
        send: createCaptureSend().send,
        agentId: version.id,
        model: version.model,
        systemPrompt: version.prompt,
        toolsAllowed: version.tools,
        rules: version.rules,
      };
      return runEvals(
        deps,
        { orgId, db: tx },
        scenarioArg ? { scenario: scenarioArg } : undefined,
      );
    });

    console.log(summary.summary);
    process.exit(summary.exitCode);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
