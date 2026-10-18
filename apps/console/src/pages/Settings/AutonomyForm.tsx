// The autonomy form of the Settings page's Guardrails section: for each AI tool, whether it runs by itself, waits for
// a person's approval or is forbidden, with its own save call, and under it what that save did (SaveStatus).
import {
  type GuardrailPolicy,
  useUpdateGuardrailPolicy,
} from "../../features/guardrails/api";
import { Button } from "../../ui/primitives";
import { asStr, Field } from "./Field";
import { SaveStatus } from "./SaveStatus";

const AUTONOMY_TIERS = ["auto", "approval", "forbidden"] as const;
const SELECT_CLASS =
  "h-10 w-full rounded-control border border-line bg-surface px-3.5 text-sm text-ink outline-none transition-colors focus:border-ink/40";

export function AutonomyForm({
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
      aria-label="Autonomy"
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const next: Record<string, unknown> = {};
        for (const tool of Object.keys(config)) next[tool] = asStr(f.get(tool));
        update.mutate({
          key: "autonomy",
          config: next,
          active: policy.active,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.keys(config).map((tool) => (
          <Field key={tool} id={`autonomy-${tool}`} label={tool}>
            <select
              id={`autonomy-${tool}`}
              name={tool}
              defaultValue={asStr(config[tool])}
              className={SELECT_CLASS}
            >
              {AUTONOMY_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
      <div>
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
