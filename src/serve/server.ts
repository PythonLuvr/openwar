// v0.13.0: HTTP server bootstrap for openwar serve. Hand-rolled on
// node:http per the brief's zero-new-runtime-deps rule. Graceful
// shutdown on SIGINT: stop accepting new requests, wait for in-flight
// to drain (configurable timeout, default 5s), then close.

import { createServer, type Server } from "node:http";
import type { AgentAdapter } from "../types.js";
import { handleRequest, type RouterDeps } from "./openai-router.js";
import { ConcurrencyGate } from "./concurrency.js";
import type { ServeOptions } from "./types.js";
import { Tracer } from "../state/trace.js";
import { traceFile } from "../state/paths.js";

export interface ServerHandle {
  // Stop accepting new requests. Resolves once the underlying server is
  // closed (after the drain window or all in-flight settled, whichever
  // is sooner).
  close(opts?: { drainMs?: number }): Promise<void>;
  // Read-only accessors for diagnostics + tests.
  readonly address: { host: string; port: number };
  readonly gate: ConcurrencyGate;
}

export interface StartServerOptions {
  options: ServeOptions;
  upstream: AgentAdapter;
  openwarVersion: string;
  // Optional override for the trace file path resolver (tests use a
  // tmpdir; production defaults to ~/.openwar/sessions/<id>.trace.ndjson).
  traceFilePath?: (briefId: string) => string;
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const gate = new ConcurrencyGate(opts.options.maxConcurrent);

  const tracerFor = (briefId: string): Tracer => new Tracer({
    briefId,
    enabled: true,
    openwarVersion: opts.openwarVersion,
    ...(opts.traceFilePath ? { filePath: opts.traceFilePath(briefId) } : {}),
  });

  const deps: RouterDeps = {
    options: opts.options,
    gate,
    upstream: opts.upstream,
    tracerFor,
    ...(opts.options.logRequests ? { logRequest: (line: string) => process.stderr.write(line + "\n") } : {}),
  };

  const server = createServer((req, res) => {
    void handleRequest(deps, req, res).catch((err) => {
      // Last-resort safety net. handleRequest itself catches and
      // responds with OpenAI-shaped 500; anything escaping is a bug.
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            error: {
              message: `OpenWar serve: unhandled error: ${(err as Error).message}`,
              type: "server_error",
              code: "openwar_unhandled",
            },
          }));
        } else {
          res.end();
        }
      } catch {
        /* socket already gone */
      }
    });
  });

  await listen(server, opts.options.port, opts.options.bind);
  const addr = server.address();
  if (!addr || typeof addr !== "object") {
    throw new Error("openwar serve: failed to resolve bound address");
  }

  return {
    address: { host: addr.address, port: addr.port },
    gate,
    close: ({ drainMs = 5000 }: { drainMs?: number } = {}) => closeServer(server, gate, drainMs),
  };
}

function listen(server: Server, port: number, bind: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

// Graceful shutdown: stop accepting new connections, wait up to drainMs
// for the concurrency gate to empty, then force-close. The server's own
// .close() callback only fires once all sockets are released; we race it
// against the drain timeout.
async function closeServer(server: Server, gate: ConcurrencyGate, drainMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const onDone = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(() => onDone());
    // Force-close after drainMs even if connections are still in-flight.
    // Callers wanting strict draining should not enable streaming with
    // long upstream calls under a tight drainMs.
    setTimeout(() => {
      if (settled) return;
      try {
        // Best-effort: close idle connections; in-flight ones get killed.
        // node:http's closeAllConnections is available in Node 18.2+.
        const s = server as Server & { closeAllConnections?: () => void };
        s.closeAllConnections?.();
      } catch {
        /* swallow */
      }
      onDone();
    }, drainMs);
    // If the gate empties early, drain immediately.
    const poll = setInterval(() => {
      if (gate.current === 0) {
        clearInterval(poll);
        try {
          const s = server as Server & { closeAllConnections?: () => void };
          s.closeAllConnections?.();
        } catch {
          /* swallow */
        }
      }
    }, 50);
    setTimeout(() => clearInterval(poll), drainMs + 100);
  });
}

// Default trace path for production: ~/.openwar/sessions/<id>.trace.ndjson
// via the existing state/paths helper. Re-exported so server callers
// (the serve subcommand) can use the same resolver without re-importing.
export { traceFile as defaultTraceFile };
