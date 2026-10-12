// The database package: the app_service client (withOrg sets request.org_id per transaction) and the queries behind it.
// G1: runtime-agnostic — no bun:* imports, no Bun globals in this package.

export {
  type AgentRow,
  listAgentsAndWorkflows,
  type WorkflowRow,
} from "./agents";
export { type ActorType, type AuditEntry, audit } from "./audit";
export { createPool, type PoolClient, withOrg } from "./client";
export {
  type ContactRow,
  type ImportSummary,
  importContacts,
  listContacts,
} from "./contacts";
export {
  type ConversationRow,
  conversationMessages,
  listConversations,
  type TranscriptRow,
} from "./conversations";
export {
  type GuardrailPolicyRow,
  listGuardrailPolicies,
  upsertGuardrailPolicy,
} from "./guardrails";
export {
  type FunnelMetrics,
  funnelMetrics,
  funnelTrends,
  type TrendRow,
} from "./metrics";
export {
  addMember,
  createOrgWithAdmin,
  isPlatformOperator,
  memberRole,
  type OrgRow,
  updateOrg,
  userOrgs,
} from "./orgs";
export { listTasks, type TaskRow } from "./tasks";
