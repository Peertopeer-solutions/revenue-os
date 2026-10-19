# Pattern: React component tiers (primitive → feature component → page)
The console (`apps/console/src`) builds every screen from three tiers. Each example below is an excerpt of the real
file named on its first line (`bun run guards` fails when it no longer matches).

A **primitive** (`apps/console/src/ui/primitives/`): typed props and design tokens only, no data, no app logic.
```tsx
// apps/console/src/ui/primitives/Badge.tsx
const TONES = {
  neutral: "bg-nav-active text-ink-soft",
  accent: "bg-accent-soft text-accent",
  danger: "bg-danger/10 text-danger",
} as const;

export type BadgeProps = ComponentProps<"span"> & {
  tone?: keyof typeof TONES;
};

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
```

A **feature component** (`apps/console/src/features/<domain>/`): one domain's markup, everything it shows passed in
as props: no query hook and no sign-in client, so a unit test renders it as it is. This one was promoted here when a
second page needed the same link, instead of being copied.
```tsx
// apps/console/src/features/conversations/ConversationLink.tsx
export function ConversationLink({
  orgId,
  conversationId,
  children,
}: {
  orgId: string;
  conversationId: string | null;
  children: ReactNode;
}) {
  return conversationId ? (
    <Link
      href={`/o/${orgId}/conversations/${conversationId}`}
      className="text-accent hover:underline"
    >
      {children}
    </Link>
  ) : (
    children
  );
}
```

A **page** (`apps/console/src/pages/<Name>/index.tsx`) only composes: server state from a `features/*` query hook,
laid out with primitives, its loading, error and empty states through `DataShell`. The company id from the web
address only picks what to show; the API decides what the signed-in person may see.
```tsx
// apps/console/src/pages/Conversations/index.tsx
export function ConversationsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { data, isLoading, isError } = useConversationsQuery(orgId);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader title="Conversations" />
      <DataShell
        isLoading={isLoading}
        isError={isError || !data}
        isEmpty={data?.conversations.length === 0}
        emptyText="No conversations."
      >
        …
              {data?.conversations.map((c) => (
                <Row key={c.id}>
                  <TD tone="ink" className="font-medium">
                    <ConversationLink orgId={orgId} conversationId={c.id}>
                      {c.contact_name ?? "Unknown"}
                    </ConversationLink>
                  </TD>
                  …
                  <TD>
                    <Badge
                      tone={
                        ACTIVE_STATUSES.has(c.status) ? "accent" : "neutral"
                      }
                    >
                      {c.status}
                    </Badge>
                  </TD>
                  …
```
Rules: a component file stays at 150 lines or fewer, or a part of it moves out (as the Settings page's two guardrail
forms moved to `apps/console/src/pages/Settings/QuietHoursForm.tsx` and `AutonomyForm.tsx`) · primitives take typed props and use design tokens, with
no data or app logic · a feature component gets everything it shows as props, never from a query hook or the
sign-in client · a page only composes, and never fetches or re-declares a response shape · loading, error and empty
go through `DataShell` where the data lands · second usage → promote: a piece a second screen needs moves into its
feature folder or the primitives, never a copy.
