// The hero's copy, the sample recording its listen button plays in place, the
// result card that sits on the drawing (one ready buyer's call, finished) and the
// drawing sheet under it. Hero, SampleAudio and SurveyGround compose these and
// inline none. The recording is a DRAMATISED call: both voices are generated with
// ElevenLabs (apps/www/scripts/make-sample-call.ts assembles the takes), Rohan is not a
// real customer, and the agent says in its first line that it is an AI assistant.
// The transcript is what is said, in the same Hinglish as the Examples section.
// Names, places and figures are illustrative. \u00a0 keeps a number with its unit.

const ILLUSTRATIVE = "Names and figures are illustrative.";

const agent = "Asha · AI";
const buyer = "Rohan";

export const sampleCall = {
  src: "/sample-call.m4a",
  seconds: 73,
  disclosure: `A dramatised call: both voices are generated with ElevenLabs, and Rohan is not a real customer. ${ILLUSTRATIVE}`,
  play: "Play sample call", // after it has finished
  pause: "Pause sample call",
  resume: "Resume sample call",
  unavailable: "The recording didn't load.",
  // What is said, line by line (WCAG 1.2.1: a text alternative for the recording).
  transcriptLabel: "Read the transcript",
  transcript: [
    {
      who: agent,
      text: "Namaste Rohan ji! Main Asha bol rahi hoon, Meridian Greens ki AI assistant. Aapne abhi Whitefield mein 2\u00a0BHK ke liye enquiry ki thi. Do minute baat ho sakti hai?",
    },
    { who: buyer, text: "Haan, haan, boliye." },
    {
      who: agent,
      text: "Aapne budget nabbe lakh tak bataya tha. Tower\u00a0B mein teen 2\u00a0BHK units hain jo usmein aa jaate hain.",
    },
    {
      who: buyer,
      text: "Accha. Carpet area kitna hai? Aur parking included hai?",
    },
    {
      who: agent,
      text: "2 BHK ka carpet area 1,050\u00a0sq\u00a0ft hai, aur ek covered parking included hai.",
    },
    { who: buyer, text: "Possession kab tak milega?" },
    {
      who: agent,
      text: "December 2027 mein. Aap kab tak shift karna chahte hain?",
    },
    { who: buyer, text: "Next year tak plan hai. Home loan bhi lena padega." },
    {
      who: agent,
      text: "Koi baat nahin, hamare loan partner se bhi baat karwa dete hain. Ek baar project dekhna chahenge?",
    },
    { who: buyer, text: "Okay. Weekend pe dekh sakte hain?" },
    { who: agent, text: "Bilkul. Saturday subah gyarah baje theek rahega?" },
    { who: buyer, text: "Haan, gyarah baje chalega." },
    {
      who: agent,
      text: "Perfect. Saturday, 11\u00a0AM, Tower\u00a0B: aapka visit book ho gaya. Location pin aur details main abhi WhatsApp pe bhej rahi hoon.",
    },
    { who: buyer, text: "Great, thank you." },
    {
      who: agent,
      text: "Thank you, Rohan ji. Saturday ko hamari sales team aapka intezaar karegi.",
    },
  ],
} as const;

export const hero = {
  eyebrow: "Voice AI for Indian real estate",
  title: "Turn property enquiries into qualified site visits.",
  sub: "Krate calls new leads in Hinglish, qualifies budget and timeline, and follows up on WhatsApp\u2060—so your sales team can focus on buyers ready to visit.",
  secondary: "Hear a sample call",
} as const;

// The card on the drawing: what one call produced, not a live call. Leads arrive
// the moment a lead lands, so speed reads "called … after it landed" (never a channel); no score is shown.
const lead = "Rohan Mehta";
const calledAfter = "2 min after it landed";
const bhk = "2\u00a0BHK";
const area = "Whitefield";
const timeline = "Within 12 months";

export const result = {
  lead,
  called: `Called ${calledAfter}`,
  captured: "Captured",
  fields: ["₹90\u00a0L", `${bhk} · ${area}`, timeline],
  outcome: "Site visit booked · Sat 11:00\u00a0AM",
  // the card as one image, in words a screen reader speaks well
  aria: `Illustrative result of one call: ${lead}'s enquiry landed at 7:12\u00a0PM, and he was called in Hinglish 2 min later. The call captured a budget of ₹90 lakh, a ${bhk} in ${area} and a timeline ${timeline.toLowerCase()}, and booked a site visit for Saturday at 11:00\u00a0AM.`,
} as const;

// The hero's ground (visuals/SurveyGround): a drawing sheet with the plan of the
// flat he asks about, lying under the card. The project, the flat and its width are
// illustrative, and the title strip says so.
export const survey = {
  title: "Meridian Greens · Tower B · Typical 2\u00a0BHK",
  illustrative: "Illustrative",
  width: "9.75\u00a0m",
} as const;
