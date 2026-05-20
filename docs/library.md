# Use OpenWar as a library

The npm package exports the runtime primitives so you can drive OpenWar from your own TypeScript or JavaScript code. War Room and other integrators consume OpenWar this way.

## Installation

```bash
npm install @pythonluvr/openwar
```

## Minimum example

```ts
import { run, AnthropicAdapter } from "@pythonluvr/openwar";

const adapter = new AnthropicAdapter({
  id: "anthropic",
  model: "claude-sonnet-4-6",
});

const result = await run({
  briefPath: "./brief.md",
  adapter,
});

if (!result.completed) {
  console.error(`Halted at ${result.final_phase}: ${result.halt_reason}`);
} else {
  console.log(`Session ${result.session_id} complete.`);
}
```

`run()` is async and returns a `RunResult` with the final phase, completion status, halt reason (if any), and the full message history.

## Available exports

From the package root:

| Export | Notes |
|---|---|
| `run(opts)` | The single-agent entry point. |
| `runCoordinator(opts)` | Multi-agent coordinator entry point. |
| `parseBrief(input)` / `validateBrief(brief)` | Brief parsing and validation. |
| `AnthropicAdapter`, `OpenAIAdapter`, `GeminiAdapter`, `GrokAdapter`, `OpenAICompatAdapter` | API adapters. |
| `CliBridgeAdapter` | The cli-bridge adapter (v0.5+). |
| `MockAdapter` | Deterministic test adapter. |
| `makeAdapter(config)` | Factory: id + config -> adapter instance. |
| `DEFAULT_TIERS`, `resolveTier(config)` | Cost-tier preview utilities. |
| `registerRole(definition)` | Add a custom role for the multi-agent coordinator. |

From `@pythonluvr/openwar/detectors`:

| Export | Notes |
|---|---|
| `detectConfirmation`, `detectBlocker`, `detectDestructive`, `detectBannedPhrases`, `detectPhaseMarker`, `detectCompletion` | The deterministic detectors that run on every assistant turn. |

## Custom adapters

Implement the `AgentAdapter` interface to plug in a custom backend:

```ts
import type {
  AgentAdapter,
  SendMessageOptions,
  StreamEvent,
} from "@pythonluvr/openwar";

class MyAdapter implements AgentAdapter {
  readonly id = "my-adapter";
  readonly name = "My custom adapter";
  readonly model = "my-model-v1";

  isConfigured(): boolean {
    return Boolean(process.env.MY_API_KEY);
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    // Translate opts.messages to your provider's chat format.
    // Yield text_delta events as content streams in.
    // Yield a done event with the assembled message + any tool_calls.

    yield { type: "text_delta", delta: "Hello, world." };
    yield { type: "done", message: "Hello, world." };
  }
}
```

The full `StreamEvent` union also includes `tool_call_arg_delta` / `tool_call_complete` (for adapters that surface streaming tool-call arguments) and `error` (for terminal errors). As of v0.12.1, the cli-bridge adapter additionally yields four `bridged_*` variants (`bridged_tool_call`, `bridged_tool_result`, `bridged_thinking_delta`, `bridged_usage`) that capture structured events from inside a bridged CLI's own run via Squire's vendor-aware adapters; see [`docs/adapters.md`](./adapters.md) for the full surface. Custom adapters do not normally need to emit `bridged_*` events; they are specific to the cli-bridge integration.

Then use it the same way as the built-ins:

```ts
const result = await run({ briefPath: "./brief.md", adapter: new MyAdapter() });
```

## Custom roles

Register a role before calling `runCoordinator()`:

```ts
import { registerRole, runCoordinator } from "@pythonluvr/openwar";

registerRole({
  id: "domain-checker",
  description: "Verifies the executor's output against domain-specific rules.",
  prompt_overlay: "You are a domain expert. Check that the executor's work...",
  tool_categories: [],
  allow_read_file: true,
});

// Then reference "domain-checker" in the brief's roles list.
```

## Headless / programmatic runs

For embedding in a server, CI, or another tool, use `--ephemeral` semantics (skip the JSON+JSONL persistence) and provide a custom `RunnerIO` to capture output:

```ts
import { run } from "@pythonluvr/openwar";

const captured: string[] = [];

const result = await run({
  briefPath: "./brief.md",
  adapter,
  ephemeral: true,
  io: {
    write: (s) => captured.push(s),
    banner: (s) => captured.push(`[banner] ${s}`),
    warn: (s) => captured.push(`[warn] ${s}`),
    prompt: async (q) => "go",      // headless: auto-confirm
    confirm: async (q) => true,
  },
});
```

For real headless use cases (CI, automation), be careful with Phase 3: a `confirm: () => true` impl auto-approves every destructive prompt, which defeats the framework's whole point. Better headless pattern: pre-approve all expected destructive categories in `authorized_costs` and reject any unexpected Phase 3 prompt.

## Versioning the API

The library surface is stable within a minor version. Breaking changes happen at major boundaries with migration notes in the CHANGELOG. `MessageRole` (formerly `Role`) is the only deprecation in flight; `Role` remains as an alias for one minor cycle.

See [cli.md](./cli.md) for the equivalent flags exposed via the `openwar` command and [adapters.md](./adapters.md) for adapter-specific config.
