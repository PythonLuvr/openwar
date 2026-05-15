import type { AgentAdapter, SendMessageOptions, StreamEvent } from "../types.js";

// Deterministic adapter for tests and offline development. Yields a scripted
// sequence of responses. If the script is exhausted, returns an empty done
// event.
export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly name = "Mock (deterministic)";
  readonly model = "mock";
  private cursor = 0;
  private readonly script: string[];
  // Records every sendMessage call. Useful for assertions in tests.
  public readonly calls: SendMessageOptions[] = [];

  constructor(script: string[] = []) {
    this.script = script;
  }

  isConfigured(): boolean {
    return true;
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    const message = this.script[this.cursor++] ?? "";
    // Mimic streaming by chunking on whitespace.
    const chunks = message.match(/\S+\s*|\s+/g) ?? [message];
    for (const chunk of chunks) {
      yield { type: "text_delta", delta: chunk };
    }
    yield { type: "done", message };
  }
}
