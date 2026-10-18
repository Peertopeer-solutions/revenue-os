// Data-page state shell — the loading / error / empty / content branch every data page
// hand-rolls, promoted to one primitive (docs/patterns/react-component.md, "second usage → promote"). Dumb: typed
// props, tokens only; precedence loading > error > empty > children (children render only on the
// happy path). Each non-happy state is a calm muted <p>, matching today's page copy, marked with the state it is in
// (data-state="loading" | "error" | "empty"), which the browser check that opens every screen reads
// (apps/console/e2e/every-screen.e2e.ts): a screen left loading, failing or empty on the demo workspace fails it.
import type { ReactNode } from "react";

const STATE = "text-sm text-muted";

export type DataShellProps = {
  isLoading: boolean;
  isError: boolean;
  isEmpty?: boolean;
  loadingText?: string;
  errorText?: string;
  emptyText?: string;
  children?: ReactNode;
};

export function DataShell({
  isLoading,
  isError,
  isEmpty,
  loadingText = "Loading…",
  errorText = "Unable to load data.",
  emptyText = "Nothing here yet.",
  children,
}: DataShellProps) {
  if (isLoading)
    return (
      <p className={STATE} data-state="loading">
        {loadingText}
      </p>
    );
  if (isError)
    return (
      <p className={STATE} data-state="error">
        {errorText}
      </p>
    );
  if (isEmpty)
    return (
      <p className={STATE} data-state="empty">
        {emptyText}
      </p>
    );
  return <>{children}</>;
}
