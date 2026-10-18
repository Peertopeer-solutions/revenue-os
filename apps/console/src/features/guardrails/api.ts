// R2: server state through TanStack Query hooks in features/*/api.ts, keys from the queryKeys
// factory. The GET envelope is Zod-parsed here (R6); the mutation body is validated with the shared
// GuardrailPolicyInputSchema — the SAME boundary the PUT route parses — before it leaves the browser.
import { GuardrailPolicyInputSchema } from "@revenue-os/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../../lib/api";

export const queryKeys = {
  guardrailPolicies: (orgId: string) => ["guardrail-policies", orgId] as const,
};

const Policy = z.object({
  key: z.string(),
  config: z.record(z.string(), z.unknown()),
  active: z.boolean(),
  updated_at: z.string(),
});
const GuardrailPoliciesResponse = z.object({ policies: z.array(Policy) });
export type GuardrailPoliciesResponse = z.infer<
  typeof GuardrailPoliciesResponse
>;
export type GuardrailPolicy = GuardrailPoliciesResponse["policies"][number];
const PolicyResponse = z.object({ policy: Policy });

export function useGuardrailPoliciesQuery(orgId: string) {
  return useQuery({
    queryKey: queryKeys.guardrailPolicies(orgId),
    queryFn: () =>
      api(`/orgs/${orgId}/guardrail-policies`, GuardrailPoliciesResponse),
  });
}

export function useUpdateGuardrailPolicy(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Validate against the shared boundary schema BEFORE sending — a malformed config never
    // reaches the network. The route re-parses server-side; this is the browser-side belt.
    mutationFn: (input: unknown) =>
      api(`/orgs/${orgId}/guardrail-policies`, PolicyResponse, {
        method: "PUT",
        body: GuardrailPolicyInputSchema.parse(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.guardrailPolicies(orgId),
      });
    },
  });
}
