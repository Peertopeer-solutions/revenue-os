// The database package: the app_service client (withOrg sets request.org_id per transaction) and the queries behind it.
// G1: runtime-agnostic — no bun:* imports, no Bun globals in this package.

export {
  type AgentRow,
  listAgentsAndWorkflows,
  type WorkflowRow,
} from "./agents";
export { type ActorType, type AuditEntry, audit } from "./audit";
export { createPool, type Db, type PoolClient, withOrg } from "./client";
export {
  type OptInSource,
  recordDoNotCall,
  recordWhatsAppOptIn,
  withdrawWhatsAppOptIn,
} from "./consent";
export {
  type ContactRow,
  type ImportSummary,
  importContacts,
  leadsWithNumber,
  listContacts,
} from "./contacts";
export {
  addMessage,
  type ConversationRow,
  type ConvoStatus,
  conversationMessages,
  finishConversation,
  listConversations,
  openConversation,
  type TranscriptRow,
} from "./conversations";
export {
  type GuardrailPolicyRow,
  listGuardrailPolicies,
  upsertGuardrailPolicy,
} from "./guardrails";
export { leadNumber } from "./lead-numbers";
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
export { createTask, listTasks, type TaskKind, type TaskRow } from "./tasks";
