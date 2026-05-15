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

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Translate OpenWar ToolDefinition[] into Anthropic's "tools" request shape.
// https://docs.anthropic.com/claude/docs/tool-use
export function formatToolsForAnthropic(tools: ToolDefinition[]): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// Build the messages array including prior tool_use / tool_result blocks.
export function formatMessagesForAnthropic(opts: SendMessageOptions): unknown[] {
  const out: unknown[] = [];
  for (const m of opts.messages) {
    if (m.role === "system") continue;
    out.push({ role: m.role, content: m.content });
  }
  if (opts.prior_tool_calls && opts.prior_tool_calls.length > 0) {
    const blocks = opts.prior_tool_calls.map(c => ({
      type: "tool_use",
      id: c.id,
      name: c.name,
      input: c.arguments ?? {},
    }));
    out.push({ role: "assistant", content: blocks });
  }
  if (opts.prior_tool_results && opts.prior_tool_results.length > 0) {
    const blocks = opts.prior_tool_results.map(r => ({
      type: "tool_result",
      tool_use_id: r.call_id,
      content: r.content,
      ...(r.is_error && { is_error: true }),
    }));
    out.push({ role: "user", content: blocks });
  }
  return out;
}

export function formatToolResultForAnthropicMessage(r: ToolResultForRound): unknown {
  return {
    type: "tool_result",
    tool_use_id: r.call_id,
    content: r.content,
    ...(r.is_error && { is_error: true }),
  };
}

interface AnthropicStreamingToolCall {
  index: number;
  id: string;
  name: string;
  argsJson: string; // accumulating
}

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
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      system: opts.system,
      stream: true,
      messages: formatMessagesForAnthropic(opts),
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = formatToolsForAnthropic(opts.tools);
    }
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
    const toolCallsByIndex = new Map<number, AnthropicStreamingToolCall>();
    const completedCalls: ToolCall[] = [];

    try {
      for await (const ev of parseSseStream(res.body)) {
        if (!ev.data || ev.data === "[DONE]") continue;
        let parsed: {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string };
        };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }

        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          const idx = parsed.index ?? 0;
          toolCallsByIndex.set(idx, {
            index: idx,
            id: parsed.content_block.id ?? `call_${idx}`,
            name: parsed.content_block.name ?? "",
            argsJson: "",
          });
        } else if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "input_json_delta"
        ) {
          const idx = parsed.index ?? 0;
          const slot = toolCallsByIndex.get(idx);
          if (slot) {
            const fragment = parsed.delta.partial_json ?? "";
            slot.argsJson += fragment;
            yield {
              type: "tool_call_arg_delta",
              tool_call_id: slot.id,
              name: slot.name,
              arg_delta: fragment,
            };
          }
        } else if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta"
        ) {
          const delta = parsed.delta.text ?? "";
          if (delta) {
            assembled += delta;
            yield { type: "text_delta", delta };
          }
        } else if (parsed.type === "content_block_stop") {
          const idx = parsed.index ?? 0;
          const slot = toolCallsByIndex.get(idx);
          if (slot) {
            let args: unknown = {};
            try {
              args = slot.argsJson.length > 0 ? JSON.parse(slot.argsJson) : {};
            } catch {
              args = { __parse_error: slot.argsJson };
            }
            const call: ToolCall = { id: slot.id, name: slot.name, arguments: args };
            completedCalls.push(call);
            yield { type: "tool_call_complete", call };
            toolCallsByIndex.delete(idx);
          }
        } else if (parsed.type === "message_stop") {
          yield { type: "done", message: assembled, tool_calls: completedCalls };
          return;
        }
      }
      yield { type: "done", message: assembled, tool_calls: completedCalls };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
