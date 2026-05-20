// v0.13.0: OpenAI-compatible HTTP router. Handles the four endpoints
// the brief covers (POST /v1/chat/completions, GET /v1/models, GET
// /healthz, default 404) plus auth + concurrency gating. Per-request
// flow: auth → concurrency acquire → parse → synthesize brief → run
// the adapter → translate output → write response (streaming or
// non-streaming) → emit proxy_request/proxy_response trace events.
//
// The handler is decoupled from the server bootstrap so tests can drive
// it without binding a real socket (see tests/serve/openai-router.test.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { AgentAdapter, StreamEvent } from "../types.js";
import { Tracer } from "../state/trace.js";
import { authorizeRequest, unauthorizedResponse } from "./auth.js";
import { ConcurrencyGate, rateLimitedResponse } from "./concurrency.js";
import { parseChatRequest } from "./openai-parse.js";
import { synthesizeBrief } from "./synthesize-brief.js";
import {
  buildNonStreamingResponse,
  traceIdHeader,
} from "./openai-translate.js";
import {
  encodeRoleChunk,
  encodeContentChunk,
  encodeFinishChunk,
  encodeErrorChunk,
  newChunkContext,
  STREAMING_RESPONSE_HEADERS,
  SSE_DONE_SENTINEL,
} from "./openai-streaming.js";
import type { ServeOptions } from "./types.js";

export interface RouterDeps {
  options: ServeOptions;
  gate: ConcurrencyGate;
  // Upstream adapter the proxy dispatches every request to. Built by the
  // serve subcommand at startup; passed in here so tests can substitute
  // a MockAdapter.
  upstream: AgentAdapter;
  // Tracer factory: per-request a fresh Tracer is constructed scoped to
  // the synthesized brief_id. Tests pass a no-op factory.
  tracerFor: (briefId: string) => Tracer;
  // Optional logger hook for --log-requests; called once per response.
  logRequest?: (line: string) => void;
}

// Public entrypoint the HTTP server hands every incoming request to.
export async function handleRequest(
  deps: RouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const startMs = Date.now();
  const clientAddr = req.socket.remoteAddress ?? "unknown";

  // /healthz: no auth, no concurrency gate (probes should always work).
  if (method === "GET" && url === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Auth gate (every other endpoint).
  if (!deps.options.noAuth) {
    const expected = deps.options.authToken;
    if (!expected) {
      sendJson(res, 500, {
        error: {
          message: "OpenWar serve started without --auth-token AND without --no-auth. Refusing to handle requests.",
          type: "server_error",
          code: "openwar_misconfigured",
        },
      });
      return;
    }
    const decision = authorizeRequest(req.headers["authorization"], expected);
    if (!decision.ok) {
      const { status, body } = unauthorizedResponse(decision.reason);
      sendJson(res, status, body);
      return;
    }
  }

  // Routing dispatch.
  if (method === "GET" && url === "/v1/models") {
    sendJson(res, 200, modelsResponse(deps));
    return;
  }
  if (method === "POST" && url === "/v1/chat/completions") {
    await handleChatCompletions(deps, req, res, startMs, clientAddr);
    return;
  }

  // Unknown route -> OpenAI-shaped 404.
  sendJson(res, 404, {
    error: { message: "not found", type: "invalid_request_error" },
  });
}

// /v1/models stub: declares one model entry representing the configured
// upstream so OpenAI clients that probe this endpoint at startup get a
// valid response. Many clients reject if /v1/models fails.
function modelsResponse(deps: RouterDeps): unknown {
  const id = deps.options.upstreamModel ?? deps.upstream.model;
  return {
    object: "list",
    data: [
      {
        id,
        object: "model",
        created: 0,
        owned_by: "openwar",
      },
    ],
  };
}

async function handleChatCompletions(
  deps: RouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
  startMs: number,
  clientAddr: string,
): Promise<void> {
  // Concurrency acquire BEFORE body read so we never buffer a body we
  // are about to reject. Return 429 in OpenAI rate_limit_error shape.
  const release = deps.gate.tryAcquire();
  if (!release) {
    const { status, body } = rateLimitedResponse();
    sendJson(res, status, body);
    return;
  }

  // Allocate the request id eagerly so the X-OpenWar-Trace-Id header can
  // ship on every response (success, 4xx, or 5xx).
  const earlyRequestId = `proxy-${randomUUID()}`;
  let bytesWritten = 0;
  let cancelled = false;
  let statusCode = 200;

  try {
    const bodyText = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch (err) {
      statusCode = 400;
      sendJsonWithTraceHeader(res, 400, {
        error: {
          message: `invalid JSON in request body: ${(err as Error).message}`,
          type: "invalid_request_error",
          code: "openwar_bad_json",
        },
      }, earlyRequestId);
      return;
    }
    const parseResult = parseChatRequest(parsedBody);
    if (!parseResult.ok) {
      statusCode = parseResult.status;
      sendJsonWithTraceHeader(res, parseResult.status, parseResult.body, earlyRequestId);
      return;
    }
    const { request } = parseResult;

    const synth = synthesizeBrief({
      request,
      authorizedCosts: deps.options.authorizedCosts,
      upstreamModel: deps.options.upstreamModel,
    });
    // Use the synth request id (overwrites the earlyRequestId so the
    // trace, proxy_request event, and X-OpenWar-Trace-Id header all
    // agree). The earlyRequestId is only used for 4xx errors that
    // never reach the synthesize stage.
    const requestId = synth.requestId;
    const tracer = deps.tracerFor(requestId);
    const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
    const isStream = request.stream === true;

    tracer.emit({
      type: "proxy_request",
      request_id: requestId,
      client_addr: clientAddr,
      model: request.model,
      stream: isStream,
      tool_count: toolCount,
      ...(synth.modelSubstitutedFrom ? { model_substituted_from: synth.modelSubstitutedFrom } : {}),
      at: new Date().toISOString(),
    });

    // Build the upstream prompt context. v0.13.0 ships text-only: we
    // do not pass tool definitions or prior tool_calls history to the
    // upstream adapter, so the upstream produces a plain text response.
    // The synthesized brief's body already carries the conversation as
    // markdown; the upstream sees it as a single user-turn payload.
    const system = ""; // no system prompt from synthesize-brief in v0.13.0
    const messages = [
      {
        role: "user" as const,
        content: synth.brief.raw,
        at: new Date().toISOString(),
      },
    ];

    if (isStream) {
      bytesWritten = await streamCompletion(res, deps.upstream, system, messages, requestId, synth.brief.frontmatter.brief_id ?? requestId);
    } else {
      const text = await collectCompletion(deps.upstream, system, messages);
      const payload = buildNonStreamingResponse({
        requestId,
        model: deps.options.upstreamModel ?? deps.upstream.model,
        text,
        finishReason: "stop",
      });
      const buf = Buffer.from(JSON.stringify(payload), "utf8");
      bytesWritten = buf.byteLength;
      const headers = traceIdHeader(requestId);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(bytesWritten),
        [headers.name]: headers.value,
      });
      res.end(buf);
    }

    tracer.emit({
      type: "proxy_response",
      request_id: requestId,
      status_code: statusCode,
      duration_ms: Date.now() - startMs,
      bytes_written: bytesWritten,
      cancelled,
      at: new Date().toISOString(),
    });
  } catch (err) {
    statusCode = 500;
    if (!res.headersSent) {
      sendJsonWithTraceHeader(res, 500, {
        error: {
          message: `OpenWar proxy: upstream error: ${(err as Error).message}`,
          type: "server_error",
          code: "openwar_upstream_error",
        },
      }, earlyRequestId);
    } else {
      // Headers were already sent (streaming path): emit an error chunk
      // before closing so the client sees something rather than a hang.
      try {
        const chunk = encodeErrorChunk((err as Error).message, "server_error", "openwar_upstream_error");
        res.write(chunk);
        res.write(SSE_DONE_SENTINEL);
        res.end();
      } catch {
        try { res.end(); } catch { /* swallow */ }
      }
    }
  } finally {
    release();
    if (deps.logRequest) {
      deps.logRequest(
        `${new Date().toISOString()} ${clientAddr} POST /v1/chat/completions ${statusCode} ${Date.now() - startMs}ms`,
      );
    }
  }
}

