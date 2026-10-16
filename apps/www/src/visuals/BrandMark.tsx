import { cx } from "../lib/cx";

// The Krate mark: a clay dot (the lead) with two ink arcs (the voice reaching
// it). Decorative — always paired with the visible wordmark — so aria-hidden.
// `live` pulses the arcs, inner then outer: the voice reaching the lead (How it
// works' window tab, while its story plays). The Nav and footer marks stay still.
const PULSE = "animate-[ro-blink_1.4s_ease-in-out_infinite]";

export function BrandMark({
  className,
  live = false,
}: {
  className?: string;
  live?: boolean;
}) {
  return (
    <svg
      viewBox="-1.25 0 28 28"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="14" r="4" className="fill-clay" />
      <path
        d="M13.66 8.34a8 8 0 0 1 0 11.32"
        className={cx("stroke-current", live && PULSE)}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M16.84 5.16a12.5 12.5 0 0 1 0 17.68"
        className={cx(
          "stroke-current",
          live && cx(PULSE, "[animation-delay:200ms]"),
        )}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
