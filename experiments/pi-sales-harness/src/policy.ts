// Prototype (experiments/pi-sales-harness/README.md). The guardrail boundary for what the agent PROPOSES: each
// proposal is permitted, sent to a person for approval, or refused, and every check says why. A permitted proposal
// is still only a saved next step. When the worker later carries it out, the packages/channels doorways run the
// product's guard() again (packages/harness/src/policies.ts), the last check before anything reaches a lead.
import type { Autonomy } from "@revenue-os/harness";
import type { ActionKind, IntentLabel, ScopedReader } from "./tenancy";

export type Proposal = { kind: ActionKind; at: string; reason: string }; // at: an ISO 8601 instant
export type Check = {
  layer: "legal floor" | "company policy" | "member preference";
  rule: string;
  result: "pass" | "approval" | "deny";
  why: string;
};
export type Decision = {
  outcome: "permit" | "needs_approval" | "deny";
  checks: Check[];
};

/** The legal floor is code, not a setting (docs/NORTH-STAR.md, principle 4): a company's window can only narrow
 *  it. Lead-local HH:MM, start included, end excluded. */
export const LEGAL_CALL_WINDOW = { start: "09:00", end: "21:00" };

const localTime = (at: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
const within = (t: string, w: { start: string; end: string }) =>
  t >= w.start && t < w.end;

export function checkProposal(
  reader: ScopedReader,
  proposal: Proposal,
  intent: IntentLabel,
): Decision {
  const org = reader.org();
  const lead = reader.lead();
  const checks: Check[] = [];
  const check = (
    layer: Check["layer"],
    rule: string,
    ok: boolean,
    otherwise: "approval" | "deny",
    why: string,
  ) => checks.push({ layer, rule, result: ok ? "pass" : otherwise, why });
  const { kind } = proposal;

  if (kind === "schedule_call" || kind === "send_whatsapp") {
    const dnc = lead.consent.dnc || lead.stage === "dnc";
    check(
      "legal floor",
      "do-not-call",
      !dnc,
      "deny",
      dnc ? "the lead asked not to be contacted" : "no do-not-call on record",
    );
    if (kind === "send_whatsapp")
      check(
        "legal floor",
        "WhatsApp opt-in",
        lead.consent.whatsappOptIn === true,
        "deny",
        `opt-in on record: ${lead.consent.whatsappOptIn}`,
      );
    if (kind === "schedule_call") {
      const t = localTime(proposal.at, lead.timezone);
      const legal = LEGAL_CALL_WINDOW;
      const own = org.callingWindow;
      check(
        "legal floor",
        "calling hours",
        within(t, legal),
        "deny",
        `${t} in ${lead.timezone}; the law allows ${legal.start}-${legal.end}`,
      );
      check(
        "company policy",
        "company calling window",
        within(t, own),
        "deny",
        `${t}; the company calls ${own.start}-${own.end}`,
      );
      check(
        "company policy",
        "calls per week",
        lead.callsThisWeek < org.maxCallsPerWeek,
        "deny",
        `${lead.callsThisWeek} of ${org.maxCallsPerWeek} this week`,
      );
    }
  }
  const tier: Autonomy = org.autonomy[kind];
  check(
    "company policy",
    "approval setting",
    tier === "auto",
    tier === "forbidden" ? "deny" : "approval",
    `the company set ${kind} to "${tier}"`,
  );
  const moves = org.playbook[intent];
  check(
    "company policy",
    "playbook",
    moves.includes(kind),
    "approval",
    `for "${intent}" the playbook lists ${moves.join(", ") || "nothing"}`,
  );
  const asks = reader.member().preferences.requireApprovalFor.includes(kind);
  check(
    "member preference",
    "approve first",
    !asks,
    "approval",
    asks
      ? `the member approves every ${kind} first`
      : "no extra approval asked",
  );

  const any = (r: Check["result"]) => checks.some((c) => c.result === r);
  return {
    outcome: any("deny")
      ? "deny"
      : any("approval")
        ? "needs_approval"
        : "permit",
    checks,
  };
}
