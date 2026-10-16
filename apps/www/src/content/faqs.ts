// The short FAQ before the closing invitation: voice quality, existing sales
// teams, integrations, onboarding, pricing — and how do-not-call rules are handled.
// Answers describe what exists today; planned work is called planned. Faq.tsx
// composes it and inlines none of these strings. The kicker is the nav's own label
// for the section.

interface Faq {
  q: string;
  a: string;
}

export const faqCopy = {
  kicker: "FAQ",
  title: "Questions",
  sub: "Anything else, ask us on the demo.",
} as const;

export const faqs: Faq[] = [
  {
    q: "How natural does the voice sound?",
    a: "The sample on this page is a dramatised call voiced with ElevenLabs, not a recording of a real one. On the demo you'll hear the production voice speaking Hinglish, and you approve the call script before any call goes out.",
  },
  {
    q: "Does it replace my sales team?",
    a: "No. It handles the machine-time work—first calls, qualifying questions and follow-ups—so your salespeople spend their time with buyers who are ready to visit.",
  },
  {
    q: "Which tools does it work with?",
    a: "In the pilot, your leads come in as a CSV export from the system you use today, and Krate will call them and follow up on WhatsApp. Connectors for CRMs such as Zoho and HubSpot are planned; tell us what you use on the demo.",
  },
  {
    q: "How long does onboarding take?",
    a: "Setup happens in the first week of the pilot: we load your project details, agree the call script with you and set up your lead import. Calls start once you've approved the script.",
  },
  {
    q: "How does pricing work?",
    a: "During the four-week pilot there's no platform fee: you pay only for qualified site visits that happen, and nothing at all if Krate doesn't beat your current process on conversion to site visit. After that, a monthly platform fee is credited against your visit fees, so you never pay twice for the same visit. Rates are agreed per project.",
  },
  {
    q: "How are do-not-call rules handled?",
    a: "In the pilot, Krate will check your do-not-call list, quiet hours and attempt limits before every outbound call, and log every conversation so you can review it.",
  },
];

export const defaultOpenFaq = 0;
