// What a Settings form says under its Save button about its last save: "Saving…" while the API works, "Saved." once
// it has answered, or why the save failed, as an alert. Nothing before the first save. Shared by QuietHoursForm and
// AutonomyForm.
import { ApiError } from "@revenue-os/shared";

/** PURE: why a save failed, in a person's words. Anything but an API error is the shared schema refusing a value. */
export function notSaved(error: unknown): string {
  if (!(error instanceof ApiError)) return "Not saved: fill in every field.";
  if (error.status === 0)
    return error.code === "timeout"
      ? "Not saved: the API took too long to answer. Try again."
      : "Not saved: the API can't be reached. Try again.";
  if (error.status === 403)
    return "Not saved: only an admin can change guardrails.";
  return `Not saved: the API answered ${error.status}. Try again.`;
}

export type SaveState = {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
};

export function SaveStatus({ save }: { save: SaveState }) {
  if (save.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        {notSaved(save.error)}
      </p>
    );
  if (!save.isPending && !save.isSuccess) return null;
  return (
    <p role="status" className="text-sm text-muted">
      {save.isPending ? "Saving…" : "Saved."}
    </p>
  );
}
