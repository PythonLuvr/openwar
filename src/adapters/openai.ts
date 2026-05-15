import type { AgentAdapter, SendMessageOptions, StreamEvent, AdapterConfig } from "../types.js";
import { parseSseStream } from "./sse.js";

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  protected readonly apiKey: string | undefined;
  protected readonly baseUrl: string;
  protected readonly extraHeaders: Record<string, string>;

  constructor(
    config: AdapterConfig = { id: "openai" },
    overrides: {
      id?: string;
      name?: string;
      defaultModel?: string;
      defaultBaseUrl?: string;
      envKey?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    this.id = overrides.id ?? "openai";
    this.name = overrides.name ?? "OpenAI";
    this.model = config.model ?? overrides.defaultModel ?? DEFAULT_MODEL;
    const envKey = overrides.envKey ?? "OPENAI_API_KEY";
    this.apiKey = config.apiKey ?? process.env[envKey];
    this.baseUrl = (config.baseUrl ?? overrides.defaultBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.extraHeaders = overrides.headers ?? {};
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    if (!this.apiKey) {
      yield { type: "error", error: new Error(`API key not set for adapter "${this.id}"`) };
      return;
    }
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: opts.system },
    ];
    for (const m of opts.messages) {
      if (m.role === "system") continue;
      messages.push({ role: m.role, content: m.content });
    }
    const body = {
      model: this.model,
      stream: true,
      messages,
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      yield {
        type: "error",
        error: new Error(`${this.name} ${res.status}: ${txt.slice(0, 500)}`),
      };
      return;
    }

    let assembled = "";
    try {
      for await (const ev of parseSseStream(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          assembled += delta;
          yield { type: "text_delta", delta };
        }
        if (choice?.finish_reason) {
          yield { type: "done", message: assembled };
          return;
        }
      }
      yield { type: "done", message: assembled };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
