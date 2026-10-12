// The run_agent_turn job handler: the generic bridge to the harness turn loop. In ONE withOrg(orgId) tx,
// with every query also filtered by the job's company:
//   1. reload the conversation FOR UPDATE; NO-OP if this trigger was already processed. The
//      per-trigger marker is DURABLE and message-derived (NOT the conversation status column): a
//      turn answers the latest unanswered inbound, so once an agent/tool message sits after every
//      contact message there is nothing to process — a pg-boss re-delivery runs the turn ONCE.
//   2. load the conversation's agent (the company's own or a shared template: system_prompt +
//      tools_allowed) and invoke runTurn({ provider, registry, toolsAllowed, systemPrompt }, ctx,
//      conversationId) so messages + usage_events land.

import type { ToolRegistry } from "@harness/registry";
import type { LlmProvider, OrgCtx } from "@harness/types";
import { withOrg } from "@revenue-os/db";
import { runTurn } from "@revenue-os/harness";
import type { Pool } from "pg";

export type AgentTurnDeps = {
  pool: Pool;
  provider: LlmProvider;
  registry: ToolRegistry;
  now?: () => Date;
};

export type AgentTurnJob = {
  orgId: string;
  runId: string;
  action: { kind: "run_agent_turn"; conversationId: string };
};

export async function handleAgentTurn(
  deps: AgentTurnDeps,
  job: AgentTurnJob,
): Promise<void> {
  const { orgId, action } = job;
  const conversationId = action.conversationId;

  await withOrg(deps.pool, orgId, async (tx) => {
    const ctx: OrgCtx = { orgId, db: tx };

    // 1. lock the conversation (serializes concurrent turns) + read its agent.
    const convo = (
      await tx.query(
        `select id, agent_id from conversations where id = $1 and org_id = $2 for update`,
        [conversationId, orgId],
      )
    ).rows[0];
    if (!convo) return; // RLS-hidden or gone

    // per-trigger idempotency: is there an inbound message NOT yet answered by an agent/tool turn?
    const pending = await tx.query(
      `select 1 from messages
        where org_id = $2 and conversation_id = $1 and role = 'contact'
          and seq > coalesce(
            (select max(seq) from messages
              where org_id = $2 and conversation_id = $1 and role in ('agent','tool')),
            0)
        limit 1`,
      [conversationId, orgId],
    );
    if ((pending.rowCount ?? 0) === 0) return; // already processed — exactly-once

    // 2. load the agent config and drive the turn.
    const agent = (
      await tx.query(
        `select system_prompt, tools_allowed from agents
          where id = $1 and (org_id = $2 or org_id is null)`,
        [convo.agent_id, orgId],
      )
    ).rows[0];
    if (!agent) return; // conversation has no resolvable agent

    await runTurn(
      {
        provider: deps.provider,
        registry: deps.registry,
        toolsAllowed: (agent.tools_allowed as string[] | null) ?? [],
        systemPrompt: (agent.system_prompt as string | null) ?? "",
      },
      ctx,
      conversationId,
    );
  });
}
