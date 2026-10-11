# Pi sales harness (prototype)

A sketch of how a multi-company sales agent built on the Pi coding-agent SDK (`@earendil-works/pi-coding-agent`,
pinned at 1.0.4) would work one lead: read that lead's context from one company's rows, work out intent and where
the lead is in the sales cycle, propose the next step (and the stage it moves them to), and remember things at the
right scope. It is for understanding the shape, not for running:

- Nothing in `apps/`, `services/` or `packages/` imports it, and it is not on the roadmap.
- It has no tool that sends a message or places a call, and nothing in it prompts a model or needs a credential.
- The intent tool is a **placeholder**: four keyword rules (and do-not-call) whose result says `isPrediction: false`.
- The companies, members and leads in `src/fixtures.ts` are made up.

## See it

Open `walkthrough.html` in a browser (it is one self-contained file), or review it with annotations through
`lavish-axi experiments/pi-sales-harness/walkthrough.html`. It shows the flow of one run, the three memory scopes,
which state is authoritative, the sales cycle, the guardrail layers, the needs-more-details path to a phone call,
isolation, the context budget and compaction, and a source map from each figure to the code below.

Without a model or credentials:

```
bun install
bun experiments/pi-sales-harness/src/inspect.ts   # Pi options, context by scope, each scenario's decision
bun test experiments/pi-sales-harness              # 26 offline tests (the repo's test setup checks the local stack first)
bun run typecheck                                   # checked against Pi's real declarations
```

## Files

| File | What it holds |
|---|---|
| `src/tenancy.ts` | `TrustedScope` (set by the host, never the model) and `openScope`, the only reader: one company, one member, one lead |
| `src/intent.ts` | the intent tool's input and output contract and `placeholderIntent` |
| `src/policy.ts` | `SALES_CYCLE` (which stage may follow which) and `checkProposal`: legal floor and cycle (code), company policy (a playbook per stage and intent, stage approvals), member preference → permit, needs approval, or refuse |
| `src/context.ts` | `assembleLeadContext` (a budget per scope, fenced as data) and `MEMORY_WRITES` (who may change each scope) |
| `src/session.ts` | the three Pi tools, the resource loader, `leadSessionOptions`, and `openLeadSession`, which never prompts |
| `src/fixtures.ts`, `src/inspect.ts` | made-up rows and scenarios, and the offline printout |

A permitted proposal is only a saved next step: carrying it out would go through the existing `packages/channels`
doorways, which run `guard()` (`packages/harness/src/policies.ts`) before anything reaches a lead. Whether Pi's loop
replaces today's `runTurn` is left to Slice 3.
