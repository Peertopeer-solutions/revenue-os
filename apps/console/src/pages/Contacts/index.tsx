// Contacts — the /o/:orgId/contacts route surface, composed from ui/ primitives. Data via useContactsQuery
// (features/contacts/api.ts); loading / error / empty handled where the data lands. Names deep-link to the contact's
// latest conversation through the shared <ConversationLink> (features/conversations — null renders plain text, no
// anchor); all cells render inert text nodes only (docs/security.md S7.1). A person finds any lead by name or number
// and marks them do-not-call here, after a second click to confirm, since nothing in the console lifts a block: only
// the lead's own written YES does.
import { useState } from "react";
import { useParams } from "wouter";
import {
  type ContactsResponse,
  useContactsQuery,
  useMarkDoNotCall,
} from "../../features/contacts/api";
import {
  DoNotCallCell,
  saveFailure,
} from "../../features/contacts/DoNotCallCell";
import { ConversationLink } from "../../features/conversations/ConversationLink";
import { PageHeader } from "../../ui/layout";
import {
  Badge,
  Button,
  Card,
  DataShell,
  Input,
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

/** One lead's do-not-call cell: its save, and whether the person is confirming it. */
function DoNotCall({ orgId, contact }: { orgId: string; contact: ContactRow }) {
  const mark = useMarkDoNotCall(orgId);
  const [confirming, setConfirming] = useState(false);
  return (
    <DoNotCallCell
      blocked={contact.do_not_call}
      confirming={confirming}
      saving={mark.isPending}
      failed={mark.isError ? saveFailure(mark.error) : null}
      // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
      onMark={() => setConfirming(true)}
      // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
      onConfirm={() => mark.mutate(contact.id)}
      // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
      onCancel={() => setConfirming(false)}
    />
  );
}

export function ContactsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [search, setSearch] = useState("");
  const { data, isLoading, isError } = useContactsQuery(orgId, search);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Contacts"
        actions={
          <form
            role="search"
            className="flex items-center gap-2"
            // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
            onSubmit={(e) => {
              e.preventDefault(); // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
              setSearch(String(new FormData(e.currentTarget).get("q")).trim()); // coverage: browser-only (apps/console/e2e/do-not-call.e2e.ts)
            }}
          >
            <Input
              name="q"
              maxLength={100}
              aria-label="Search leads by name or phone number"
              placeholder="Name or phone number"
              className="w-64"
            />
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>
        }
      />
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
