import type { AgentAdapter, AdapterConfig } from "../types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { GeminiAdapter } from "./gemini.js";
import { GrokAdapter } from "./grok.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { MockAdapter } from "./mock.js";
import { CliBridgeAdapter } from "./cli-bridge.js";

export {
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  GrokAdapter,
  OpenAICompatAdapter,
  MockAdapter,
  CliBridgeAdapter,
};
export type { AdapterTier, CliBridgeOptions } from "./cli-bridge.js";

export type AdapterId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "grok"
  | "openai-compat"
  | "mock"
  | "cli-bridge";

// Cost tier of each built-in adapter. Used for the Phase 0 cost-tier
// preview banner. "free" means a local-CLI / local-subscription call;
// "paid" means an API call that bills per token. Operators override per
// adapter via extra.tier in the brief or programmatically.
export const DEFAULT_TIERS: Record<AdapterId, "free" | "paid"> = {
  anthropic: "paid",
  openai: "paid",
  gemini: "paid",
  grok: "paid",
  "openai-compat": "paid", // depends on backend; opt-in override to "free" for local Ollama
  mock: "free",
  "cli-bridge": "free", // default; CLI typically uses a local subscription
};

// Resolve an adapter's effective tier. The brief/config `extra.tier`
// overrides; falls back to DEFAULT_TIERS; unknown ids default to "paid".
export function resolveTier(config: AdapterConfig): "free" | "paid" {
  const fromExtra = (config.extra?.tier as unknown) ?? undefined;
  if (fromExtra === "free" || fromExtra === "paid") return fromExtra;
  const fallback = DEFAULT_TIERS[config.id as AdapterId];
  return fallback ?? "paid";
}

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
    case "cli-bridge":
      return new CliBridgeAdapter(config);
    default:
      throw new Error(
        `Unknown adapter id "${config.id}". Available: anthropic | openai | gemini | grok | openai-compat | cli-bridge | mock`,
      );
  }
}

// Inventory of built-in adapters with their config status. Used by `openwar adapters`.
export function listAdapters(): Array<{ id: AdapterId; name: string; configured: boolean; tier: "free" | "paid" }> {
  const ids: AdapterId[] = ["anthropic", "openai", "gemini", "grok", "openai-compat", "cli-bridge", "mock"];
  return ids.map((id) => {
    // cli-bridge requires a binary to instantiate; surface as not-configured
    // when listing without one. The default-tier comes from DEFAULT_TIERS.
    if (id === "cli-bridge") {
      return { id, name: "CLI bridge", configured: false, tier: DEFAULT_TIERS[id] };
    }
    const a = makeAdapter({ id });
    return { id, name: a.name, configured: a.isConfigured(), tier: DEFAULT_TIERS[id] };
  });
}
