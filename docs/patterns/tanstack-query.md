# Pattern: TanStack Query (a feature's query and save) — the guardrail settings screen
Server state lives in one `api.ts` per feature, as query hooks. This is an excerpt of the real file the Settings
screen's guardrail form uses (`bun run guards` fails when it no longer matches):

```ts
// apps/console/src/features/guardrails/api.ts
export const queryKeys = {
  guardrailPolicies: (orgId: string) => ["guardrail-policies", orgId] as const,
};
…
const GuardrailPoliciesResponse = z.object({ policies: z.array(Policy) });
…
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
```
`api()` (`apps/console/src/lib/api.ts`) sends the signed-in person's token and parses every response with the
schema it is given, so a hook's data is exactly that schema's type. The response shape (`Policy`, left out above)
is still written here by hand rather than taken from packages/shared; Slice 5 · "Each API response is described
once, in packages/shared…" moves it there, and a new feature should take its response shape from packages/shared
once that lands.

Rules: query keys come only from the feature's own key factory, its `queryKeys` · every response is parsed by
`api()` with a Zod schema · a save's body is parsed with the same packages/shared schema the route parses, before it
is sent · a save invalidates the queries it changed, and no screen updates optimistically before the API answers
(docs/decisions-in-force/) · the API's data is read only through the hooks in a feature's `api.ts`, never
fetched in `useEffect`.
