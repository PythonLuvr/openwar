import type { AgentAdapter, SendMessageOptions, StreamEvent, AdapterConfig } from "../types.js";

const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export class GeminiAdapter implements AgentAdapter {
  readonly id = "gemini";
  readonly name = "Google Gemini";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(config: AdapterConfig = { id: "gemini" }) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    if (!this.apiKey) {
      yield { type: "error", error: new Error("GEMINI_API_KEY not set") };
      return;
    }
    // Gemini's streaming format is a JSON array delivered chunk-by-chunk via
    // `?alt=sse`. Use the SSE endpoint for a stable line-delimited stream.
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}` +
      `:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const contents = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body = {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      yield { type: "error", error: new Error(`Gemini ${res.status}: ${txt.slice(0, 500)}`) };
      return;
    }

    const { parseSseStream } = await import("./sse.js");
    let assembled = "";
    try {
      for await (const ev of parseSseStream(res.body)) {
        if (!ev.data) continue;
        let parsed: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const parts = parsed.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) {
            assembled += part.text;
            yield { type: "text_delta", delta: part.text };
          }
        }
      }
      yield { type: "done", message: assembled };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
