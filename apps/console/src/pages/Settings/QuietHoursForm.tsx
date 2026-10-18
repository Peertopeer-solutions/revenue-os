// The quiet-hours form of the Settings page's Guardrails section: the window (start, end, time zone) in which no call
// or message goes out, with its own save call, and under it what that save did (SaveStatus). A change clears that
// message, and the fields wait while a save runs, so the message always speaks of the hours on screen.
import {
  type GuardrailPolicy,
  useUpdateGuardrailPolicy,
} from "../../features/guardrails/api";
import { Button, Input } from "../../ui/primitives";
import { asStr, Field } from "./Field";
import { SaveStatus } from "./SaveStatus";

export function QuietHoursForm({
  orgId,
  policy,
}: {
  orgId: string;
  policy: GuardrailPolicy;
}) {
  const update = useUpdateGuardrailPolicy(orgId);
  const config = policy.config;
  return (
    <form
      aria-label="Quiet hours"
      className="grid gap-3"
      onChange={update.reset}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        update.mutate({
          key: "quiet_hours",
          config: {
            start: asStr(f.get("start")),
            end: asStr(f.get("end")),
            tz: asStr(f.get("tz")),
          },
          active: policy.active,
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
        <Field id="qh-start" label="Start">
          <Input
            id="qh-start"
            name="start"
            type="time"
            defaultValue={asStr(config.start)}
            disabled={update.isPending}
          />
        </Field>
        <Field id="qh-end" label="End">
          <Input
            id="qh-end"
            name="end"
            type="time"
            defaultValue={asStr(config.end)}
            disabled={update.isPending}
          />
        </Field>
        <Field id="qh-tz" label="Timezone">
          <Input
            id="qh-tz"
            name="tz"
            defaultValue={asStr(config.tz)}
            disabled={update.isPending}
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={update.isPending}
        >
          Save
        </Button>
      </div>
      <SaveStatus save={update} />
    </form>
  );
}
