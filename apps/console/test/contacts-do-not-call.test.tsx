// Finding a lead and marking them do-not-call from the Contacts page, through the real page and the real hooks it
// calls (features/contacts/api.ts), with only the network and the sign-in session faked: a blocked lead shows its
// badge and no way to block or lift it, an open lead shows the button; a search fetches the leads matching it; the
// save sends a POST, signed in, to the lead's do-not-call address, then marks the contacts list out of date so the
// page fetches it again, and a save the worker refuses refreshes nothing. The cell's confirm step and its messages are
// do-not-call-cell.test.tsx; clicking through it in a real browser is apps/console/e2e/do-not-call.e2e.ts.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Router } from "wouter";
import {
  queryKeys,
  useContactsQuery,
  useMarkDoNotCall,
} from "../src/features/contacts/api";
import * as realSupabase from "../src/lib/supabase";
import { ContactsPage } from "../src/pages/Contacts";
import { buttons, mockModule, visible } from "./test-utils";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "33333333-3333-4333-8333-333333333333";
const restoreSupabase = mockModule("../src/lib/supabase", realSupabase, {
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "signed-in-token" } },
      }),
    },
  }),
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(restoreSupabase);

/** Fakes the network: records each request and answers with `status` and `body`. */
function network(status: number, body: unknown) {
  const sent: { path: string; search: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    sent.push({ path: pathname, search, init });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return sent;
}

const lead = (doNotCall: boolean) => ({
  id: LEAD,
  first_name: "Meera",
  last_name: "Rao",
  lifecycle_stage: "new",
  score: null,
  last_interaction_at: null,
  created_at: "2026-10-18T00:00:00Z",
  latest_conversation_id: null,
  do_not_call: doNotCall,
});

/** The Contacts page as a signed-in person sees it, the contacts list already fetched. */
function page(doNotCall: boolean): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.contacts(ORG), {
    contacts: [lead(doNotCall)],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Router ssrPath={`/o/${ORG}/contacts`}>
        <Route path="/o/:orgId/contacts">
          <ContactsPage />
        </Route>
      </Router>
    </QueryClientProvider>,
  );
}

/** The two hooks the page calls, as one render leaves them. */
function hooks() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(queryKeys.contacts(ORG), { contacts: [lead(false)] });
  let mark: ReturnType<typeof useMarkDoNotCall> | undefined;
  function Probe() {
    useContactsQuery(ORG);
    mark = useMarkDoNotCall(ORG);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  const shown = client.getQueryCache().find({
    queryKey: queryKeys.contacts(ORG),
  });
  if (!mark || !shown) throw new Error("the hooks did not render");
  return { mark, shown };
}

describe("the Contacts page's do-not-call column", () => {
  it("an open lead shows the button that blocks them, beside the search", () => {
    const html = page(false);
    expect(buttons(html)).toEqual(["Search", "Mark do not call"]);
    expect(visible(html)).toContain("Do not call"); // the column's heading
    expect(html).toContain('aria-label="Search leads by name or phone number"');
  });

  it("a blocked lead shows its badge, and nothing to block or lift them with", () => {
    const html = page(true);
    expect(buttons(html)).toEqual(["Search"]);
    expect(html).toMatch(
      /<span class="[^"]*text-danger[^"]*">Do not call<\/span>/,
    );
  });
});

describe("useContactsQuery", () => {
  it("fetches the leads matching a search, signed in, and the latest leads without one", async () => {
    const sent = network(200, { contacts: [] });
    const client = new QueryClient();
    let search: ReturnType<typeof useContactsQuery> | undefined;
    let latest: ReturnType<typeof useContactsQuery> | undefined;
    function Probe() {
      search = useContactsQuery(ORG, "Meera R&9876");
      latest = useContactsQuery(ORG);
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await search?.refetch();
    await latest?.refetch();
    expect(sent.map((r) => r.path + r.search)).toEqual([
      `/orgs/${ORG}/contacts?q=Meera%20R%269876`,
      `/orgs/${ORG}/contacts`,
    ]);
    expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe(
      "Bearer signed-in-token",
    );
    expect(queryKeys.contacts(ORG, "x").slice(0, 2)).toEqual(
      queryKeys.contacts(ORG),
    );
  });
});

describe("useMarkDoNotCall", () => {
  it("sends a POST, signed in, to the lead's do-not-call address, then refreshes the contacts list", async () => {
    const sent = network(200, { do_not_call: true });
    const { mark, shown } = hooks();
    expect(shown.state.isInvalidated).toBe(false);

    expect(await mark.mutateAsync(LEAD)).toEqual({ do_not_call: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/orgs/${ORG}/contacts/${LEAD}/do-not-call`);
    expect(sent[0]?.init.method).toBe("POST");
    expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe(
      "Bearer signed-in-token",
    );
    expect(shown.state.isInvalidated).toBe(true);
  });

  it("a save the worker refuses fails with its reason, and nothing is refreshed", async () => {
    network(403, { error: "forbidden" });
    const { mark, shown } = hooks();
    await expect(mark.mutateAsync(LEAD)).rejects.toMatchObject({
      status: 403,
    });
    expect(shown.state.isInvalidated).toBe(false);
  });
});
