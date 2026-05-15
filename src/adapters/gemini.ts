import type {
  AgentAdapter,
  SendMessageOptions,
  StreamEvent,
  AdapterConfig,
  ToolDefinition,
  ToolCall,
  ToolResultForRound,
} from "../types.js";

const DEFAULT_MODEL = "gemini-2.0-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

// Translate ToolDefinition[] into Gemini's tools.function_declarations.
// https://ai.google.dev/gemini-api/docs/function-calling
export function formatToolsForGemini(tools: ToolDefinition[]): unknown {
  return [
    {
      function_declarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      })),
    },
  ];
}

export function formatMessagesForGemini(opts: SendMessageOptions): unknown[] {
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  for (const m of opts.messages) {
    if (m.role === "system") continue;
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  if (opts.prior_tool_calls && opts.prior_tool_calls.length > 0) {
    contents.push({
      role: "model",
      parts: opts.prior_tool_calls.map(c => ({
        function_call: { name: c.name, args: c.arguments ?? {} },
      })),
    });
  }
  if (opts.prior_tool_results && opts.prior_tool_results.length > 0) {
    contents.push({
      role: "user",
      parts: opts.prior_tool_results.map(r => ({
        function_response: {
          name: r.call_id, // Gemini ties responses to call by name + ordering
          response: { content: r.content, is_error: !!r.is_error },
        },
      })),
    });
  }
  return contents;
}

export function formatToolResultForGeminiMessage(r: ToolResultForRound): unknown {
  return {
    function_response: {
      name: r.call_id,
      response: { content: r.content, is_error: !!r.is_error },
    },
  };
}

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
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}` +
      `:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: formatMessagesForGemini(opts),
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = formatToolsForGemini(opts.tools);
    }

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
    const completedCalls: ToolCall[] = [];
    let callCounter = 0;
    try {
      for await (const ev of parseSseStream(res.body)) {
        if (!ev.data) continue;
        let parsed: {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string; function_call?: { name: string; args: unknown } }>;
            };
          }>;
        };
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
          if (part.function_call) {
            const id = `gemini_call_${callCounter++}`;
            const call: ToolCall = {
              id,
              name: part.function_call.name,
              arguments: part.function_call.args,
            };
            completedCalls.push(call);
            yield { type: "tool_call_complete", call };
          }
        }
      }
      yield { type: "done", message: assembled, tool_calls: completedCalls };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
