# North star

What we are building and why. One page. When anything else disagrees with this page about
*what the product is*, this page wins; for *what exists today*, the code and `STATE.md` win.

## The vision

Revenue OS becomes an AI colleague that a company shapes into any role: a sales agent, a support agent, an
assistant for its operations team. The company equips it the way it equips a new hire, with tools, knowledge,
rules and a goal, and like a good new hire it knows the company before it speaks to anyone. It connects to the
company's data sources, does the busywork (following up every lead on time, keeping the CRM up to date) and leaves
people the work that closes deals. It is an operating system for a team's work, not a workflow builder like n8n or
Zapier: nobody draws the flow; the agent decides each next step inside the company's rules.

## The brain

The brain is the one agent engine every role runs on. A role is the engine plus rows: its model, its prompt, its
goal and rules, the tools it may use and the company's knowledge. The engine has these parts, each with one
implementation:

1. **The loop:** Pi's agent core (pi-agent-core, decided 2026-10-12) runs inside one turn; our code runs before
   and after it, loads the role and the context, caps the rounds and the time, and writes every step as rows.
2. **Context engineering:** each turn's prompt is assembled from the role, the company's knowledge, the contact's
   memories and conversation, and why the agent is acting now, each part within its budget; anything retrieved
   enters fenced and labelled as data, never as instructions.
3. **Tools:** every action is a tool with a checked schema, listed on the role's version, run by the worker behind
   guard() and the pause switch.
4. **Knowledge:** what the company has told it (see Knowledge below).
5. **Memory:** what it has learned about each contact, kept as rows that name their source.
6. **Events:** a reply, a timer, a call result or a CRM change wakes the contact's agent through one door.
7. **Sandboxes:** untrusted work runs in a short-lived sandbox, one per task (see Sandboxes below).
8. **Rules:** the legal floor in code, the company's own stricter rules, approvals and the pause switch.
9. **Test conversations:** each role passes its own before a version goes live.
10. **Metering:** every token, sandbox second and message is recorded against its company and contact.

We build it to enterprise standard: no patch work, one implementation per job, every replacement running beside the
old part until it passes, and every part proven by Slice 3's proof, through a test chat in the console, before
WhatsApp or a phone line carries it. How each part is built, and which code it keeps or replaces, is in
`docs/brain.md` (agreed by Devesh on 2026-10-21).

## The beachhead: where we start

An AI sales agent for Indian real-estate developers. For every lead, it decides the next best step toward a
booked site visit — a WhatsApp message, a phone call, a wait, a hand-off to a person — does it, remembers what
happened, and adapts. It speaks Hinglish, follows the law and the customer's own rules without exception, and
hands a buyer to a human closer only when a human would change the outcome. WhatsApp and the phone are the
front door; the product is the funnel behind them.

We start in one industry for footing and positioning: one buyer, one sales motion, one pair of channels. The
technology stays general. The first customers buy a sales agent; we do not pitch the operating system yet.

## What stays general, and what belongs to the beachhead

| General: core code (packages/harness, packages/channels, packages/db, services/worker) | The beachhead: config rows, seed packs and company settings |
|---|---|
| The agent loop, guard() and the legal floor (do-not-call, consent, calling hours, caps) | The real-estate agent's prompt, its test conversations and its WhatsApp templates |
| Events: a reply, a call result, a timer, a CRM change, an instruction from the team | Which events the real-estate agent acts on |
| Tools: send a message, place a call, book an appointment, hand over to a person, save a memory, run a sandboxed task | The appointment kind "site visit" and the outcome names |
| Connectors: an integrations row, the tools that use it, the events it sends | Which lead sources and CRMs Indian developers use |
| Memory, knowledge (versioned, every turn recording the version it used), outcomes, usage and cost | The knowledge template's real-estate sections (project, location, unit types, prices, possession, RERA number, visiting hours) and each company's facts |

The test that the core stays general: a second role ships with no change to `packages/harness`, only new rows, a
seed pack and, where needed, one new tool or connector. Slice 3's proof runs that test.

## Shape rules: how we build so the product grows without a rewrite

1. **No industry words in core code.** `bun run guards` fails a word such as "site visit", "BHK" or "RERA" in the
   core folders (the engine, the senders, the database package and the worker). Industry words live in seed packs and company settings. "property" and
   "flat" are not checked, because they are ordinary programming words (JSON Schema's `properties`, JavaScript's
   `flat()`) that every core file would trip.
2. **Every input is an event; every action is a tool.** A reply, a call result, a timer, a CRM change or an
   instruction from the team is an event about a contact, and it wakes that contact's agent through one door.
   Every action the agent takes is a tool, and every tool passes guard() and the pause switch before it acts.
3. **A new part runs beside the old one.** It is switched on per company or per role, and the old part is deleted
   only after the new one passed its proof. Example: the planner runs beside the fixed step map until it passes the
   test conversations.
