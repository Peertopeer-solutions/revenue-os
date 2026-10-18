// Contacts — the /o/:orgId/contacts route surface, composed from ui/ primitives. Data via useContactsQuery
// (features/contacts/api.ts); loading / error / empty handled where the data lands. Names deep-link to the contact's
// latest conversation through the shared <ConversationLink> (features/conversations — null renders plain text, no
// anchor); all cells render inert text nodes only (docs/security.md S7.1). A person marks a lead do-not-call here,
// after a second click to confirm, since nothing in the console lifts a block: only the lead's own written YES does.
import { useState } from "react";
import { useParams } from "wouter";
import {
  type ContactsResponse,
  useContactsQuery,
  useMarkDoNotCall,
} from "../../features/contacts/api";
import { ConversationLink } from "../../features/conversations/ConversationLink";
import { PageHeader } from "../../ui/layout";
import {
  Badge,
  Button,
  Card,
  DataShell,
  Row,
  Table,
  TD,
  TH,
  THead,
} from "../../ui/primitives";

type ContactRow = ContactsResponse["contacts"][number];

function contactName(contact: ContactRow): string {
  return (
    [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "—"
  );
}

/** A blocked lead's badge, or the button that blocks them, then asks to confirm. */
function DoNotCall({ orgId, contact }: { orgId: string; contact: ContactRow }) {
  const mark = useMarkDoNotCall(orgId);
  const [confirming, setConfirming] = useState(false);
  if (contact.do_not_call) return <Badge tone="danger">Do not call</Badge>;
  if (!confirming)
    return (
      <Button
        variant="ghost"
        size="sm"
        // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
        onClick={() => setConfirming(true)}
      >
        Mark do not call
      </Button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink-soft">
        Block every call and message?
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={mark.isPending}
        // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
        onClick={() => mark.mutate(contact.id)}
      >
        Block
      </Button>
      <Button
        variant="ghost"
        size="sm"
        // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
      {mark.isError ? (
        <span role="alert" className="text-sm text-danger">
          Not saved. Try again.
        </span>
      ) : null}
    </span>
  );
}

export function ContactsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { data, isLoading, isError } = useContactsQuery(orgId);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader title="Contacts" />
      <DataShell
        isLoading={isLoading}
        isError={isError || !data}
        isEmpty={data?.contacts.length === 0}
        emptyText="No contacts."
      >
        <Card padding="lg">
          <Table>
            <THead>
              <TH>Name</TH>
              <TH>Lifecycle stage</TH>
              <TH>Score</TH>
              <TH>Last interaction</TH>
              <TH>Do not call</TH>
            </THead>
            <tbody>
              {data?.contacts.map((contact) => (
                <Row key={contact.id}>
                  <TD tone="ink" className="font-medium">
                    <ConversationLink
                      orgId={orgId}
                      conversationId={contact.latest_conversation_id}
                    >
                      {contactName(contact)}
                    </ConversationLink>
                  </TD>
                  <TD>
                    <Badge tone="neutral">{contact.lifecycle_stage}</Badge>
                  </TD>
                  <TD>{contact.score ?? "—"}</TD>
                  <TD>{contact.last_interaction_at ?? "—"}</TD>
                  <TD>
                    <DoNotCall orgId={orgId} contact={contact} />
                  </TD>
                </Row>
              ))}
            </tbody>
          </Table>
        </Card>
      </DataShell>
    </div>
  );
}
