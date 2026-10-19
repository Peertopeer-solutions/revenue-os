// T3 — raw-`fetch` Anthropic (Claude) Messages adapter behind LlmProvider.
// docs/tech-stack.md T19: "raw fetch, no SDK" — no @anthropic-ai dependency (BOM/T19).
// One POST to /v1/messages per turn; response content blocks → LlmTurn.
// G1: runtime-agnostic — no bun:* imports, no Bun.* globals (fetch is a standard global).
import type { LlmProvider, Msg } from "../types";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

// Anthropic Messages roles are only "user" | "assistant": our AI agent is the assistant;
// every other speaker (contact, human_agent, system, tool) sits on the user side.
function toAnthropicRole(role: Msg["role"]): "user" | "assistant" {
  return role === "agent" ? "assistant" : "user";
}

type AnthropicBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
};

type AnthropicResponse = {
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

/** task-57 — a non-2xx /v1/messages response. LlmProvider.complete has no error channel, so a
 *  throw is the only honest failure signal: parsing an error envelope yields a contentless turn
 *  the loop would record as a completed (silent) turn, and the job would never be retried.
 *  `status` is what a retry policy keys on (429/529 retryable, 401 not). */
class AnthropicHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`anthropic /v1/messages failed: HTTP ${status} ${detail}`.trim());
    this.name = "AnthropicHttpError";
    this.status = status;
  }
}

export function createAnthropicProvider(config: {
  apiKey: string;
  model: string;
}): LlmProvider {
  return {
    async complete(req) {
      const body = {
        model: config.model,
        system: req.system,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: req.messages.map((m) => ({
          role: toAnthropicRole(m.role),
          content: m.content,
        })),
        // input_schema is the Anthropic field name; our ToolSpec carries inputSchema.
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              })),
            }
          : {}),
      };

      const res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) {
        // Body read is best-effort: an unreadable/non-JSON body must never turn the failure
        // back into a return. Truncated — provider bodies can be long, and logs carry them.
        const detail = await res.text().catch(() => "");
        throw new AnthropicHttpError(res.status, detail.slice(0, 500));
      }
      const json = (await res.json()) as AnthropicResponse;

      let text = "";
      const toolCalls: { name: string; args: unknown }[] = [];
      for (const block of json.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({ name: block.name ?? "", args: block.input });
        }
      }

      return {
        text,
        toolCalls,
        usage: {
          in: json.usage?.input_tokens ?? 0,
          out: json.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
