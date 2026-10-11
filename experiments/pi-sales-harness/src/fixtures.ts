// Prototype (experiments/pi-sales-harness/README.md). ILLUSTRATIVE data: two made-up companies, their members and
// leads, standing in for database rows. No real company, person or number; prices and rules are invented.
import type { Proposal } from "./policy";
import type { OrgPolicy, Rows, TrustedScope } from "./tenancy";

const playbook: OrgPolicy["playbook"] = {
  byStage: {
    new: ["send_whatsapp", "schedule_call", "wait"],
    contacted: ["schedule_call", "send_whatsapp", "wait"],
    qualified: ["schedule_call", "send_whatsapp", "hand_to_human", "wait"],
    meeting_scheduled: ["send_whatsapp", "wait"], // reminders before the visit
    opportunity: ["hand_to_human", "wait"], // a closer takes over
    customer: ["wait"],
    lost: ["wait"],
    dnc: [],
  },
  byIntent: {
    ready_to_visit: ["schedule_call", "send_whatsapp", "hand_to_human", "wait"],
    needs_more_info: ["schedule_call", "send_whatsapp", "wait"],
    not_now: ["wait", "send_whatsapp"],
    opted_out: ["wait"],
    unclear: ["send_whatsapp", "wait"],
  },
};
const approveStages: OrgPolicy["approveStages"] = ["customer", "lost"];

export const ROWS: Rows = {
  orgs: [
    {
      orgId: "org-skyline",
      name: "Skyline Homes (illustrative)",
      goal: "Book a site visit",
      autonomy: {
        schedule_call: "auto",
        send_whatsapp: "auto",
        wait: "auto",
        hand_to_human: "auto",
      },
      callingWindow: { start: "10:00", end: "20:00" },
      maxCallsPerWeek: 3,
      playbook,
      approveStages,
    },
    {
      orgId: "org-riverbend",
      name: "Riverbend Estates (illustrative)",
      goal: "Book a site visit",
      autonomy: {
        schedule_call: "approval",
        send_whatsapp: "auto",
        wait: "auto",
        hand_to_human: "auto",
      },
      callingWindow: { start: "11:00", end: "19:00" },
      maxCallsPerWeek: 2,
      playbook,
      approveStages,
    },
  ],
  knowledge: [
    {
      orgId: "org-skyline",
      id: "kb-price",
      topic: "3BHK price",
      text: "3BHK at Skyline Towers from 1.2 crore; quote the current sheet, never memory.",
    },
    {
      orgId: "org-skyline",
      id: "kb-loan",
      topic: "Home loan and EMI",
      text: "Partner banks pre-approve loans; EMI questions go to a call with the loan desk.",
    },
    {
      orgId: "org-skyline",
      id: "kb-visit",
      topic: "Site visits",
      text: "Visits run 10:00-18:00 daily; Sunday slots fill first.",
    },
    {
      orgId: "org-riverbend",
      id: "kb-rb-price",
      topic: "3BHK price",
      text: "Riverbend 3BHK from 95 lakh.",
    },
  ],
  members: [
    {
      orgId: "org-skyline",
      userId: "user-asha",
      role: "operator",
      preferences: { language: "Hinglish", requireApprovalFor: [] },
    },
    {
      orgId: "org-skyline",
      userId: "user-vikram",
      role: "operator",
      preferences: {
        language: "English",
        requireApprovalFor: ["schedule_call"],
      },
    },
    {
      orgId: "org-riverbend",
      userId: "user-meera",
      role: "admin",
      preferences: { language: "English", requireApprovalFor: [] },
    },
  ],
  leads: [
    {
      orgId: "org-skyline",
      id: "lead-priya",
      name: "Priya (made up)",
      stage: "contacted",
      timezone: "Asia/Kolkata",
      consent: { dnc: false, whatsappOptIn: true },
      facts: { "Looking for": "3BHK", Budget: "1.0-1.3 crore" },
      callsThisWeek: 1,
    },
    {
      orgId: "org-skyline",
      id: "lead-rohan",
      name: "Rohan (made up)",
      stage: "dnc",
      timezone: "Asia/Kolkata",
      consent: { dnc: true, whatsappOptIn: false },
      facts: {},
      callsThisWeek: 0,
    },
    {
      orgId: "org-riverbend",
      id: "lead-kabir",
      name: "Kabir (made up)",
      stage: "contacted",
      timezone: "Asia/Kolkata",
      consent: { dnc: false, whatsappOptIn: null },
      facts: { "Looking for": "3BHK" },
      callsThisWeek: 0,
    },
    {
      orgId: "org-skyline",
      id: "lead-anil",
      name: "Anil (made up)",
      stage: "contacted",
      timezone: "Asia/Kolkata",
      consent: { dnc: false, whatsappOptIn: true },
      facts: { "Looking for": "2BHK" },
      callsThisWeek: 1,
    },
    {
      orgId: "org-skyline",
      id: "lead-sunil",
      name: "Sunil (made up)",
      stage: "qualified",
      timezone: "Asia/Kolkata",
      consent: { dnc: false, whatsappOptIn: true },
      facts: { "Looking for": "3BHK" },
      callsThisWeek: 0,
    },
  ],
  interactions: [
    {
      orgId: "org-skyline",
      leadId: "lead-priya",
      at: "2026-10-10T10:02:00+05:30",
      from: "lead",
      text: "Saw the Skyline Towers ad.",
    },
    {
      orgId: "org-skyline",
      leadId: "lead-priya",
      at: "2026-10-10T10:03:00+05:30",
      from: "agent",
      text: "Thanks! 2BHK or 3BHK?",
    },
    {
      orgId: "org-skyline",
      leadId: "lead-priya",
      at: "2026-10-11T09:40:00+05:30",
      from: "lead",
      text: "3BHK. What is the price, and how do the loan and EMI work? Easier if someone explains.",
    },
    {
      orgId: "org-skyline",
      leadId: "lead-rohan",
      at: "2026-10-09T15:00:00+05:30",
      from: "lead",
      text: "Please stop calling me.",
    },
    {
      orgId: "org-riverbend",
      leadId: "lead-kabir",
      at: "2026-10-11T11:15:00+05:30",
      from: "lead",
      text: "What is the 3BHK price? Need details on the loan.",
    },
    {
      orgId: "org-skyline",
      leadId: "lead-anil",
      at: "2026-10-11T19:05:00+05:30",
      from: "lead",
      text: "Sunday works for a site visit; the whole family will come.",
    },
    {
      orgId: "org-skyline",
      leadId: "lead-sunil",
      at: "2026-10-11T16:20:00+05:30",
      from: "lead",
      text: "Not interested any more, we bought a flat elsewhere.",
    },
  ],
  memories: [
    {
      orgId: "org-skyline",
      leadId: "lead-priya",
      kind: "preference",
      text: "Prefers Hinglish; free after 6 pm on weekdays",
    },
    {
      orgId: "org-skyline",
      leadId: "lead-priya",
      kind: "fact",
      text: "The family decides together on Sundays",
    },
    {
      orgId: "org-riverbend",
      leadId: "lead-kabir",
      kind: "objection",
      text: "Thinks Riverbend is far from the metro",
    },
  ],
};

