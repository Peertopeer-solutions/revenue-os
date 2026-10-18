// The company's leads, as the console reads them: the contacts list (GET /orgs/:orgId/contacts). Server state goes
// through TanStack Query hooks with keys from the queryKeys factory, and the response is Zod-parsed here, so the
// hook's data type is z.infer of its schema (apps/console/src/features/README.md).
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../../lib/api";

export const queryKeys = {
  contacts: (orgId: string) => ["contacts", orgId] as const,
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
      // task 17: id of the contact's newest conversation (by started_at), for the transcript
      // deep-link; null when the contact has no conversations yet.
      latest_conversation_id: z.string().uuid().nullable(),
    }),
  ),
});
export type ContactsResponse = z.infer<typeof ContactsResponse>;

export function useContactsQuery(orgId: string) {
  return useQuery({
    queryKey: queryKeys.contacts(orgId),
    queryFn: () => api(`/orgs/${orgId}/contacts`, ContactsResponse),
  });
}
