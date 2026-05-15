import type { AgentAdapter, AdapterConfig } from "../types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { GeminiAdapter } from "./gemini.js";
import { GrokAdapter } from "./grok.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { MockAdapter } from "./mock.js";

export {
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  GrokAdapter,
  OpenAICompatAdapter,
  MockAdapter,
};

export type AdapterId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "grok"
  | "openai-compat"
  | "mock";

// Registry-style factory. Pass `id` plus optional model/baseUrl/extras.
export function makeAdapter(config: AdapterConfig): AgentAdapter {
  switch (config.id) {
    case "anthropic":
      return new AnthropicAdapter(config);
    case "openai":
      return new OpenAIAdapter(config);
    case "gemini":
      return new GeminiAdapter(config);
    case "grok":
      return new GrokAdapter(config);
    case "openai-compat":
      return new OpenAICompatAdapter(config);
    case "mock":
      return new MockAdapter((config.extra?.script as string[]) ?? []);
    default:
      throw new Error(
        `Unknown adapter id "${config.id}". Available: anthropic | openai | gemini | grok | openai-compat | mock`,
      );
  }
}

// Inventory of built-in adapters with their config status. Used by `openwar adapters`.
export function listAdapters(): Array<{ id: AdapterId; name: string; configured: boolean }> {
  const ids: AdapterId[] = ["anthropic", "openai", "gemini", "grok", "openai-compat", "mock"];
  return ids.map((id) => {
    const a = makeAdapter({ id });
    return { id, name: a.name, configured: a.isConfigured() };
  });
}
