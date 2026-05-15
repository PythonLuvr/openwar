// Stdio JSON-RPC transport for MCP. Spawns a child process and exchanges
// newline-delimited JSON messages over stdin/stdout.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { McpTransport, McpProtocolError, McpTransportError, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcNotification } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface StdioTransportOpts {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}

export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = "";
  private closeResolve: () => void = () => {};
  readonly closed: Promise<void>;
  private isClosed = false;
  private readonly defaultTimeoutMs: number;

  constructor(opts: StdioTransportOpts) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise<void>(resolve => { this.closeResolve = resolve; });

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", () => { /* swallow; servers log diagnostics here */ });
    this.child.on("error", err => this.fail(new McpTransportError(`child error: ${err.message}`)));
    this.child.on("exit", (code, signal) => {
      this.fail(new McpTransportError(`child exited (code=${code}, signal=${signal ?? "none"})`));
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // Cap buffer to prevent unbounded memory growth on malformed servers.
    if (this.buffer.length > 5_000_000) {
      this.fail(new McpTransportError("inbound buffer exceeded 5MB; aborting"));
      return;
    }
    let newlineIdx;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Malformed message: log via stderr would help, but we don't crash.
      // No silent failures per spec; surface to next caller via console.error.
      console.error(`MCP stdio: malformed JSON: ${(err as Error).message}`);
      return;
    }
    if ("id" in parsed && parsed.id !== null && parsed.id !== undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return; // late response, no pending request
      this.pending.delete(parsed.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(new McpProtocolError(parsed.error.message, parsed.error.code));
      } else {
        pending.resolve(parsed.result);
      }
    }
    // Notifications are accepted but ignored at this layer (no subscribers yet).
  }

  private fail(err: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.closeResolve();
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.isClosed) throw new McpTransportError("transport closed");
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new McpProtocolError(`request "${method}" timed out after ${this.defaultTimeoutMs}ms`));
        }
      }, this.defaultTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const line = JSON.stringify(req) + "\n";
      this.child.stdin.write(line, err => {
        if (err) {
          this.pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(new McpTransportError(`write failed: ${err.message}`));
        }
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.isClosed) throw new McpTransportError("transport closed");
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined && { params }) };
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(msg) + "\n", err => {
        if (err) reject(new McpTransportError(`write failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.child.stdin.end();
    // Give the child a moment to exit cleanly, then kill.
    const timer = setTimeout(() => {
      try { this.child.kill("SIGTERM"); } catch { /* swallow */ }
    }, 1000);
    await new Promise<void>(resolve => this.child.once("exit", () => resolve()));
    clearTimeout(timer);
    this.fail(new McpTransportError("transport closed"));
  }
}
