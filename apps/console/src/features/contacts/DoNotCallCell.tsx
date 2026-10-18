// What a lead's do-not-call cell on the Contacts screen shows: a blocked lead's badge (nothing in the console lifts a
// block: only the lead's own written YES does), the button that blocks an open lead, or the step that confirms it.
// Prop-driven and env-free, so every state renders in unit tests; the page holds the save and the clicks.
import { ApiError } from "@revenue-os/shared";
import { Badge, Button } from "../../ui/primitives";

/** What a person is told when the save of a block failed. */
export function saveFailure(error: unknown): string {
  return error instanceof ApiError && error.status === 403
    ? "Only an operator or admin can block a lead."
    : "Not saved. Try again.";
}

export function DoNotCallCell(props: {
  blocked: boolean;
  confirming: boolean;
  saving: boolean;
  failed: string | null;
  onMark: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (props.blocked) return <Badge tone="danger">Do not call</Badge>;
  if (!props.confirming)
    return (
      <Button variant="ghost" size="sm" onClick={props.onMark}>
        Mark do not call
      </Button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-soft">
        Block every call and message?
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={props.saving}
        onClick={props.onConfirm}
      >
        Block
      </Button>
      <Button variant="ghost" size="sm" onClick={props.onCancel}>
        Cancel
      </Button>
      {props.failed ? (
        <span role="alert" className="text-sm text-danger">
          {props.failed}
        </span>
      ) : null}
    </span>
  );
}
