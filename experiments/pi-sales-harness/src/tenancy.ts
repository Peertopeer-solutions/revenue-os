// Prototype, never wired into the product (experiments/pi-sales-harness/README.md). The tenant boundary of one
// lead's agent run: who it runs for, the rows it may read at each of the three memory scopes (company, member,
// lead), and the one reader that hands them out. Nothing in apps/, services/ or packages/ imports this folder.
import type { Autonomy } from "@revenue-os/harness";

/** Who and what one run is for. The host builds it from the signed-in request or the queued job (in the product:
 *  withOrg's company and the org_members row), never from anything the model says, so no tool takes these ids. */
export type TrustedScope = Readonly<{
  orgId: string;
  userId: string; // the member the run acts for, such as the lead's owner
  leadId: string;
}>;

export type MemberRole = "admin" | "operator" | "viewer"; // app.org_role
export type LifecycleStage =
  // app.lifecycle_stage: the sales stage contacts already carry
  | "new"
  | "contacted"
  | "qualified"
  | "meeting_scheduled"
  | "opportunity"
  | "customer"
  | "lost"
  | "dnc";
export type IntentLabel =
  | "ready_to_visit"
  | "needs_more_info"
  | "not_now"
  | "opted_out"
  | "unclear";
/** What the agent may propose. Proposing does nothing: the host saves it, asks a person, or refuses it. */
export type ActionKind =
  | "schedule_call"
  | "send_whatsapp"
  | "wait"
  | "hand_to_human";

/** Company scope: rules and product knowledge every lead of one company shares. Only the company's admins write
 *  it, in the console (guardrail_policies, agents, knowledge_documents); a run only reads it. */
export type OrgPolicy = {
  orgId: string;
  name: string;
  goal: string;
  autonomy: Record<ActionKind, Autonomy>; // runs on its own, needs a person's approval, or is off
  callingWindow: { start: string; end: string }; // HH:MM in the lead's time zone; tightens the legal window only
  maxCallsPerWeek: number;
  // The nurturing moves the company expects: a move fits when both the lead's stage and its intent list it.
  playbook: {
    byStage: Record<LifecycleStage, ActionKind[]>;
    byIntent: Record<IntentLabel, ActionKind[]>;
  };
  approveStages: LifecycleStage[]; // moving a lead into one of these needs a person
};
export type OrgKnowledge = {
  orgId: string;
  id: string;
  topic: string;
  text: string;
};

/** Member scope: one person's place in one company. Only that person changes their preferences. */
export type Member = {
  orgId: string;
  userId: string;
  role: MemberRole;
  preferences: { language: string; requireApprovalFor: ActionKind[] };
};

/** Lead scope: facts (contacts), interactions (messages) and memories (contact_memories) of one lead. */
export type Lead = {
  orgId: string;
  id: string;
  name: string;
  stage: LifecycleStage;
  timezone: string;
  consent: { dnc: boolean; whatsappOptIn: boolean | null };
  facts: Record<string, string>;
  callsThisWeek: number;
};
export type Interaction = {
  orgId: string;
  leadId: string;
  at: string;
  from: "lead" | "agent" | "person";
  text: string;
};
export type LeadMemory = {
  orgId: string;
  leadId: string;
  kind: "summary" | "preference" | "objection" | "fact";
  text: string;
};

/** Every row the stand-in store holds, as the database holds them: each row names its company. */
export type Rows = {
  orgs: OrgPolicy[];
  knowledge: OrgKnowledge[];
  members: Member[];
  leads: Lead[];
  interactions: Interaction[];
  memories: LeadMemory[];
};

/** All a run may read: one company, one member, one lead. No method takes an id, so neither a tool nor the model
 *  can ask it for another company's rows or for another lead of the same company. */
export interface ScopedReader {
  readonly scope: TrustedScope;
  org(): OrgPolicy;
  member(): Member;
  lead(): Lead;
  interactions(): Interaction[]; // oldest first
  memories(): LeadMemory[];
  knowledge(query: string, limit: number): OrgKnowledge[];
}

/** Opens the reader, or refuses: a user outside the company or a lead of another company gets nothing. In the
 *  product every query runs inside withOrg (row-level security) and also names org_id, the second fence; the
 *  filters below play both parts. */
export function openScope(rows: Rows, scope: TrustedScope): ScopedReader {
  const inOrg = <T extends { orgId: string }>(list: T[]) =>
    list.filter((r) => r.orgId === scope.orgId);
  const org = inOrg(rows.orgs)[0];
  const member = inOrg(rows.members).find((m) => m.userId === scope.userId);
  const lead = inOrg(rows.leads).find((l) => l.id === scope.leadId);
  if (!org || !member || !lead)
    throw new Error("out of scope: no such company, member or lead here");
  const ofLead = <T extends { orgId: string; leadId: string }>(list: T[]) =>
    inOrg(list).filter((r) => r.leadId === lead.id);
  return {
    scope,
    org: () => org,
    member: () => member,
    lead: () => lead,
    interactions: () =>
      ofLead(rows.interactions).sort((a, b) => a.at.localeCompare(b.at)),
    memories: () => ofLead(rows.memories),
    // Stand-in for retrieval over knowledge_chunks (embeddings are not chosen yet): rank by shared words.
    knowledge: (query, limit) => {
      const words = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      const hits = (k: OrgKnowledge) =>
        (`${k.topic} ${k.text}`.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
          (w) => words.has(w),
        ).length;
      return inOrg(rows.knowledge)
        .map((k) => ({ k, n: hits(k) }))
        .filter(({ n }) => n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, limit)
        .map(({ k }) => k);
    },
  };
}
