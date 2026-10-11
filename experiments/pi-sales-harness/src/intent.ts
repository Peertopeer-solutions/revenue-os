// Prototype (experiments/pi-sales-harness/README.md). The lead-intent tool's contract, with a PLACEHOLDER behind
// it: a few keyword rules, so the shape can be seen end to end. It is not a model, makes no prediction and has
// never been measured; its result says so in every field a caller could mistake for a score.
import type { IntentLabel, LifecycleStage, ScopedReader } from "./tenancy";

/** What intent is worked out from: the lead's own rows, read by the host, never typed in by the model. */
export type IntentInput = {
  stage: LifecycleStage;
  doNotCall: boolean;
  lastLeadMessage: string | null;
  leadMessages: number;
};

export type IntentResult = {
  status: "placeholder";
  label: IntentLabel;
  isPrediction: false;
  confidence: null;
  signals: string[];
  method: string;
};

export function intentInputOf(reader: ScopedReader): IntentInput {
  const lead = reader.lead();
  const said = reader.interactions().filter((i) => i.from === "lead");
  return {
    stage: lead.stage,
    doNotCall: lead.consent.dnc || lead.stage === "dnc",
    lastLeadMessage: said.at(-1)?.text ?? null,
    leadMessages: said.length,
  };
}

// First match wins, so a refusal outranks everything after it.
const RULES: [IntentLabel, RegExp][] = [
  ["opted_out", /\b(stop|unsubscribe|not interested|don'?t (call|message))\b/i],
  [
    "ready_to_visit",
    /\b(site visit|visit the site|come (over|by)|see the (site|flat))\b/i,
  ],
  [
    "needs_more_info",
    /\b(price|cost|details|brochure|floor ?plan|emi|loan|how much)\b/i,
  ],
  ["not_now", /\b(later|after|next (week|month)|busy)\b/i],
];

export function placeholderIntent(input: IntentInput): IntentResult {
  const text = input.lastLeadMessage ?? "";
  const rule = input.doNotCall
    ? undefined
    : RULES.find(([, words]) => words.test(text));
  return {
    status: "placeholder",
    label: input.doNotCall ? "opted_out" : (rule?.[0] ?? "unclear"),
    isPrediction: false,
    confidence: null,
    signals: input.doNotCall
      ? ["the lead is marked do-not-call"]
      : rule
        ? [`the last message says "${text.match(rule[1])?.[0]}"`]
        : ["no rule matched the last message"],
    method:
      "keyword rules for illustration only; a measured method replaces them before any real use",
  };
}
