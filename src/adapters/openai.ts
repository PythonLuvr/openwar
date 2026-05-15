import type {
  AgentAdapter,
  SendMessageOptions,
  StreamEvent,
  AdapterConfig,
  ToolDefinition,
  ToolCall,
  ToolResultForRound,
} from "../types.js";
import { parseSseStream } from "./sse.js";

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// Translate OpenWar ToolDefinition[] into OpenAI tools array.
// https://platform.openai.com/docs/guides/function-calling
export function formatToolsForOpenAI(tools: ToolDefinition[]): unknown[] {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Build the messages array including prior tool_calls + tool responses.
export function formatMessagesForOpenAI(opts: SendMessageOptions, systemPrompt: string): unknown[] {
  const out: unknown[] = [{ role: "system", content: systemPrompt }];
  for (const m of opts.messages) {
    if (m.role === "system") continue;
    out.push({ role: m.role, content: m.content });
  }
  if (opts.prior_tool_calls && opts.prior_tool_calls.length > 0) {
    out.push({
      role: "assistant",
      content: null,
      tool_calls: opts.prior_tool_calls.map(c => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      })),
    });
  }
  if (opts.prior_tool_results && opts.prior_tool_results.length > 0) {
    for (const r of opts.prior_tool_results) {
      out.push({
        role: "tool",
        tool_call_id: r.call_id,
        content: r.content,
      });
    }
  }
  return out;
}

export function formatToolResultForOpenAIMessage(r: ToolResultForRound): unknown {
  return { role: "tool", tool_call_id: r.call_id, content: r.content };
}

interface OpenAIStreamingToolCall {
  index: number;
  id: string;
  name: string;
  argsJson: string;
}

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
    const messages = formatMessagesForOpenAI(opts, opts.system);
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      messages,
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = formatToolsForOpenAI(opts.tools);
    }
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
    const toolCallsByIndex = new Map<number, OpenAIStreamingToolCall>();

    try {
      for await (const ev of parseSseStream(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
        };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta?.content;
        if (delta) {
          assembled += delta;
          yield { type: "text_delta", delta };
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index;
            let slot = toolCallsByIndex.get(idx);
            if (!slot) {
              slot = { index: idx, id: tc.id ?? `call_${idx}`, name: "", argsJson: "" };
              toolCallsByIndex.set(idx, slot);
            }
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) {
              slot.argsJson += tc.function.arguments;
              yield {
                type: "tool_call_arg_delta",
                tool_call_id: slot.id,
                name: slot.name,
                arg_delta: tc.function.arguments,
              };
            }
          }
        }
        if (choice.finish_reason) {
          const completed: ToolCall[] = [];
          for (const slot of toolCallsByIndex.values()) {
            let args: unknown = {};
            try {
              args = slot.argsJson.length > 0 ? JSON.parse(slot.argsJson) : {};
            } catch {
              args = { __parse_error: slot.argsJson };
            }
            const call: ToolCall = { id: slot.id, name: slot.name, arguments: args };
            completed.push(call);
            yield { type: "tool_call_complete", call };
          }
          yield { type: "done", message: assembled, tool_calls: completed };
          return;
        }
      }
      yield { type: "done", message: assembled };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
