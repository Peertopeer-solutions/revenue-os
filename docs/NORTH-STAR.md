# North star

What we are building and why. One page. When anything else disagrees with this page about
*what the product is*, this page wins; for *what exists today*, the code and `STATE.md` win.

## The product, in one paragraph

An AI sales team for high-ticket businesses, starting with Indian real-estate developers. For
every lead, it decides the next best step toward a booked site visit — a WhatsApp message, a
phone call, a wait, a hand-off to a person — does it, remembers what happened, and adapts. It
speaks Hinglish, follows the law and the customer's own rules without exception, and hands a
buyer to a human closer only when a human would change the outcome. The phone and WhatsApp are
the front door; the product is the funnel behind them.

## Who it is for

- **The buyer of the product:** the sales head of a mid-market developer who has more leads
  than their telecalling team can work well.
- **The daily user:** the operator (telecalling manager) who sets the goal and the rules,
  watches what the agent plans, overrides it, and works the hand-off queue.
- **The person on the other end:** a home buyer who should feel helped, never spammed.

## How it works — the target system

1. **The database** holds every company (tenant) and its contacts, conversations and
   results, walled off from every other company. It is the memory of the whole system.
2. **The harness** is the engine that runs every AI agent. It keeps nothing in its own memory:
   each turn it loads a prompt, context and memory from the database, lets the model use tools,
   checks the guardrails before every action, and writes every step back to the database.
3. **The sales agent** owns each lead's journey. Whenever something happens — a reply
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
| The sales agent, at run time | The next step for each lead, its timing, channel and wording — inside those limits |

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

- Pricing hypothesis: a platform fee plus a fee per qualified, attributed outcome (a site
  visit), which is why every outcome must trace back to the conversation that produced it.
- Every contract carries the derived-data clause (aggregated, anonymised use for model
  improvement) from customer one.
- Languages: English and Hindi/Hinglish first, done excellently; more languages are
  configuration, not new code.

## Not now

Autonomous lead discovery and list building, an A/B testing engine, an analytics warehouse,
knowledge-base search (needs an AI text-search service we have not chosen yet), a lead-scoring
model, CRM sync, SSO, billing automation. Each can come back only as a roadmap slice with a proof.

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

## Where we are (25 September 2026)

The foundation is real: tenant isolation, a crash-safe job scheduler, guardrail checks, a
stateless agent loop, a webhook receiver, a console that reads live data. The product is not:
no lead has ever been contacted. The phone dialer, the WhatsApp sender and the call-result
step are placeholders that throw errors in production, nothing enrols a lead, and "the agent"
today only reports one word into a fixed, hand-written sequence. `ROADMAP.md` is the plan to
close that gap one visible slice at a time.
