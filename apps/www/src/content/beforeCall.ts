// How it works, told as one enquiry in order: the page's middle. An intro, then five
// unnumbered steps beside a product window that plays the call brief (CallBrief) and
// the intent study (IntentEvidence) as the steps go by. The engine panel after it is
// "The call and after" (workflow.ts). Both studies read the SAME signals below, so
// their sums always agree. ILLUSTRATIVE: intent scoring and questions to the sales
// team are planned (pilot.ts lists intent scoring as planned), so the section carries
// "Illustrative example" in its kicker row and on the window. HowItWorks.tsx
// composes the intro; HowSteps.tsx the steps and the window; the studies the rest.

export const howItWorks = {
  kicker: "How it works",
  title: "Follow one lead, from the moment it lands to the site visit.",
  // The title's words set in clay, in the order they appear (same serif, colour only).
  accents: ["lands", "site visit"],
  sub: "One evening, one buyer: Rohan Mehta's enquiry lands at 7:12\u00a0PM. Here is what Krate does before it calls him, how it decides to call now or follow up, and what happens on the call and after.",
  illustrative: "Illustrative example",
  stepsLabel: "Rohan's enquiry, step by step", // names the tab list for screen readers
} as const;

export interface IntentSignal {
  label: string;
  detail: string;
  weight: number;
}

// The four signals that build Rohan's score, in the order they're found.
export const intentSignals: IntentSignal[] = [
  {
    label: "Repeat enquiry",
    detail: "His second enquiry this month",
    weight: 24,
  },
  {
    label: "Budget fits",
    detail: "₹90 L · three open 2 BHK units under it",
    weight: 22,
  },
  {
    label: "Timeline known",
    detail: "Said “next year” on his first enquiry",
    weight: 16,
  },
  {
    label: "Asked about possession before",
    detail: "On his first enquiry, 2 Sep",
    weight: 16,
  },
];

export const intentScore = {
  total: intentSignals.reduce((sum, s) => sum + s.weight, 0), // 78
  outOf: 100,
  callNow: 50, // at or above: call tonight; below: the follow-up plan
} as const;

export interface HowStep {
  title: string;
  body: string;
}
const { total, outOf, callNow } = intentScore;
// The five steps, in story order and unnumbered. Titles 3 and 4 are the approved
// headlines, word for word. Step 4 reads its numbers from intentScore, never typing them.
export const howSteps: readonly HowStep[] = [
  {
    title: "It starts the moment a lead lands.",
    body: "Wherever it came from, Krate reads his enquiry in his own words, notes what he asked for and starts his call brief.",
  },
  {
    title: "A brief before every call.",
    body: "It matches his budget to your inventory, checks his earlier enquiries and notes his language, each fact with its source.",
  },
  {
    title: "Your team answers once. Every call knows.",
    body: "Parking isn't in the brochure, so Priya in sales is asked once on WhatsApp. Her answer is saved for every later call.",
  },
  {
    title: "Every score shows its working.",
    body: `Four signals add up to ${total} out of ${outOf}. At ${callNow} or more the agent calls tonight; below that, the buyer gets the follow-up plan.`,
  },
  {
    title: "A call plan in his language.",
    body: "Six steps, in Hinglish, with Priya's answer in hand. At 7:14\u00a0PM the agent calls Rohan; what happens next is below.",
  },
];
