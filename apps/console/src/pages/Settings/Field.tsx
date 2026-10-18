// One labelled field of a Settings form (its label above its control), and the text a policy's config value shows in
// a field: the value when it is text, else nothing. Shared by QuietHoursForm and AutonomyForm.
import type { ReactNode } from "react";

export const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

export function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-label text-muted uppercase">
        {label}
      </label>
      {children}
    </div>
  );
}