4. **The database only grows.** Each change adds; a removal comes in a later release, once no running copy uses
   the old shape (expand, then contract: `AGENTS.md` hard rail 4).
5. **A release never takes the product down.** The new copy starts, answers ready, and only then does the old copy
   stop. Two copies can run at once safely, because every job and every due run is claimed with a database lock.

## Connectors

A connector to an outside system (WhatsApp, a CRM, a lead source, a calendar) is three things and nothing more:

1. **One `integrations` row per company:** its settings in `config`, its credentials only in Supabase Vault, named by
   `credentials_ref`. The worker reads the credentials when it calls out; the AI model never sees them.
2. **The tools that use it:** listed on the role's version (`tools_allowed`), validated, run by the worker, behind
   guard() and the pause switch.
3. **Its events:** they arrive at one webhook door, are authenticated, are de-duplicated by the database and are
   stored in `webhook_events` before anything acts on them; then they wake the contact's agent (shape rule 2).

## Knowledge

An agent that does not know the company cannot do the job, so knowledge is core from the first release, not a
later feature. A buyer's first message is often "What does a 2BHK cost, and when is possession?"; an agent that
can't answer it is useless, and one that guesses is worse. The agent works from five kinds of knowledge:

1. **The company's facts:** its projects or products, prices, locations, dates, approvals and hours, written by
   the company. Every save is a new version, every turn records the version it used, and the agent sees the date
   of the facts it quotes.
2. **How the company sells:** its goal, its rules and its prompt.
3. **The contact:** the conversation and the contact's memories.
4. **Live facts**, such as which units are still unsold: only through a connector to the company's own system
   (road step 3), never from text someone pasted.
5. **What worked:** learned from outcomes (road step 6).

The agent states a fact only when its knowledge holds it. Otherwise it says it will confirm, and it hands the
question to a person. While a company's facts fit in one prompt, every turn gets them whole, because that never
misses the paragraph that holds the answer; search (road step 5) is added beside that, under shape rule 3, once
they no longer fit.

## Sandboxes

The agent loop runs only our own code, so it needs no virtual machine of its own. Untrusted work runs in a
short-lived sandbox, one per task: code the AI writes over a company's file, a file from outside, a web page a
browser drives. The sandbox starts with its inputs, returns its outputs as data and is destroyed. Nothing lives in
a sandbox between tasks: what must last is written back as rows ("rows or it didn't happen").

A sandbox is one more tool behind guard() and the pause switch, reached through a port (an interface, like the
WhatsApp sender's) so its provider can change. It gets no database access and no secrets; its network is off, or
limited to a list of allowed addresses; its outputs enter prompts fenced and labelled as data; every second of it is
recorded in `usage_events`; and each company has a daily limit. We buy sandboxes from a provider rather than build
them; Devesh picks the provider when Slice 3's sandboxed-tasks item is next (decided 2026-10-21).

## The road from here to the vision

1. **The brain** (Slice 3): one engine, two roles built from rows, proven through a test chat in the console.
2. **The beachhead goes live:** WhatsApp (Slice 2), then calls once the phone line is approved (Slice 4), then a
   console a pilot can run on and the pilot itself (Slices 5 and 6).
3. **The company's data comes in by itself:** lead ads and property portals become event sources; the agent reads
   the company's CRM and its inventory, so it can say which units are still unsold.
4. **CRM write-back:** after every touch, the summary, the stage and the next follow-up land in the company's CRM.
5. **Company knowledge, searched:** when a company's documents (brochures, floor plans, price lists) outgrow one
   prompt, they are searched with pgvector behind the company's wall, beside the whole facts.
6. **Lead ranking learned from outcomes** (`contact_scores`).
7. **A colleague, not a script:** it takes plain-language instructions from the team and reports at the end of
   each day.
8. **A second role in a customer's hands:** for example support for booked buyers (payment reminders, document
   checklists, visit logistics), on the same engine.

## Who it is for

- **The buyer of the product:** the sales head of a mid-market developer who has more leads
  than their telecalling team can work well.
- **The daily user:** the operator (telecalling manager) who sets the goal and the rules,
  watches what the agent plans, overrides it, and works the hand-off queue.
- **The person on the other end:** a home buyer who should feel helped, never spammed.

## How it works — the target system

1. **The database** holds every company (tenant) and its contacts, conversations and
   results, walled off from every other company. It is the memory of the whole system.
2. **The harness (the brain above)** is the engine that runs every AI agent. It keeps nothing in its own memory:
   each turn it loads a prompt, context and memory from the database, lets the model use tools,
   checks the guardrails before every action, and writes every step back to the database.
3. **The role's agent (the sales agent first)** owns each lead's journey. Whenever something happens — a reply
   arrives, a call ends, a timer fires — it reads the lead's history and decides the next step:
   what to do, when, on which channel, what to say, and why. The operator's goal and rules fence
   it in; it chooses inside the fence.
4. **The voice agent** handles live calls: low latency, Hinglish, the lead's context loaded
   before dialling, and tools it can use mid-call (book a visit, record a fact).
