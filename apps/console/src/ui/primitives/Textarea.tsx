// Multi-line input — same skin as Input, comfortable min height. A design-system piece waiting for its first screen
// (one that takes long text, such as an agent's prompt): nothing renders it yet.
import type { ComponentProps } from "react";
import { cx } from "../cx";

export type TextareaProps = ComponentProps<"textarea">;

export function Textarea({ className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cx(
        "min-h-24 w-full rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm text-ink",
        "placeholder:text-muted",
        "outline-none transition-colors focus:border-ink/40",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
