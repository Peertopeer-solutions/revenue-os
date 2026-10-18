// Settings — org info from the orgs hook, plus the live Guardrails section: GET for any member, PUT
// admin-only. quiet_hours + autonomy are EDITABLE, each its own form with its own save that says what
// it did (QuietHoursForm.tsx, AutonomyForm.tsx); attempt_caps + dnc render READ-ONLY. Every value comes from the server — nothing is fabricated
// when there's no data. The mutation validates against the shared GuardrailPolicyInputSchema
// (the harness reads quiet_hours config FAIL-OPEN, so that Zod is the real safety boundary).
import { useParams } from "wouter";
import {
  type GuardrailPolicy,
  useGuardrailPoliciesQuery,
} from "../../features/guardrails/api";
import { useOrgsQuery } from "../../features/orgs/api";
import { PageHeader, Section } from "../../ui/layout";
import { Badge, Card, DataShell } from "../../ui/primitives";
import { AutonomyForm } from "./AutonomyForm";
import { QuietHoursForm } from "./QuietHoursForm";

function OrganizationCard({ orgId }: { orgId: string }) {
  const { data, isLoading, isError } = useOrgsQuery();
  // data?. per the DataShell narrowing tradeoff: children build eagerly, so the org
  // lookup runs even on the non-happy branches DataShell discards (ui/README).
  const org = data?.find((candidate) => candidate.id === orgId);
  return (
    <DataShell
      isLoading={isLoading}
      isError={isError || !data}
      errorText="Unable to load organization."
    >
      {org ? (
        <Card padding="lg">
          <dl className="grid gap-6 sm:grid-cols-3">
            <div>
              <dt className="text-label text-muted uppercase">Name</dt>
              <dd className="mt-1.5 text-body text-ink">{org.name}</dd>
            </div>
            <div>
              <dt className="text-label text-muted uppercase">Slug</dt>
              <dd className="mt-1.5 text-body text-ink-soft">{org.slug}</dd>
            </div>
            <div>
              <dt className="text-label text-muted uppercase">Your role</dt>
              <dd className="mt-1.5">
                <Badge>{org.role}</Badge>
              </dd>
            </div>
          </dl>
        </Card>
      ) : (
        <p className="text-sm text-muted">
          This organization isn't in your list.
        </p>
      )}
    </DataShell>
  );
}

const GUARDRAIL_LABELS: Record<string, string> = {
  quiet_hours: "Quiet hours",
  attempt_caps: "Attempt caps",
  dnc: "Do not contact",
  autonomy: "Autonomy",
};

const capText = (cap: unknown): string => {
  const c = cap as { max?: number; per_hours?: number };
  return `up to ${c.max} every ${c.per_hours}h`;
};

function GuardrailsCard({ orgId }: { orgId: string }) {
  const { data, isLoading, isError } = useGuardrailPoliciesQuery(orgId);
  const policies = data?.policies ?? [];

  // Not a hook — a plain per-policy renderer. quiet_hours + autonomy are editable (each its own form with its own
  // save, QuietHoursForm.tsx and AutonomyForm.tsx); attempt_caps + dnc are read-only text.
  function body(policy: GuardrailPolicy) {
    const config = policy.config;
    switch (policy.key) {
      case "quiet_hours":
        return <QuietHoursForm orgId={orgId} policy={policy} />;
      case "autonomy":
        return <AutonomyForm orgId={orgId} policy={policy} />;
      case "attempt_caps":
        return (
          <dl className="grid gap-2 sm:grid-cols-2">
            {Object.entries(config).map(([channel, cap]) => (
              <div
                key={channel}
                className="flex items-baseline justify-between gap-3"
              >
                <dt className="text-body text-ink">{channel}</dt>
                <dd className="text-sm text-ink-soft">{capText(cap)}</dd>
              </div>
            ))}
          </dl>
        );
      case "dnc":
        return (
          <p className="text-sm text-ink-soft">
            Hard stop {config.hard_stop === true ? "enabled" : "disabled"}.
          </p>
        );
      default:
        return null;
    }
  }

  return (
    <DataShell
      isLoading={isLoading}
      isError={isError || !data}
      isEmpty={policies.length === 0}
      errorText="Unable to load guardrails."
      emptyText="No guardrail policies are configured yet."
    >
      <div className="grid gap-4">
        {policies.map((policy) => (
          <Card key={policy.key} padding="lg">
            <h3 className="pb-3 text-body font-medium text-ink">
              {GUARDRAIL_LABELS[policy.key] ?? policy.key}
            </h3>
            {body(policy)}
          </Card>
        ))}
      </div>
    </DataShell>
  );
}

export function SettingsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader title="Settings" />
      <Section label="Organization">
        <OrganizationCard orgId={orgId} />
      </Section>
      <Section label="Guardrails" className="mt-10">
        <GuardrailsCard orgId={orgId} />
      </Section>
    </div>
  );
}
