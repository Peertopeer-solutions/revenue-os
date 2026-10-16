// The pilot report, right after the Pilot section it reports on. Krate has no measured customer
// results yet, so this is an EXAMPLE of the pilot report — clearly labelled, with
// illustrative figures — never presented as a customer result. Replace with a
// real project, period, comparison and attributed quote once a pilot has run.
// \u00a0 keeps "2 BHK launch" together when the project line wraps.

export interface ReportRow {
  metric: string;
  before: string;
  after: string;
}

export const proof = {
  kicker: "Pilot report",
  badge: "Illustrative example",
  title: "What your pilot report shows",
  intro:
    "One project, four weeks, the same enquiries split between your current process and Krate. This example shows the format. The figures are illustrative, not customer results.",
  project: "Example project: 2\u00a0BHK\u00a0launch, Whitefield",
  period: "4-week pilot",
  columns: {
    metric: "Measure",
    before: "Current process (example)",
    after: "Krate (example)",
  },
  rows: [
    { metric: "Enquiries called the same day", before: "61%", after: "98%" },
    { metric: "Enquiries reached", before: "54%", after: "88%" },
    { metric: "Budget and timeline captured", before: "21%", after: "63%" },
    { metric: "Site visits booked", before: "19", after: "37" },
  ] satisfies ReportRow[],
  footnote:
    "Your report uses your own enquiries, measured the same way for both processes.",
};
