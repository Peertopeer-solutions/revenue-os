# Pattern: one Zod schema = runtime validation + TS type + tool seatbelt
A shape that crosses a boundary (an HTTP request, a webhook) is one schema in packages/shared, parsed on both
sides. Each example below is an excerpt of the real file named on its first line (`bun run guards` fails when it no
longer matches).

```ts
// packages/shared/src/schemas.ts
export const GuardrailPolicyInputSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("quiet_hours"),
      config: z.strictObject({
        start: z.string().regex(GUARDRAIL_HHMM),
        end: z.string().regex(GUARDRAIL_HHMM),
        tz: z.string().min(1),
      }),
      active: z.boolean().default(true),
    })
    .strict(),
  …
]);
export type GuardrailPolicyInput = z.infer<typeof GuardrailPolicyInputSchema>;
```
The console parses a save's body with it before sending (`docs/patterns/tanstack-query.md`), and the PUT route in
`services/worker/src/routes/guardrail-policies.ts` parses it again before it writes anything.

A schema used inside one module stays next to it: each AI tool declares its arguments' schema in its own file under
`packages/harness/src/tools/`, and the agent loop parses the model's arguments before the tool runs:
```ts
// packages/harness/src/tool-call.ts
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success)
    // the seatbelt against made-up arguments: invalid args never reach execute()
    return { name: call.name, result: { ok: false, error: "invalid_args" } };
…
  const verdict = await guard(ctx, action, deps.pipeline);
…
  if (verdict.ok) {
…
    result = await tool.execute(
      { ...ctx, conversationId },
      parsed.data as never,
    );
```
**Do not copy a tool's argument schema yet:** today's tools take the lead's id (`contactId`) from the model's
arguments, so a lead's message can steer a write onto another lead of the same company. Slice 3 · "Tools have one
registry and one contract" removes it (no tool takes a lead's id) and gives this file its agent-tool example.

Rules: request and webhook shapes live in packages/shared (`packages/shared/src/schemas.ts`), never re-declared
where they are used; a schema used inside one module lives next to it · `.strict()` when the shape is closed · the
same schema is parsed on both sides of a boundary, before any logic · a tool's arguments are parsed before it runs,
and invalid arguments go back to the model, never to `execute()` · a webhook parses its body with its schema only
after its secret or signature has checked out (today's Vapi receiver reads the whole body first: don't copy it,
`.claude/skills/worker-webhook/SKILL.md` says why).