// Collect the upstream adapter's text deltas into a single string.
// Used by the non-streaming response path.
async function collectCompletion(
  adapter: AgentAdapter,
  system: string,
  messages: { role: "user"; content: string; at: string }[],
): Promise<string> {
  let assembled = "";
  for await (const ev of adapter.sendMessage({ system, messages }) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text_delta") assembled += ev.delta;
    else if (ev.type === "done") {
      if (ev.message && ev.message.length >= assembled.length) assembled = ev.message;
      return assembled;
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }
  return assembled;
}

// Stream the upstream adapter's text deltas as SSE chunks. Returns the
// total bytes written so the proxy_response event reports honestly.
async function streamCompletion(
  res: ServerResponse,
  adapter: AgentAdapter,
  system: string,
  messages: { role: "user"; content: string; at: string }[],
  requestId: string,
  _briefId: string,
): Promise<number> {
  const ctx = newChunkContext(requestId, adapter.model);
  const headers = traceIdHeader(requestId);
  res.writeHead(200, { ...STREAMING_RESPONSE_HEADERS, [headers.name]: headers.value });
  let bytes = 0;
  const write = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk, "utf8");
    res.write(chunk);
  };
  write(encodeRoleChunk(ctx));
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop";
  try {
    for await (const ev of adapter.sendMessage({ system, messages }) as AsyncIterable<StreamEvent>) {
      if (ev.type === "text_delta") {
        write(encodeContentChunk(ctx, ev.delta));
      } else if (ev.type === "done") {
        // If the upstream emitted no streaming deltas but did produce a
        // final message, flush it as a single content chunk so the
        // client still sees the text.
        if (ev.message && bytes === 0 + Buffer.byteLength(encodeRoleChunk(ctx), "utf8")) {
          write(encodeContentChunk(ctx, ev.message));
        }
        break;
      } else if (ev.type === "error") {
        throw ev.error;
      }
    }
  } catch (err) {
    write(encodeErrorChunk((err as Error).message, "server_error", "openwar_upstream_error"));
    finishReason = "stop";
  }
  write(encodeFinishChunk(ctx, finishReason));
  write(SSE_DONE_SENTINEL);
  res.end();
  return bytes;
}

// ---- Internal helpers ----

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.byteLength),
  });
  res.end(buf);
}

function sendJsonWithTraceHeader(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  const h = traceIdHeader(requestId);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.byteLength),
    [h.name]: h.value,
  });
  res.end(buf);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
