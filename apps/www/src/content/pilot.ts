// The pilot, explained so it supports the demo decision: who it suits, the four
// weeks, what the customer provides, how success is measured, and how fees work —
// in words, because rates are agreed per project (no published figures). The plan
// comparison is secondary (a disclosure) and honest: checks only for what exists.
// `kicker` is a derived slot fill (the nav label) for the eyebrow over the heading.

export const pilot = {
  kicker: "Pilot",
  title: "Start with a four-week pilot",
  intro: "We walk you through the pilot on the demo. This is what it involves.",
  facts: [
    {
      title: "Who it suits",
      body: "Developers and brokerages with a steady flow of enquiries on at least one project, and a team that runs site visits.",
    },
    {
      title: "Over four weeks",
      body: "In week one we set up your project details, your call script and your lead import (a CSV export from your portal or CRM) with you. For the next three weeks, Krate works your new enquiries alongside your current process.",
    },
    {
      title: "What you provide",
      body: "Your enquiries as a CSV export, your project details and pricing, and a salesperson to run the visits.",
    },
    {
      title: "How success is measured",
      body: "Site visits booked and completed, compared with your current process on the same enquiries. If Krate doesn't beat your current process on conversion to site visit, you pay nothing for the pilot.",
    },
  ],
  fees: {
    title: "How fees work",
    body: "There is no platform fee during the pilot: you pay only for qualified site visits that actually happen. After the pilot, a monthly platform fee covers the service, and it is credited against your visit fees, so you never pay twice for the same visit. Rates are agreed per project on the demo call.",
  },
  // Checks mark only what exists today; roadmap items sit under "planned" (no check).
  compare: {
    summary: "Compare plans",
    plannedLabel: "Planned",
    plans: [
      {
        name: "Pilot",
        price: "No platform fee",
        features: [
          "One project, for four weeks",
          "Voice calls and WhatsApp follow-ups",
          "Qualification summaries for your team",
          "Pay per qualified site visit",
        ],
        planned: [],
      },
      {
        name: "Funnel Engine",
        price: "Monthly platform fee",
        features: [
          "Every project",
          "Voice calls, WhatsApp follow-ups and scheduled re-calls",
          "Qualification summaries for your team",
          "Platform fee credited against visit fees",
        ],
        planned: ["CRM connectors", "Intent scoring"],
      },
      {
        name: "Custom",
        price: "Agreed per engagement",
        features: [
          "Everything in Funnel Engine",
          "Follow-up workflows shaped to your sales process",
        ],
        planned: [
          "Loan handoff",
          "Possession servicing",
          "Documentation workflows",
        ],
      },
    ],
  },
} as const;
