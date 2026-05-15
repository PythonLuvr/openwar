import type { AgentAdapter, SendMessageOptions, StreamEvent, ToolCall } from "../types.js";

// One step in the mock script. Either a text response (string) or a
// tool-using response (object with optional text + tool_calls).
export type MockStep =
  | string
  | {
      text?: string;
      tool_calls?: ToolCall[];
    };

// Deterministic adapter for tests and offline development. Yields a scripted
// sequence of responses. If the script is exhausted, returns an empty done
// event.
export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly name = "Mock (deterministic)";
  readonly model = "mock";
  private cursor = 0;
  private readonly script: MockStep[];
  // Records every sendMessage call. Useful for assertions in tests.
  public readonly calls: SendMessageOptions[] = [];

  constructor(script: MockStep[] = []) {
    this.script = script;
  }

  isConfigured(): boolean {
    return true;
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const step = this.script[this.cursor++] ?? "";
    const text = typeof step === "string" ? step : step.text ?? "";
    const toolCalls = typeof step === "string" ? [] : step.tool_calls ?? [];

    const chunks = text.match(/\S+\s*|\s+/g) ?? (text ? [text] : []);
    for (const chunk of chunks) {
      yield { type: "text_delta", delta: chunk };
    }
    for (const call of toolCalls) {
      yield { type: "tool_call_complete", call };
    }
    yield { type: "done", message: text, tool_calls: toolCalls };
  }
}
