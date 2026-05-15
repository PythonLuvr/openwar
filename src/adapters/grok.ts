import type { AdapterConfig } from "../types.js";
import { OpenAIAdapter } from "./openai.js";

// xAI Grok speaks OpenAI's chat-completions protocol. Subclass for naming
// and a separate env var.
export class GrokAdapter extends OpenAIAdapter {
  constructor(config: AdapterConfig = { id: "grok" }) {
    super(config, {
      id: "grok",
      name: "xAI Grok",
      defaultModel: "grok-2-latest",
      defaultBaseUrl: "https://api.x.ai/v1",
      envKey: "XAI_API_KEY",
    });
  }
}
