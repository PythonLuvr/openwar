import type { AdapterConfig } from "../types.js";
import { OpenAIAdapter } from "./openai.js";

// Catch-all for OpenAI-compatible APIs (OpenRouter, Groq, Together, Ollama,
// llama.cpp server, vLLM, etc). The caller supplies baseUrl and an env key.
// Env key name is configurable via `extra.envKey` or defaults to
// OPENAI_COMPAT_API_KEY.
export class OpenAICompatAdapter extends OpenAIAdapter {
  constructor(config: AdapterConfig = { id: "openai-compat" }) {
    const envKey =
      (config.extra?.envKey as string | undefined) ?? "OPENAI_COMPAT_API_KEY";
    const name = (config.extra?.name as string | undefined) ?? "OpenAI-compatible";
    super(config, {
      id: config.id,
      name,
      defaultModel: config.model ?? "gpt-4o",
      defaultBaseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
      envKey,
    });
  }
}