export const SCENARIOS: {
  title: string;
  scope: TrustedScope;
  proposal: Proposal;
}[] = [
  {
    title: "Needs more details: a call at 18:30, after work",
    scope: { orgId: "org-skyline", userId: "user-asha", leadId: "lead-priya" },
    proposal: {
      kind: "schedule_call",
      at: "2026-10-12T18:30:00+05:30",
      reason: "Asked about price, loan and EMI; free after 6 pm",
    },
  },
  {
    title: "The same ask at a company that approves every call",
    scope: {
      orgId: "org-riverbend",
      userId: "user-meera",
      leadId: "lead-kabir",
    },
    proposal: {
      kind: "schedule_call",
      at: "2026-10-12T12:00:00+05:30",
      reason: "Asked about price and the loan",
    },
  },
  {
    title: "A member who approves every call first",
    scope: {
      orgId: "org-skyline",
      userId: "user-vikram",
      leadId: "lead-priya",
    },
    proposal: {
      kind: "schedule_call",
      at: "2026-10-12T18:30:00+05:30",
      reason: "Asked about price, loan and EMI",
    },
  },
  {
    title: "A call at 22:15",
    scope: { orgId: "org-skyline", userId: "user-asha", leadId: "lead-priya" },
    proposal: {
      kind: "schedule_call",
      at: "2026-10-12T22:15:00+05:30",
      reason: "Try late",
    },
  },
  {
    title: "A lead who said stop",
    scope: { orgId: "org-skyline", userId: "user-asha", leadId: "lead-rohan" },
    proposal: {
      kind: "send_whatsapp",
      at: "2026-10-12T11:00:00+05:30",
      reason: "Follow up",
    },
  },
  {
    title: "A visit agreed: confirm it and move the lead to meeting_scheduled",
    scope: { orgId: "org-skyline", userId: "user-asha", leadId: "lead-anil" },
    proposal: {
      kind: "send_whatsapp",
      at: "2026-10-12T11:00:00+05:30",
      reason: "Confirm Sunday's site visit",
      stage: "meeting_scheduled",
    },
  },
  {
    title: "Keen to visit, but marked a customer straight away",
    scope: { orgId: "org-skyline", userId: "user-asha", leadId: "lead-anil" },
    proposal: {
      kind: "wait",
      at: "2026-10-12T11:00:00+05:30",
      reason: "Sounds keen",
      stage: "customer",
    },
  },
  {
    title: "Bought elsewhere: marking the lead lost",
    scope: { orgId: "org-skyline", userId: "user-asha", leadId: "lead-sunil" },
    proposal: {
      kind: "wait",
      at: "2026-10-12T11:00:00+05:30",
      reason: "Says they bought elsewhere",
      stage: "lost",
    },
  },
];
