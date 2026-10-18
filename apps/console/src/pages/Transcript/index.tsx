// Conversation transcript page (docs/security.md S7.1: a lead's words render as inert text). Reads {orgId,
// conversationId} from the URL, fetches through the transcript query hook, and renders messages as inert text nodes
// via TranscriptView (features/conversations/); a conversation with no message yet says so.
import { useParams } from "wouter";
import { useTranscriptQuery } from "../../features/conversations/api";
import { TranscriptView } from "../../features/conversations/TranscriptView";
import { PageHeader } from "../../ui/layout";
import { Card, DataShell } from "../../ui/primitives";

export function TranscriptPage() {
  const { orgId, conversationId } = useParams<{
    orgId: string;
    conversationId: string;
  }>();
  const { data, isLoading, isError } = useTranscriptQuery(
    orgId,
    conversationId,
  );
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Transcript"
        description="Every message in this conversation, verbatim."
      />
      <DataShell
        isLoading={isLoading}
        isError={isError || !data}
        isEmpty={data?.messages.length === 0}
        loadingText="Loading transcript…"
        errorText="Transcript unavailable."
        emptyText="No messages in this conversation yet."
      >
        <Card padding="lg">
          <TranscriptView messages={data?.messages ?? []} />
        </Card>
      </DataShell>
    </div>
  );
}