5. **Channels** — WhatsApp and phone — are doors, and every send passes the guardrails first.
6. **The console** is where people steer: set goals, rules and prompts; enrol leads; see
   every plan and why; override it; work the human task queue.
7. **The data loop** records every conversation and outcome together with the decision that
   caused it, so the agent can be measured and improved. That labelled data is the moat.

### Who decides what

| Who | Decides |
|---|---|
| Us, in code | The legal floor (do-not-call, calling hours, consent), the tools, the agent loop |
| The customer, in the console | The goal, stricter rules, the agent's prompt, which actions need approval |
| The role's agent, at run time | The next step for each lead, its timing, channel and wording — inside those limits |

## Principles

1. **Done means seen working.** A thing is done when it runs from a real entry point on real
   inputs and it has been seen happening: by a script that checks the real product (a slice's proof
   run) or by a person. Passing tests are necessary, never sufficient.
2. **Vertical slices, not layers.** Build one thin path end to end — lead in, decision,
   message out, result recorded — before widening anything.
3. **No hidden stubs.** Any part that is faked or not wired is listed as such in `STATE.md`.
4. **The legal floor is code, not config.** Do-not-call, calling hours and consent cannot be
   switched off by a missing settings row.
5. **Stateless processes, durable rows.** If it isn't in the database, it didn't happen.
6. **One tenant can never touch another's data**, including by linking to it.
7. **Boring beats clever; reversible beats optimal.** Name the escape hatch for every choice.
8. **One source of truth per question** (see below).

## Commercial rules

- The beachhead's pricing hypothesis: a platform fee plus a fee per qualified, attributed outcome (a site
  visit), which is why every outcome must trace back to the conversation that produced it.
- Every contract carries the derived-data clause (aggregated, anonymised use for model
  improvement) from customer one.
- Languages: English and Hindi/Hinglish first, done excellently; more languages are
  configuration, not new code.

## Not now

Autonomous lead discovery and list building, an A/B testing engine, an analytics warehouse, SSO, billing
automation, a virtual machine per user or per agent. Each can come back only as a roadmap slice with a proof.
(CRM sync, knowledge search and lead ranking are steps of the road above.)

## Later

Engineering ideas worth doing once the product ships, kept here so they are not lost in a chat. Each line says
what it would fix. None is planned: each comes back only as a roadmap item with a proof, and an agent adds a line
here, rather than leaving it in a chat, when Devesh and an agent agree an idea can wait.

- **Each test run gets its own database, or its own local stack.** Today every run shares one database and a
  test that touches another run's data is only caught afterwards, by the four-runs-at-once test; with its own
  database a run cannot touch another's at all, and that test could shrink or go. Sign-in and the data interface
  serve only the stack's one database, so the tests that use them need their own stack, on its own ports.
- **The worker's last error before it exits reaches its log.** When the job runner fails to start, the worker logs
  why and exits at once, and the log line is lost (pino writes it after the process has gone): on 2026-10-13 CI
  showed only "exit code 1" until a test printed "password authentication failed".
- **The four-runs-at-once test's inner runs leave out the gate's, the proof's and the cycle's own tests**, which
  touch no company data and are most of each run (about 7.5 of CI's minutes), while Slice 0's proof keeps the full
  version; only if it still catches every collision it catches today.
- **One shared-database lock for every copy of the repo on the Mac.** A second copy (~/firstmate/projects/revenue-os)
  uses the same local database without the gate's lock; one fixed lock path deadlocks the gate's own tests, which
  take locks on scratch repos, so it needs a design first.
- **The limit of three open task PRs, looked at again** now that the merge queue lands PRs with no agent work:
  Devesh's call.

## Where things live

| Question | File |
|---|---|
| What are we building and why? | `docs/NORTH-STAR.md` (this page) |
| What are we building next, and what counts as done? | `ROADMAP.md` |
| What actually works today, what is waiting on Devesh, what have we decided? | `STATE.md` (each decision a file in `docs/decisions-in-force/`) |
| How do agents and people work in this repo? | `AGENTS.md` |
| How was X designed, and why? | `docs/` reference files — useful, never rules |
| What did we think in July–September 2026? | `docs/archive/` — history only |

## Where we are (18 October 2026)

The foundation is real: tenant isolation, a crash-safe job scheduler, guardrail checks, a
stateless agent loop, a webhook receiver, a console that reads live data, and a checking system
that refuses unproven work. The product is not: no lead has ever been contacted. The phone
dialer, the WhatsApp sender and the call-result step are placeholders that throw errors in
production, nothing enrols a lead, and "the agent" today only reports one word into a fixed,
hand-written sequence. Next, Slice 1 finishes the floor the agent stands on; then Slice 3 builds
the brain, ahead of WhatsApp (Slice 2) and calls (Slice 4). `ROADMAP.md` is the plan to close
the gap one visible slice at a time.
