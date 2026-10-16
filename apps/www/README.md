# apps/www — marketing landing page

The **marketing surface** of Revenue OS, shown to buyers as **Krate** at
https://krate.si (see **Publishing**): a landing page whose one job is to get a
qualified buyer to **book a demo**. A small **React + Vite + Tailwind v4** app (the
console's stack) that composes reusable design elements and typed content into the
page. It has no backend of its own and holds no secrets; it talks to exactly two
outside services, both through public, key-free interfaces:

- **Cal.com** (public v2 API) — lists open demo times and creates the booking.
- **Plausible** (cookieless analytics) — records the booking funnel.

## Commands

```bash
bun install                    # once, from the repo root
bun run --filter www dev       # vite dev server
bun run --filter www build     # production build → apps/www/dist
bun run --filter www preview   # serve the built dist locally
bun apps/www/scripts/make-sample-call.ts <takes>   # rebuild the sample call from its ElevenLabs takes
```

## Configuration

Set these in the deploy environment (Vite inlines `VITE_*` at build time; none is
a secret):

| Variable | What it is |
| --- | --- |
| `VITE_CALCOM_USERNAME` | The Cal.com username that owns the demo event type. |
| `VITE_CALCOM_EVENT_SLUG` | The demo event type's slug (e.g. `krate-demo`). |
| `VITE_PLAUSIBLE_SRC` | The site-specific Plausible script URL (e.g. `https://plausible.io/js/pa-XXXX.js`). |

**Preview mode.** Without the two Cal.com variables the booking flow still works
end to end on local sample times, but nothing is sent — the dialog says so, and a
production build prints a warning.
Without `VITE_PLAUSIBLE_SRC`, `track()` is a no-op (it logs in development).

### Cal.com setup (once)

1. Create a **30-minute** public event type, e.g. "Krate demo", with a video
   location and the availability you want to offer.
2. Add a booking question with the identifier **`company`** (short text,
   required). Phone uses Cal.com's attendee phone field (optional).
3. Put the username and slug in the variables above. Cal.com sends the
   confirmation email and calendar invite; the page shows its own confirmation.

### Plausible setup (once)

1. Add the site and copy its script URL into `VITE_PLAUSIBLE_SRC`.
2. Create these **custom event goals** — names must match exactly: `Demo click`,
   `Booking start`, `Booking complete`, `Booking error`, `Sample play`.
3. Create the funnel **Demo click → Booking start → Booking complete**.
4. Custom properties sent: `source` (where the booking started: nav, hero, pilot,
   closing, or `link` for a `/#book` deep link; `Sample play` sends `hero-link`,
   the hero's listen button), `heard_sample` (yes/no on completed bookings),
   `stage` and `kind` (on errors; kind is `unavailable`, `rejected`, `server` or
   `network`).
5. **Plan:** custom properties and funnels are Plausible Business-plan features. On
   a cheaper plan only the five goal counts are available (no funnel, no split by
   source or `heard_sample`).

### Measuring (how to use the numbers)

Run the page unchanged long enough to get a baseline (a few weeks, or a few
hundred demo clicks), then change **one substantial thing at a time** and
compare against that baseline. Read the funnel, not the clicks: more `Demo click`
with no more `Booking complete` means the booking flow needs work, not the page.
To see whether listening goes with booking, filter the dashboard by the `Sample
play` goal and compare `Booking complete`'s conversion rate with and without that
filter (the `heard_sample` property on each completed booking gives the split).

## Publishing

The site's one public address is **https://krate.si**. Cloudflare Pages builds and
serves it: Cloudflare's GitHub app (installed on the Peertopeer-solutions
organisation, for this repository only) sees each push to `main` and builds the site
on Cloudflare's machines. No GitHub Actions job takes part and no token exists. A
commit reaches `main` only through the merge queue, after `checks` passed on it, so
Pages builds only checked code; a failed build leaves the last site up. Slice 5's
publish item later moves the upload into GitHub Actions (ROADMAP.md).

| Pages setting | Value |
| --- | --- |
| Project name | `krate-www` (its own address is `krate-www.pages.dev`) |
| Production branch | `main` |
| Build command | `bun install --frozen-lockfile && bun run --filter www build` |
| Build output directory | `apps/www/dist` |
| Root directory | the repository root (the Bun workspace needs it) |
| Build watch paths (include) | `apps/www/*`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.base.json` |
| Environment variables | `BUN_VERSION` = `1.3.11` (the repository's pinned Bun; Pages' own is older), `SKIP_DEPENDENCY_INSTALL` = `1` (the build command installs, from the lockfile), and the three in **Configuration** |
| Custom domains | `krate.si` and `www.krate.si`; a Cloudflare redirect rule sends `www` to `https://krate.si` with a 301 |

**Search engines.** Each page names its address on krate.si (`<link rel="canonical">`;
the landing page also `og:url`), `public/robots.txt` points at `public/sitemap.xml`,
which lists the three pages, and `public/_headers` sends `X-Robots-Tag: noindex` from
the `pages.dev` addresses, so only krate.si is indexed. `test/build.test.ts` checks all
of these against one address: a new address changes them together.

## Layout

| Path | What it holds |
| --- | --- |
| `privacy.html`, `terms.html` | The privacy policy and the terms of service: plain documents with no script, served at `/privacy` and `/terms` (see **Legal pages**). |
| `index.html` | The Vite entry: a `#root` div + `<script type="module" src="/src/main.tsx">`, plus the head meta (title, description, its krate.si canonical link, Open Graph, `theme-color`, `color-scheme: only light` so forced-dark browsers leave the page alone) and the favicon link. The title and description repeat the hero copy — update them together. |
| `public/` | Static files served as-is — `favicon.svg` (the brand mark), `sample-call.m4a` (the dramatised sample call, voiced with ElevenLabs), `robots.txt` and `sitemap.xml` (for search engines; see **Publishing**), `_headers` (the security headers Cloudflare Pages sends: a content security policy that lets a page use only the site, Cal.com's booking API and Plausible, and no other site frame it; a new outside host, such as a Cal.com embed or a Plausible proxy, goes in this file and in `test/build.test.ts`, or browsers refuse it; and `noindex` from the `pages.dev` addresses). |
| `scripts/make-sample-call.ts` | Rebuilds `public/sample-call.m4a` from its ElevenLabs takes (one line per take; run it with no folder to print the voices, model and exact lines to generate). Needs ffmpeg. Afterwards, set `sampleCall.seconds` in `content/hero.ts` to the new length — the copy-parity suite checks it against the file. |
| `src/main.tsx` | Boot entry — mounts `<App/>` into `#root`, owns the single stylesheet side-effect `import "./styles.css"` (so `App` stays SSR-safe), loads Plausible when configured, calls `armChime()` so the visitor's first tap, click or key press unlocks the message chime (see **Sound**), and calls `armReveal()` before mounting, so scroll-reveal blocks start hidden and only rise in (see **Motion rules**). |
| `src/App.tsx` | Composes the page inside `BookingProvider`: skip link, sticky `header → nav`, `main` → the sections in page order (see **Page order**): hero · How it works (`HowItWorks`: the intro, then the five steps beside the product window) · the engine panel (`StageGrid`, the call and after) · examples · pilot · the pilot report (`Proof`) · FAQ · closing, `footer` → the meta row with its links to the legal pages, and the one `BookingDialog`. Honours cold-load deep links (`/#pilot`; `/#book` opens the booking dialog). Imports no CSS. |
| `src/styles.css` | `@import "tailwindcss"` + the `@theme` tokens (paper / ink / clay palette, illustration plates, the `card` surface, the `lift` shadow, type families, the soft ease), the shared `ro-*` keyframes, one reserved block per visual for its own keyframes and utilities (`survey-*` for the hero's drawing sheet, `intent-*` for the intent study, `brief-*` for the call brief, `how-*` for How it works' steps and window, `legal-prose` for the legal pages' running text), the scroll-reveal, pause, and reduced-motion rules, the decorative `@utility` classes, and **every** `@font-face` block. The **only** place raw colour hex lives. |
| `src/design/` | Reusable, tokens-only elements — `Heading` (display / section / card scale, `balance`), `Text` (lede / body / small sizes; default / muted / inverse tones), `Kicker` (section / hero / inverse / clay eyebrows), `MonoLabel`, `CtaButton` (accent / ghost pills; `busy` for a pending submit), `SectionFrame` (plain paper; wash / ink / clay inset panels; `flush`), `DotList` (a dot-separated run), `Typed` (a line of the agent's voice streaming on word by word with a caret; the plain line when still). `Heading`, `Text`, `Kicker`, `MonoLabel` and `SectionFrame` take `ref`, so `reveal()` spreads onto them. Named exports; no copy, no raw hex. |
| `src/sections/` | One file per section — `Nav`, `Hero` (the plain mono eyebrow, the headline, the lede, the demo button, the listen button, its note and transcript, the pause switch, and the result card on the drawing sheet), `Proof` (the pilot report, after the pilot it reports on: a "Pilot report" kicker, an "Illustrative example" tag, example figures), `HowItWorks` (How it works, told as one enquiry: the kicker with its "Illustrative example" tag, the headline with its accent words in clay, the lede, then `HowSteps`), `StageGrid` (the dark engine panel, "The call and after": it opens on the call at 7:14 PM, then three unnumbered steps, each with a small product example; hosts `FunnelFlow` and `IntentRouting`), `IntentRouting` (the follow-up route for buyers not ready to visit, with the example follow-up plan), `Moats` (the examples: Rohan's call up close — the conversation, the summary, the WhatsApp confirmation), `Pricing` (the pilot, how fees work, and the "Compare plans" disclosure), `Faq`, `FooterCta` (the clay closing invitation). Each composes `design/` elements and imports its copy from `content/`. |
| `src/visuals/` | `BrandMark` (the logo mark), `SampleAudio` (the hero's listen button: plays the sample recording in place, fetched on the first press; then its honesty note and the closed transcript), `FunnelFlow` (enquiries running the three steps, the not-yet-ready ones looping through follow-up), `MoatArt` (the example cards' line illustrations), `CallArt` (the closing panel's poster mark), `BookingDialog` (the booking flow), `Icon` (the 16px line glyphs), `SurveyGround` (the hero's drawing sheet, and `SurveyPlan`: the 2 BHK floor plan under the result card, which draws itself once), `IntentEvidence` (the brief's Intent row opened up: the four signals build his score to 78 and route him to "Call now"; under the line, the follow-up plan), `CallBrief` (the call brief writing itself before the call, with Priya's WhatsApp reply and its chime), `HowSteps` (How it works' five steps as vertical tabs beside a product window that plays `CallBrief` and `IntentEvidence` on one timeline; `visuals/HowSteps.tsx`). SVG + CSS keyframes / SMIL; no animation library. |
| `src/lib/` | `booking.ts` (the Cal.com client + preview adapter + form helpers), `analytics.ts` (`track()`), `bookingContext.tsx` (`BookingProvider`, `useBooking()`, `BookDemoButton`), `reveal.ts` (`reveal(delayMs)` props + `armReveal()`), `motion.ts` (the page-wide pause switch `useStill()` / `setStill()`, and `useLiveSvg()`, which runs an SVG's animations only while it is on screen and not paused), `sequence.ts` (`useSequence()`: steps a looping visual beat by beat while it is on screen; it can loop one range of beats, or stand aside while something else drives the visual), `chime.ts` (the message chime and its remembered sound switch), `cx.ts` (the one-line className joiner). |
| `src/content/` | Every word on the page, as typed modules (`site`, `hero` — including `result`, the hero's card, and `survey`, the drawing sheet's labels — `proof` — the pilot report — `beforeCall` — How it works' intro and its five steps (`howItWorks`, with the headline's accent words and the step list's name, and `howSteps`) and the four intent signals — `intentEvidence`, `callBrief`, `workflow` — the call and after (the engine panel) and the one follow-up plan — `examples`, `pilot`, `faqs`, `closing`, `booking`). Sections and visuals import these and **inline nothing**. Where the design has a slot the copy doesn't fill (a kicker, a plate word, a diagram label), the fill is taken from the copy around it and lives in the same module. |
| `fonts/` | Self-hosted `.woff2` subsets (Lora 400 + italic, IBM Plex Mono 400). Referenced from `src/styles.css` as `../fonts/<file>.woff2`. |
| `test/` | `copy-parity.test.tsx` (the SSR first paint: copy, one "Book a demo" action, the listen button and its disclosure, the hero's plain eyebrow and its result card word for word with no clock time on its face, the old call card gone, the drawing sheet and the plan drawn, the page order heading by heading, How it works' intro (its accent words, its tag) and its five steps as tabs (one selected, one tab stop, each naming the window), the window tagged illustrative with the finished brief showing and the intent study held back until its step, no chapter or step numbers, both studies' final frame, the intent study opening the brief's Intent row, one call-now rule and one follow-up plan, the sound switch, Rohan's one evening told the same everywhere with the call and after opening on the call, a score out of 100 only inside How it works, the pilot report after the pilot and labelled honestly, plans labelled honestly, retired copy stays retired, default UI state and accessibility), `lib.test.ts` (booking client, analytics, `useSequence`'s first paint, a looped range and a driven visual, How it works' accents and the beats each step plays, the chime and its sound switch), `build.test.ts` (`vite build`; the security headers it ships: exactly the policy in `public/_headers`; and each page's krate.si address, `robots.txt`, `sitemap.xml` and the `pages.dev` `noindex`). |
| `e2e/` | Browser checks against a production build (the `www` project in `apps/console/playwright.config.ts`, run by `bun run e2e` and the gate): `how-it-works.e2e.ts` (the steps beside the window: autoplay, keys, Pause, reduced motion, the accent colour, the plate, the phone framing), `sample-call.e2e.ts` (the call plays and pauses at its real length; the transcript opens by mouse and keyboard, every speaker label at 4.5:1), `motion.e2e.ts` (reduced motion stills every screen, the scroll reveal, the Pause switch stopping every animation and finishing the floor plan), `fonts.e2e.ts` (both typefaces load from the site itself, no face failing), `readability.e2e.ts` (small-text colours keep 4.5:1 on their grounds, the focus ring 3:1), `csp.e2e.ts` (a whole visit, and a visit to each legal page, breaks none of the security policy, and no other site can frame the page), `legal.e2e.ts` (each legal page read with JavaScript off, as Meta's crawler reads it: HTTP 200 with no redirect, its title, its whole text and no script; what the privacy policy must say; the landing page's footer opening both). |

## Design language

Editorial and calm, in the spirit of Anthropic's design team: warm paper, ink,
and **one** clay accent; generous whitespace; hairlines and soft paper-2 fills
instead of boxes, gradients, or glows.

- **Palette** — `paper` ground, `paper-2` cards and bands, `line` hairlines,
  `ink` / `ink-2` / `stone` text tiers, `clay` the accent (with `clay-deep` for
  small text on paper), `olive` for follow-up / not yet ready (`olive-deep` for
  small text), plus illustration plates (`oat`, `cactus`, `heather`) and the
  `card` surface. Alpha tiers are Tailwind `/<alpha>` modifiers on these tokens.
- **Type** — Lora 400 for display and card titles (sentence case, tight
  tracking, balanced); the platform's own UI sans for body, buttons and nav (no
  font file, no request); IBM Plex Mono only for machine data — timestamps,
  durations, step numbers, tiny tracked-caps labels.
- **Rhythm** — sections sit in a centred 1200px column; three inset rounded
  panels pace the paper page: the dark ink panel (the call and after, directly
  after How it works), the paper-2 panel (the pilot), and the clay panel (the closing
  invitation).

## Page order

The page follows one enquiry — Rohan Mehta's, one evening — from the headline to
the booking, and tells each step once, in the order it happens. As a visitor
scrolls:

1. **Hero** (`sections/Hero.tsx`) — the promise, "Book a demo", the sample call,
   and one finished result: Rohan called 2 min after his lead landed, a site visit booked.
2. **How it works** (`sections/HowItWorks.tsx`, `#how`, the nav's "How it
   works") — the intro "Follow one lead, from the moment it lands to the site visit.", then
   five unnumbered steps beside a product window (`visuals/HowSteps.tsx`) that
   plays the call brief (`CallBrief`, 7:12–7:14 PM) and the intent study
   (`IntentEvidence`, the brief's Intent row opened up).
3. **The call and after** (`sections/StageGrid.tsx`, `#the-call`) — the dark
   engine panel, "The call, then the next step": it opens on the call at 7:14 PM,
   then the three steps and the follow-up route.
4. **Examples** (`sections/Moats.tsx`, `#examples`) — "What the buyer hears, and
   what your team gets": Rohan's call up close, and the WhatsApp confirmation at
   7:16 PM.
5. **Pilot** (`sections/Pricing.tsx`, `#pilot`), then directly after it the
   **pilot report** (`sections/Proof.tsx`) — the "Pilot report" kicker and an
   "Illustrative example" tag: what the pilot's comparison looks like.
6. **FAQ**, then the **closing** invitation.

Each step's words sit beside the window that shows them, and the window moves
on with the step, so a message never arrives before or after the picture that
proves it. The clock only moves forward as the visitor scrolls: the intent study
zooms into a moment of the brief (7:13:40 PM, the Intent row), and the call and
after starts at the call, never back at the moment the lead landed. There are no chapter numbers
and the steps are unnumbered, so nothing on the page counts: the engine panel's
steps and flow, and the intent study's step strip, carry no numbers either (lists
inside product cards, like the brief's call plan, keep their own). `App.tsx` composes the sections
in this order and the copy-parity suite pins it, heading by heading.

## The hero

The hero follows study A3 ("Surveyor's grid") from the hook-studies board, as it
is. The copy column holds a plain mono eyebrow (no kicker dot, as in the study),
the page's one headline, the lede, "Book a demo",
"Hear a sample call 1:13" with its honesty note (a dramatised call voiced with
ElevenLabs; Rohan is not a real customer), a closed "Read the transcript" list
of every line (the agent says it is an AI in the first), and under that the
page-wide **Pause animations** switch (a real button, 44px touch target; hidden
under reduced motion, where there is nothing to pause).

Beside it, an architect's drawing sheet (`visuals/SurveyGround.tsx`): graph paper
that clears behind the copy, on a slightly darker margin that also runs up behind
the see-through nav, registration marks at the corners, and a title strip in the
bottom margin — north point, "Meridian Greens · Tower B · Typical 2 BHK",
"Illustrative". On it lies the floor plan of that flat (`SurveyPlan`): walls,
windows, the sliding balcony door, three door swings (the only clay), and the
9.75 m width dimensioned above it — no room names. The plan draws itself **once**,
the first time it comes on screen (a slow wipe, then the width and the swings),
and then stays still; pressing Pause mid-drawing finishes it at once, and the
server render and reduced motion show it drawn. The sheet and the plan are
decorative (`aria-hidden`).

On the plan sits the **result card**, tilted, as in the study: "Rohan Mehta" ·
"Called 2 min after it landed" / "Captured" / "₹90 L", "2 BHK · Whitefield",
"Within 12 months" / "Site visit booked · Sat 11:00 AM". Its words live in
`content/hero.ts` as `result`. It is an illustration of one call's outcome, not a
live call: to a screen reader it is one image (`role="img"`) whose label says so
and tells the call in words that read aloud well (only the label says the lead
landed at 7:12 PM; the card's face shows no clock time but the visit's). From 1024px the plan takes a
fixed right-hand column and the copy centres beside it; between 640px and 1023px
the plan and card sit centred under the copy; below 640px the plan is hidden and
the card follows the copy.

The earlier looping call card (two buyers, a live transcript, a readiness gauge,
and room labels on the plan lighting up as the call went) has been removed; the
test suites keep it gone.

## How it works

`sections/HowItWorks.tsx` holds the intro: the "How it works" kicker with an
**"Illustrative example"** tag beside it, the headline "Follow one lead, from the
moment it lands to the site visit." with **lands** and **site visit** set in clay (the same
serif, colour only, never italic; punctuation stays ink), then the lede. The
accent colour is `clay-type`, clay mixed 85% with clay-deep: plain clay is under
3:1 on paper, so accents are for large type only. Intent scoring and questions to
the sales team are planned, not built, so the tag sits in the kicker row and again
on the window.

`visuals/HowSteps.tsx` follows: five unnumbered steps as **vertical tabs** on the
left, a **product window** on the right (stacked below lg: the steps, then the
window). Each tab is a Lora title over a thin rule; the selected title turns ink,
its description opens under it, and its rule fills with clay beat by beat as the
step plays. The window is quiet chrome in our tokens (three grey dots, a tab with
the pulsing mark and "Krate", the tag), with a lift below it, over a clay
**brand plate** with the grain and the mark's voice arcs drawn large. The plate
keeps at least 48px clear of the headline and lede: from 1280 it rises high but is
narrower (55% of the column), below that it barely rises.

What each step plays, from the studies' own beats (`RUNS`), with the window
scrolling itself to each beat's element like a camera (`data-beat`; a beat marked
on several elements frames them together, as step 4's last frames the score with
"Call now"), under the study's pinned bar (`data-pin`). Each study's caption, the
agent's voice, **streams on** like a live log (`design/Typed.tsx`): its timestamp
swaps in at once, the words arrive one by one in stone with a thin clay caret on the
newest, then the line settles to ink; reduced motion and Pause show the whole line
with no caret. In a phone-width window the intent study's strip shows only its own
step, so its pinned header stays short:

1. **It starts the moment a lead lands.** The brief opens on his enquiry, in his
   own words. The story (hero, How it works and its window, The call and after)
   says "lands", never "import": leads will come by more than one channel (CSV
   today; CRM connectors and inbound calls are planned). A copy test enforces it;
   the Pilot and FAQ may still say how leads arrive today.
2. **A brief before every call.** The project match, his history, his language.
3. **Your team answers once. Every call knows.** The open question goes to
   Priya on WhatsApp; her reply pops up (with the chime), then is saved.
4. **Every score shows its working.** The window cross-fades to the intent
   study: four signals land with their weights, the home loan as context, then
   78 / 100 and "Call now", the follow-up plan dim.
5. **A call plan in his language.** Back to the brief: the plan, then "Ready ·
   calling 7:14 PM".

Each step's last beat stays up 4 s longer so it can be read. With nothing chosen
the story advances by itself and wraps. A mouse over the step list, or keyboard
focus in the list or the window, **holds** the current step: it replays instead of
moving on (hovering the window does not hold). Clicking a step, or choosing one
with the arrow keys, Home or End, **chooses** it for the rest of the visit: the
story jumps there and loops it, and the rule stays solid clay. It is the W3C tabs
pattern: the list is one tab stop, the window is the tab panel (named by the
selected step), and the hidden study is out of the accessibility tree.

**First paint** (the server render, reduced motion, or Pause before it ever
played) is the finished story: the last step selected, its rule solid, the brief
at "Ready". With motion it opens on step 1 and plays once the window is a third on
screen. The window always shows the studies' phone layouts (their breakpoints are
container queries, so they follow the window's width), which means the brief's
two-column desktop layout, with its "What the agent looked at" rail, no longer
shows on the page.

**One call-now rule, one follow-up plan.** At or over 50 is a call tonight, under
50 is the follow-up plan — the brief, step 4's description and the router all say
it that way, never "over 50". The follow-up plan is the engine panel's "Example
follow-up plan" (today: floor plans on WhatsApp; day 7: a WhatsApp check-in; day
30: a re-call); the intent study's "Follow-up plan" card tells the same steps in
one line, and the intent study's screen-reader summary must too. The copy-parity
suite pins all of it.

The intro and the steps' words live in `content/beforeCall.ts` (`howItWorks`,
`howSteps`), as do the four signals and their weights (`intentSignals`, with
`intentScore` summing them); both studies and their copy modules read them from
there and restate no number (copy-parity checks the totals add up). Neither
study runs a clock of its own on the page: `HowSteps` drives both through one
`useSequence()` (see **Motion rules**) and hands each its beat (`at`); rendered
alone, each still runs itself. Screen readers get each study once: the intent
study is one labelled image, the brief has a visually hidden summary that includes
Priya's reply. The call and after's words live in `content/workflow.ts`.

## Sound (the message chime)

When Priya's reply pops up (step 3 of How it works), the brief plays a soft
two-note chime, synthesised with Web Audio in `lib/chime.ts` (no audio file). Browsers only allow a page to
play sound after the visitor has interacted with it, so `armChime()` (called once
in `main.tsx`) creates the audio on the first tap, click or key press; until then
`chime()` is silent. The brief carries its own **Sound** switch, top right of its
pinned caption bar inside How it works' window (hidden, and out of the tab order,
while the window shows the intent study) — a real button
with `aria-pressed`, a 44px touch target — which reads "off" until audio can
actually play (pressing it is itself the gesture that unlocks sound). The choice is
remembered in this browser (`localStorage`, key `ro-sound`; a blocked store just
forgets it). The chime only sounds while the brief is actually playing: never
when it is off screen, paused, or under reduced motion (where the switch is
hidden and the brief stands still).

## Motion rules

Motion explains the product — the plan drawing itself, the lead flow, the two
studies in How it works — and never decorates for its own sake.

- **CSS first.** Keyframes (`ro-rise`, `ro-fade`, `ro-ring`, `ro-wave`,
  `ro-blink`, `ro-draw`, `ro-float` …) live in `src/styles.css`; components apply
  them with Tailwind arbitrary animations. SVG loops may use SMIL. A visual's own
  keyframes take its prefix (`survey-`, `intent-`, `brief-`, `how-`) and sit in its
  reserved block.
- **Step-by-step loops use `useSequence()`** (`lib/sequence.ts`): give it when
  each beat starts and how long to hold the end, and it steps the visual only
  while at least a third of it is on screen in a visible tab and the page isn't
  paused (`playing` says so — the chime keys off it). The server render, reduced
  motion and a browser without `IntersectionObserver` get the final beat, so
  nothing on the page depends on it running. `loop: [first, end]` replays one
  range of beats (How it works' held or chosen step); `on: false` makes it stand
  aside when something else drives the visual (the studies inside How it works'
  window, which `HowSteps` hands their beat).
- **Scroll reveal** — spread `{...reveal(delayMs)}` on a block for a one-shot
  fade-and-rise. Content is only hidden once `armReveal()` (in `main.tsx`, before
  the page mounts) has opted the document in (`html[data-motion]`), so a failed
  script never hides anything, and a block is hidden from its first frame, so it
  only ever rises in.
- **Everything can be paused.** The "Pause animations" switch in the hero's copy
  column sets `html[data-still]` (WCAG 2.2.2): CSS keyframes freeze, SVGs pause
  through `useLiveSvg()`, `useSequence()` loops hold their beat, and the hero's
  plan finishes its drawing. Off-screen SVGs pause too.
- **Reduced motion is the floor.** Under `prefers-reduced-motion: reduce` every
  keyframe and transition ends immediately with no delay (the floor is
  `!important`, so a transition a component writes inline obeys it too), SMIL
  groups marked `data-motion-only` are removed, and JS-driven visuals (the hero's
  floor plan, the two studies in How it works) render their final static state. A
  visual the Pause switch settled (`data-settled`) gets the same timings, so a
  finished frame appears at once. A study eases only the properties it names,
  never `visibility`, so a pane turning visible shows everything in it at once.
- **SSR-safe and accessible.** No `window` / `document` / `Audio` at render or
  module scope; timers and observers are cleaned up and pause off-screen.
  Decorative visuals are `aria-hidden`; the hero's result card and the intent
  study are each a single `role="img"` with a text alternative — never a stream
  of live updates.

## Editing rules

- **Honesty.** Krate has no live customers yet: never present names, logos,
  results or quotes as real. Examples are labelled ("Illustrative example",
  "Example", "Sample call", and the dramatised-call note under the listen button).
  Claims match what exists today: English + Hindi/Hinglish; leads arrive by CSV
  import today, so speed reads "called 2 min after it landed" (the buyer story never
  names a channel or says "import"; the Pilot and FAQ say how leads arrive today) — never a seconds-to-call
  claim or a lead portal as a live source; CRM connectors and intent scoring are
  planned; no published rates. An intent score out of 100 ("78 / 100") appears
  **only** in How it works (`#how`: step 4 and the window), which carries
  "Illustrative example" in its kicker row and on the window (intent scoring and
  questions to the sales team are planned, and the routing note says the weights
  and the line are examples); the copy-parity suite fails if a score out of 100
  shows anywhere else — the hero, the intro's own words, the engine panel, the examples, the pilot or the pilot report. In
  the plans a check marks only what is built; roadmap items sit under "Planned".
  Replace the illustrative pilot report with a real project, period, comparison
  and attributed quote once a pilot has run.
- **Colours and fonts change in `src/styles.css` `@theme` and nowhere else.** It
  owns the only raw hex; components reference tokens through generated
  utilities (`bg-paper`, `text-ink`, `border-line`, `text-clay-deep`, `bg-ink/5`
  …), never a raw hex. Small text keeps ≥ 4.5:1 contrast on its background
  (`e2e/readability.e2e.ts` checks the palette) — use the `-deep` variants or
  `stone`, never `clay` / `olive` / `mute` as small text on paper.
- **Copy lives in `src/content/`.** A section or visual imports its strings, never
  inlines them. The legal pages are the one exception: their words live in their own
  HTML (see **Legal pages**). "Book a demo" is defined
  once (`content/site.ts`); every primary button is a `BookDemoButton` with its
  analytics `source` (nav, hero, pilot, closing). Copy edits keep the
  copy-parity anchors green in the same change.
- **Reusable look lives in `src/design/`.** A section composes these elements; it
  does not re-declare typography or button skins. `cx()` does not dedupe Tailwind
  utilities, so never pass a class that fights a primitive's own — use the
  primitive's props (`size`, `tone`, `balance`, `flush`) instead.
- **Responsive** is mobile-first (`md:` 768, `lg:` 1024) and must hold from 360px
  up with no horizontal scroll. Keyboard focus draws a clay-deep `:focus-visible`
  ring (ink on the clay panel); `scroll-padding-top` keeps anchors, focus and the
  skip link clear of the sticky nav.
- **Interactivity** (FAQ accordion, "Compare plans", the phone menu, the booking
  dialog) is React `useState`; its default is what SSR emits and the copy-parity
  suite pins (FAQ item 0 open, plans and menu closed, dialog closed), exposed via
  `aria-expanded` and the `data-faq` / `data-open` hooks.
- **The sample call** is a file (`public/sample-call.m4a`), its length
  (`sampleCall.seconds`) and its transcript (`sampleCall.transcript`), kept
  together in `content/hero.ts` beside the hero's result card (`result`), which
  tells the same call's outcome; replace all of them together when a real
  recording exists. **Rohan's evening** is one timeline
  everywhere — the lead lands 7:12 PM, Priya's answer 7:13 PM, called 7:14 PM
  ("2 min after it landed"), WhatsApp confirmation Thu 7:16 PM, visit Sat 11:00 AM — and the
  copy-parity suite checks every section against it.

## Legal pages

`privacy.html` (the privacy policy) and `terms.html` (the terms of service) are
plain HTML documents beside `index.html`, with **no script**. Meta takes a privacy
policy's address for a WhatsApp app only if its crawler, which runs no JavaScript,
gets the page itself: HTTP 200, no redirect, no sign-in, clearly titled. So their
words live in the HTML, not in `src/content/`, and nothing renders them. Each links
the shared stylesheet (`src/styles.css`, whose `legal-prose` utility sets the running
text) and copies the nav's brand link and the landing page's footer row: change
those together.

- **Where they are served.** `vite.config.ts` builds the three pages, so
  `dist/privacy.html` and `dist/terms.html` sit at the build's root. Cloudflare Pages
  serves `privacy.html` at `/privacy` with HTTP 200 (its "Serving Pages" docs, route
  matching), and `vite preview` does the same. Keep them there, not in a folder
  (`privacy/index.html`, which Pages serves at `/privacy/`, so `/privacy` may answer
  with a redirect that Meta's check refuses). The footers link the clean addresses,
  `/privacy` and `/terms`, since Pages redirects `/privacy.html` to `/privacy`.
- **Who runs it.** Until a company is registered, both pages say Krate is run from
  India, with no street address (never invent one: these pages are a legal
  statement), and give `support@krate.si`, which Cloudflare Email Routing forwards
  to Devesh. When the company exists, its legal name and registered address go in
  "Who we are" / "Who these terms are between" and "Contact" on both pages. No
  `[bracketed]` placeholder may remain (`e2e/legal.e2e.ts` checks it), and the
  "Last updated" date changes whenever the words change.
- **What the privacy policy must keep saying** (`e2e/legal.e2e.ts` checks it): no
  WhatsApp data trains or improves an AI model (Meta's terms for the WhatsApp
  Business Platform); a lead replies STOP to stop messages; the developer is the
  Data Fiduciary and we are its Data Processor under India's Digital Personal Data
  Protection Act, 2023; the Data Protection Board of India; and the service
  providers that receive personal data (Meta, Supabase, the AI model provider, the
  voice provider). These pages are a plain-English starting point, not legal advice:
  have a lawyer review them before the first customer signs.

## Adding a page (future contact-us)

The next surface (e.g. a `/contact-us`) is a new entry, not a rewrite:

1. Add its copy as a typed module under `src/content/`.
2. Build its sections under `src/sections/`, composing `src/design/` elements — no
   new colours outside `@theme`, no inlined copy.
3. Give it an entry `contact.html` + `src/contact.tsx` (mirroring `index.html` /
   `main.tsx`) and add its name to the pages `vite.config.ts` builds
   (`build.rolldownOptions.input`). Keep it static; no secrets.
4. Give it its canonical link (`https://krate.si/contact`), and add that address to
   `public/sitemap.xml` and its file to `PAGES` in `test/build.test.ts`.

## Self-hosted fonts (rationale)

Fonts are shipped as local `.woff2` subsets under `fonts/` and declared as
`@font-face` in `src/styles.css` — **never** fetched from a CDN. This keeps the
surface self-contained (no third-party font host, no external request on load, no
privacy leak). The browser checks prove it: every font the page loads comes from
the site itself, with no face failing (`e2e/fonts.e2e.ts`), and a whole visit
under the site's security policy, which allows only Cal.com's booking API and
Plausible beyond the site (`public/_headers`), breaks none of it
(`e2e/csp.e2e.ts`). The UI
sans is the platform's own system font, so it needs no file at all.

## Visual source of truth

Machine tests pin copy, token values, default state, and the motion floor — not
pixels. The editorial redesign (2026-09-23, Anthropic-inspired: paper / ink /
clay) is the reference. A later demo-first redesign was reverted in its favour,
keeping that redesign's copy, booking flow and analytics. It also **supersedes**
the dark-green-and-gold export from the "Revenue OS Design System" project on
claude.ai (Marketing group); until that project is updated to match, this app and
the rules above are the reference.
