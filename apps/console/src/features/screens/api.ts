// The console's tasks, conversations and dashboard reads. Server state goes through TanStack Query hooks with keys
// from the queryKeys factory, and each response is Zod-parsed here, so a hook's data type is z.infer of its schema,
// never a hand-written shape (apps/console/src/features/README.md). The contacts list is features/contacts/api.ts.
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../../lib/api";

export const queryKeys = {
  tasks: (orgId: string) => ["tasks", orgId] as const,
  conversations: (orgId: string) => ["conversations", orgId] as const,
  metrics: (orgId: string) => ["metrics", orgId] as const,
  trends: (orgId: string) => ["trends", orgId] as const,
};

const TasksResponse = z.object({
  tasks: z.array(
    z.object({
      id: z.string().uuid(),
      kind: z.string(),
      status: z.string(),
      priority: z.number().nullable(),
      title: z.string(),
      contact_id: z.string().uuid().nullable(),
      conversation_id: z.string().uuid().nullable(),
      due_at: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});
export type TasksResponse = z.infer<typeof TasksResponse>;

export function useTasksQuery(orgId: string) {
  return useQuery({
    queryKey: queryKeys.tasks(orgId),
    queryFn: () => api(`/orgs/${orgId}/tasks`, TasksResponse),
  });
}

const ConversationsResponse = z.object({
  conversations: z.array(
    z.object({
      id: z.string().uuid(),
      channel: z.string(),
      status: z.string(),
      direction: z.string(),
      contact_name: z.string().nullable(),
      started_at: z.string().nullable(),
      ended_at: z.string().nullable(),
    }),
  ),
});
export type ConversationsResponse = z.infer<typeof ConversationsResponse>;

export function useConversationsQuery(orgId: string) {
  return useQuery({
    queryKey: queryKeys.conversations(orgId),
    queryFn: () => api(`/orgs/${orgId}/conversations`, ConversationsResponse),
  });
}

const MetricsResponse = z.object({
  metrics: z.object({
    new_leads: z.number(),
    conversations_started: z.number(),
    conversations_completed: z.number(),
    qualified: z.number(),
    bookings: z.number(),
    open_tasks: z.number(),
  }),
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;

export function useMetricsQuery(orgId: string) {
  return useQuery({
    queryKey: queryKeys.metrics(orgId),
    queryFn: () => api(`/orgs/${orgId}/metrics`, MetricsResponse),
  });
}

// The 30-day daily series behind the funnel tiles — one row per calendar day (gap-filled
// with zeros server-side), the three series mirroring funnelMetrics.
const TrendsResponse = z.object({
  trends: z.array(
    z.object({
      day: z.string(),
      new_leads: z.number(),
      conversations_started: z.number(),
      bookings: z.number(),
    }),
  ),
});
export type TrendsResponse = z.infer<typeof TrendsResponse>;

export function useTrendsQuery(orgId: string) {
  return useQuery({
    queryKey: queryKeys.trends(orgId),
    queryFn: () => api(`/orgs/${orgId}/metrics/trends`, TrendsResponse),
  });
}
