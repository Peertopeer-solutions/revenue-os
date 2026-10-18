# test — the console's own suites

Component and unit tests for this app, env-free by construction (`bun test` +
`renderToStaticMarkup`, no DOM library, no DB or network, no new deps). A test shows what the code
does: it renders, calls or drives it, never reads its source as text. Rules about which file may
import what are lint rules (`../biome.json`, proven by `scripts/lint-structure.test.ts`), raw
HTML is refused by a guard (`scripts/guards/raw-html.sh`), and what a signed-in person sees on the
real stack is a browser test in `../e2e/`.

- `ui-smoke.test.tsx` — primitives render their token classes; every icon renders; AppShell draws
  the grouped nav.
- `data-shell.test.tsx`, `table.test.tsx`, `ui-contract.test.tsx` — the DataShell + Table
  primitives, their barrel exports, and the `ui/README.md` contract.
- `pages-adoption-*.test.tsx`, `trends-analytics.test.tsx` — each page's loading, error, empty and
  data states, in its own words; Agents lists real agents and sequences, with an honest empty state.
- `sidebar-grouping.test.tsx` — the routes manifest groups the sidebar correctly.
- `readme-coverage.test.ts` — the self-explanatory-repo guard: every console folder that holds
  source or tests carries a README with real content (≥3 non-empty lines).
- Start-up: `boot.test.tsx` (with env missing, all the console's code loads without building a
  sign-in client and the configuration screen names what is missing; with env present, the app
  runs inside its error boundary), `app-error-boundary.test.tsx`, `console-boot-honesty.test.tsx`
  (the lazy sign-in client, the env check, the landing's unreachable-versus-empty states) and
  `vite-api-url-honesty.test.tsx` (a production build needs a valid API address). The browser
  half is `../e2e/no-settings.e2e.ts`: a real build with its settings empty shows the configuration
  screen; `../e2e/smoke.e2e.ts` asks a started console for its sign-in screen and proves it fails on
  that configuration screen. `../e2e/every-screen.e2e.ts` opens every screen in the route list on the
  demo workspace, failing on an error or on missing demo rows.
- `conversation-link.test.tsx`, `transcript-xss.test.tsx` — the shared conversation link, and
  transcripts rendering hostile content as inert text.
- Sign-in front door: `auth-routing.test.tsx` (signed-out → /login?next, signed-in → a safe next,
  nothing renders while the session loads), `login-view.test.tsx` (labelled, autofill-ready form;
  pending + error states), `session-rules.test.ts` (safe `next`, fixed sign-in error copy, the auth
  state machine and when it wipes the cache), `query-client.test.ts` (retry rule; 401 → sign out),
  `org-access.test.tsx` (workspace membership check, no-access page, landing empty/error states).
  The browser half is `../e2e/auth.e2e.ts` (real local stack, run by `bun run local bun run e2e`).
- `guardrails-console.test.tsx` — the Settings guardrail section's states and forms, and what each
  form says about its save (Saving…, Saved., or why it failed); `guardrails-save.test.tsx` — what a
  save sends (a PUT checked against the shared schema, signed in) and that it refreshes the policies
  shown. The save in a real browser, kept after a reload and refused once, is
  `../e2e/settings-save.e2e.ts`.
- `test-utils.ts` — shared helpers the suites import (`visible()` / decoded `text()`, `buttons()`,
  `apiErrorFor()` real API errors, `asPrimitivesMap()` barrel cast, `mockModule()`); not a test.
- `router.tsx` — a static SSR Router harness the leaf tests render inside (not a test itself).

Run: `bun test apps/console/test/`. Tests that need the database live beside the code they test
(`packages/db/test/`, `services/worker/test/`), and the RLS checks in the repo-level `tests/`.
