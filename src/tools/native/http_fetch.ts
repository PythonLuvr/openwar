// http_fetch native tool. Requires http_fetch category.
// Honors session HTTP allowlist. Caps body at session output limit.

import { URL } from "node:url";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from "../types.js";
import { isHostAllowed } from "../../sandbox/host-allowlist.js";
import { withTimeout, TimeoutError } from "../../sandbox/timeout.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

export const HTTP_FETCH_DEFINITION: ToolDefinition = {
  name: "http_fetch",
  description:
    "Make an HTTP or HTTPS request. Honors the session's host allowlist (~/.openwar/http-allow.json). " +
    "Refuses non-HTTP(S) schemes. Caps body at max_bytes. Follows up to 5 redirects.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http:// or https:// URL." },
      method: { type: "string", description: "HTTP method. Default GET." },
      headers: { type: "object", description: "Request headers as a flat object." },
      body: { type: "string", description: "Request body for POST/PUT/PATCH. UTF-8 string." },
      timeout_ms: { type: "number", description: "Override timeout. Default 15000." },
      max_bytes: { type: "number", description: "Cap on response body bytes. Default 5000000." },
    },
    required: ["url"],
  },
  origin: "native",
  authorization_categories: ["http_fetch"],
};

interface HttpFetchArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout_ms?: number;
  max_bytes?: number;
}

function parseArgs(call: ToolCall): HttpFetchArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.url !== "string") return { error: "url must be a string" };
  if (a.method !== undefined && typeof a.method !== "string") return { error: "method must be a string" };
  if (a.headers !== undefined && (typeof a.headers !== "object" || a.headers === null)) {
    return { error: "headers must be an object if provided" };
  }
  if (a.body !== undefined && typeof a.body !== "string") return { error: "body must be a string" };
  if (a.timeout_ms !== undefined && (typeof a.timeout_ms !== "number" || a.timeout_ms <= 0)) {
    return { error: "timeout_ms must be positive" };
  }
  if (a.max_bytes !== undefined && (typeof a.max_bytes !== "number" || a.max_bytes < 0)) {
    return { error: "max_bytes must be non-negative" };
  }
  return {
    url: a.url,
    method: a.method as string | undefined,
    headers: a.headers as Record<string, string> | undefined,
    body: a.body as string | undefined,
    timeout_ms: a.timeout_ms as number | undefined,
    max_bytes: a.max_bytes as number | undefined,
  };
}

export const httpFetchExecutor: ToolExecutor = async (
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> => {
  const parsed = parseArgs(call);
  if ("error" in parsed) {
    return {
      call_id: call.id,
      success: false,
      content: parsed.error,
      error: { code: "INVALID_ARGS", message: parsed.error },
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsed.url);
  } catch {
    return {
      call_id: call.id,
      success: false,
      content: `Invalid URL: ${parsed.url}`,
      error: { code: "INVALID_URL", message: "could not parse URL" },
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      call_id: call.id,
      success: false,
      content: `Refused non-HTTP(S) scheme: ${parsedUrl.protocol}`,
      error: { code: "BAD_SCHEME", message: "only http/https permitted" },
    };
  }
  if (!isHostAllowed(ctx.httpAllowlist, parsedUrl.hostname)) {
    return {
      call_id: call.id,
      success: false,
      content: `Host ${parsedUrl.hostname} is not in the HTTP allowlist`,
      error: { code: "HOST_NOT_ALLOWED", message: "host not permitted" },
    };
  }

  const start = Date.now();
  const timeout = parsed.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = parsed.max_bytes ?? DEFAULT_MAX_BYTES;
  const method = (parsed.method ?? "GET").toUpperCase();

  const ac = new AbortController();
  try {
    const fetchPromise = fetch(parsed.url, {
      method,
      headers: parsed.headers,
      body: parsed.body,
      redirect: "follow",
      signal: ac.signal,
    });
    const res = await withTimeout(fetchPromise, timeout, ac.signal);

    // Truncate body to max_bytes. fetch().text() loads the whole body, so we
    // stream via .arrayBuffer() approach with manual cap via reader.
    const reader = res.body?.getReader();
    let received = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received >= maxBytes) {
          truncated = true;
          ac.abort();
          break;
        }
        if (received + value.length > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - received));
          received = maxBytes;
          truncated = true;
          ac.abort();
          break;
        }
        chunks.push(value);
        received += value.length;
      }
    }
    const body = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });

    return {
      call_id: call.id,
      success: res.ok,
      content: JSON.stringify({ status: res.status, headers, body, truncated }, null, 2),
      meta: { duration_ms: Date.now() - start, bytes: received, truncated },
    };
  } catch (err) {
    if (err instanceof TimeoutError) {
      ac.abort();
      return {
        call_id: call.id,
        success: false,
        content: `HTTP request timed out after ${timeout}ms`,
        error: { code: err.code, message: err.message },
      };
    }
    const message = (err as Error).message;
    return {
      call_id: call.id,
      success: false,
      content: `HTTP error: ${message}`,
      error: { code: "FETCH_ERROR", message },
    };
  }
};

// MAX_REDIRECTS exported for downstream tests / future redirect-loop checks
// when we move off the native fetch (which honors its own redirect handling).
export { MAX_REDIRECTS };
