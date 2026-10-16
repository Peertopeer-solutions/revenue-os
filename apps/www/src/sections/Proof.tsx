import { proof } from "../content/proof";
import { Heading } from "../design/Heading";
import { Kicker } from "../design/Kicker";
import { MonoLabel } from "../design/MonoLabel";
import { SectionFrame } from "../design/SectionFrame";
import { Text } from "../design/Text";
import { cx } from "../lib/cx";
import { reveal } from "../lib/reveal";
import { Icon, INFO } from "../visuals/Icon";

// The pilot report, after the Pilot section it reports on: an EXAMPLE, never a
// customer result. The "Illustrative example" tag beside the eyebrow,
// the project line, both column heads and the footnote all say so. Head left and
// the report card right from lg; stacked below. The card has a serif line beside
// a mono pill for its header and the plan cards' hairlines;
// figures are serif numerals — the current process in stone, Krate in ink.
// The comparison is a <dl> (one group per measure), so it survives the phone
// reflow for screen readers: each value carries its column name, visually hidden;
// the visible column heads are aria-hidden. From sm the two value columns keep
// one fixed width, so both heads break the same way ("(example)" on its own line);
// below sm each measure takes a full line with its two values under the heads.
const COLS =
  "grid grid-cols-2 gap-x-[16px] sm:grid-cols-[1fr_128px_128px] sm:gap-x-[24px]";
const HEAD = "font-mono text-[11px] uppercase tracking-[0.1em]";
const VALUE =
  "font-serif text-[26px] leading-none tracking-[-0.02em] max-sm:mt-[12px] sm:text-right";

export function Proof() {
  const { columns } = proof;
  return (
    <SectionFrame flush aria-labelledby="proof-title">
      <div className="grid gap-[36px] pt-[48px] pb-[64px] md:gap-[48px] md:pt-[64px] md:pb-[88px] lg:grid-cols-12 lg:gap-x-[40px]">
        <div {...reveal(200)} className="lg:col-span-5">
          <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[10px]">
            <Kicker>{proof.kicker}</Kicker>
            <MonoLabel className="inline-flex rounded-full border border-line px-[10px] py-[5px] text-[11px] text-stone uppercase tracking-[0.1em]">
              {proof.badge}
            </MonoLabel>
          </div>
          <Heading id="proof-title" className="mt-[20px]">
            {proof.title}
          </Heading>
          <Text className="mt-[20px] max-w-[52ch]">{proof.intro}</Text>
        </div>
        <div {...reveal(280)} className="lg:col-span-7">
          <div className="rounded-[24px] bg-paper-2 p-[20px] sm:p-[28px]">
            <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[10px]">
              <p className="text-balance font-serif text-[18px] text-ink leading-[1.3] tracking-[-0.01em]">
                {proof.project}
              </p>
              <MonoLabel className="flex h-[26px] items-center whitespace-nowrap rounded-full border border-line bg-paper px-[10px] text-[11px] text-ink-2">
                {proof.period}
              </MonoLabel>
            </div>
            <div
              aria-hidden="true"
              className={cx(
                COLS,
                HEAD,
                "mt-[24px] items-end border-line border-b pb-[10px]",
              )}
            >
              <span className="text-stone max-sm:hidden">{columns.metric}</span>
              <span className="text-stone sm:text-right">{columns.before}</span>
              <span className="text-ink sm:text-right">{columns.after}</span>
            </div>
            <dl>
              {proof.rows.map((row) => (
                <div
                  key={row.metric}
                  className={cx(
                    COLS,
                    "items-baseline border-line border-b py-[16px] last:border-b-0 last:pb-0",
                  )}
                >
                  <dt className="col-span-2 text-pretty text-[15.5px] text-ink-2 leading-[1.4] sm:col-span-1">
                    {row.metric}
                  </dt>
                  <dd className={cx(VALUE, "text-stone")}>
                    <span className="sr-only">{columns.before} </span>
                    {row.before}
                  </dd>
                  <dd className={cx(VALUE, "text-ink")}>
                    <span className="sr-only">{columns.after} </span>
                    {row.after}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <Text size="small" tone="muted" className="mt-[16px]">
            <Icon
              d={INFO}
              className="mr-[8px] inline-block size-[15px] align-[-3px]"
            />
            {proof.footnote}
          </Text>
        </div>
      </div>
    </SectionFrame>
  );
}
