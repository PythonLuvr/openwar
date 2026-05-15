import type { AgentAdapter, SendMessageOptions, StreamEvent, AdapterConfig } from "../types.js";
import { parseSseStream } from "./sse.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicAdapter implements AgentAdapter {
  readonly id = "anthropic";
  readonly name = "Anthropic (Claude)";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(config: AdapterConfig = { id: "anthropic" }) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    if (!this.apiKey) {
      yield { type: "error", error: new Error("ANTHROPIC_API_KEY not set") };
      return;
    }
    const body = {
      model: this.model,
      max_tokens: 4096,
      system: opts.system,
      stream: true,
      messages: opts.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": this.apiKey,
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
        error: new Error(`Anthropic ${res.status}: ${txt.slice(0, 500)}`),
      };
      return;
    }

    let assembled = "";
    try {
      for await (const ev of parseSseStream(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let parsed: { type?: string; delta?: { type?: string; text?: string } };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          const delta = parsed.delta.text ?? "";
          if (delta) {
            assembled += delta;
            yield { type: "text_delta", delta };
          }
        }
        if (parsed.type === "message_stop") {
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
