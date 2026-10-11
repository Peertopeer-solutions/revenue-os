// Prototype (experiments/pi-sales-harness/README.md). The guardrail boundary for what the agent PROPOSES: each
// proposal is permitted, sent to a person for approval, or refused, and every check says why. A permitted proposal
// is still only a saved next step. When the worker later carries it out, the packages/channels doorways run the
// product's guard() again (packages/harness/src/policies.ts), the last check before anything reaches a lead.
import type { Autonomy } from "@revenue-os/harness";
import type {
  ActionKind,
  IntentLabel,
  LifecycleStage,
  ScopedReader,
} from "./tenancy";

/** at: an ISO 8601 instant. stage: where this step moves the lead in the sales cycle, when it moves it. */
export type Proposal = {
  kind: ActionKind;
  at: string;
  reason: string;
  stage?: LifecycleStage;
};
export type Check = {
  layer: "legal floor" | "sales cycle" | "company policy" | "member preference";
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

/** The sales cycle over the stages contacts already carry (app.lifecycle_stage): where a lead may move next. Code,
 *  like the legal floor. Any lead may be blocked (dnc); only the lead's own written yes lifts a block, never a run. */
export const SALES_CYCLE: Record<LifecycleStage, LifecycleStage[]> = {
  new: ["contacted", "lost", "dnc"],
  contacted: ["qualified", "meeting_scheduled", "lost", "dnc"],
  qualified: ["meeting_scheduled", "lost", "dnc"],
  meeting_scheduled: ["opportunity", "qualified", "lost", "dnc"], // a missed visit goes back to qualified
  opportunity: ["customer", "lost", "dnc"],
  customer: ["dnc"],
  lost: ["contacted", "dnc"], // a lost lead may be won back
  dnc: [],
};

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
  const moves = org.playbook.byStage[lead.stage].filter((m) =>
    org.playbook.byIntent[intent].includes(m),
  );
  check(
    "company policy",
    "playbook",
    moves.includes(kind),
    "approval",
    `at stage "${lead.stage}" with intent "${intent}" the playbook lists ${moves.join(", ") || "nothing"}`,
  );
  const to = proposal.stage;
  if (to && to !== lead.stage) {
    check(
      "sales cycle",
      "stage order",
      SALES_CYCLE[lead.stage].includes(to),
      "deny",
      `${lead.stage} may move to ${SALES_CYCLE[lead.stage].join(", ") || "nothing"}, not ${to}`,
    );
    check(
      "company policy",
      "stage approval",
      !org.approveStages.includes(to),
      "approval",
      `the company approves every move to ${to}`,
    );
  }
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
