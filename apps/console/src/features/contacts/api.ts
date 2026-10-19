// The company's leads, as the console reads and changes them: the contacts list (GET /orgs/:orgId/contacts, searched
// with ?q=) and a
// person marking a lead do-not-call (POST /orgs/:orgId/contacts/:contactId/do-not-call). Server state goes through
// TanStack Query hooks with keys from the queryKeys factory, and each response is Zod-parsed here, so a hook's data
// type is z.infer of its schema (apps/console/src/features/README.md).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../../lib/api";

// A search's key extends the company's, so marking a lead refreshes every list of the company's leads.
export const queryKeys = {
  contacts: (orgId: string, search = "") =>
    search
      ? (["contacts", orgId, search] as const)
      : (["contacts", orgId] as const),
};

const ContactsResponse = z.object({
  contacts: z.array(
    z.object({
      id: z.string().uuid(),
      first_name: z.string().nullable(),
      last_name: z.string().nullable(),
      lifecycle_stage: z.string(),
      score: z.number().nullable(),
      last_interaction_at: z.string().nullable(),
      created_at: z.string(),
      // The contact's newest conversation (by started_at), for the link to its transcript; null when there is none.
      latest_conversation_id: z.string().uuid().nullable(),
      // Blocked from every message and call: the block the guard before every send reads.
      do_not_call: z.boolean(),
    }),
  ),
});
export type ContactsResponse = z.infer<typeof ContactsResponse>;

/** The company's leads: the latest 100, or those matching `search` (a name, or digits of a number). */
export function useContactsQuery(orgId: string, search = "") {
  const query = search ? `?q=${encodeURIComponent(search)}` : "";
  return useQuery({
    queryKey: queryKeys.contacts(orgId, search),
    queryFn: () => api(`/orgs/${orgId}/contacts${query}`, ContactsResponse),
  });
}

const DoNotCallResponse = z.object({ do_not_call: z.literal(true) });

/** Marks a lead do-not-call; once the worker has saved it, the contacts list is fetched again to show it. */
export function useMarkDoNotCall(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) =>
      api(
        `/orgs/${orgId}/contacts/${contactId}/do-not-call`,
        DoNotCallResponse,
        { method: "POST" },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts(orgId) }),
  });
}
