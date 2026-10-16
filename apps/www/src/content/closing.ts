import { bookingCopy } from "./booking";

// The closing invitation on the clay panel — a specific promise of what the demo
// covers. FooterCta.tsx composes it and inlines none of these strings. The kicker
// is the demo's own length line, the same one the booking dialog shows.

export const closing = {
  kicker: bookingCopy.length,
  title: "See how Krate would handle your next property enquiry.",
  sub: "Hear a sample call, review the qualification summary, and see how a site visit gets booked.",
  coversTitle: "What the 30 minutes cover",
  covers: [
    "A sample call on your own project",
    "The qualification summary your team receives",
    "How a site visit gets booked and confirmed",
    "The four-week pilot, and whether it fits",
  ],
} as const;
