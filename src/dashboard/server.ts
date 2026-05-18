// v0.8: optional local dashboard. node:http server, bound to 127.0.0.1 only
// (IPv4 literal; Windows IPv6 resolution has burned this in the past). Zero
// remote calls, zero third-party deps, hand-rolled HTML over vanilla CSS.
//
// Architecture: the dashboard is a thin HTML wrapper around the same inspect
// formatters used by `openwar inspect`. Single source of truth for the on-
// disk text view and the web view, so the column shapes stay in sync.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir, sessionFile } from "../state/paths.js";
import { readSession } from "../state/persist.js";
import { readTrace } from "../state/trace.js";
import {
  formatTrace,
  formatTiming,
  formatCost,
  formatDetectors,
  formatTools,
  formatMcp,
} from "../cli/inspect.js";

export interface DashboardOptions {
  port: number;
}

export interface DashboardServer {
  close(cb: () => void): void;
  // Exposed for tests; the URL the server is actually bound to.
  address(): { port: number; host: string };
}

export function startDashboard(opts: DashboardOptions): Promise<DashboardServer> {
  return new Promise<DashboardServer>((resolve, reject) => {
    const server: Server = createServer((req, res) => handle(req, res).catch((err) => {
      respondError(res, 500, String((err as Error).message ?? err));
    }));
    server.on("error", (err) => reject(err));
    // 127.0.0.1 literal, not "localhost". Windows IPv6 resolution can pick ::1
    // and surprise the operator who's watching netstat for IPv4.
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        close: (cb) => server.close(() => cb()),
        address: () => ({ port, host: "127.0.0.1" }),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  const path = url.pathname;
  if (path === "/" || path === "/index" || path === "/index.html") return renderIndex(res);
  if (path.startsWith("/session/")) return renderSession(res, path.slice("/session/".length), url.searchParams);
  respondError(res, 404, `Not found: ${path}`);
}

function renderIndex(res: ServerResponse): void {
  let rows: string;
  try {
    const dir = sessionsDir();
    if (!existsSync(dir)) {
      rows = `<tr><td colspan="4">No sessions directory at ${esc(dir)}</td></tr>`;
    } else {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".transcript.json"));
      interface Row { briefId: string; project: string; phase: string; updated: string }
      const collected: Row[] = [];
      for (const f of files) {
        try {
          const briefId = f.replace(/\.json$/, "");
          const s = readSession(briefId);
          if (s) {
            collected.push({
              briefId,
              project: s.meta.project,
              phase: String(s.meta.phase),
              updated: s.meta.updated_at,
            });
          }
        } catch {
          /* skip corrupt session files */
        }
      }
      collected.sort((a, b) => b.updated.localeCompare(a.updated));
      if (collected.length === 0) {
        rows = `<tr><td colspan="4">No sessions yet.</td></tr>`;
      } else {
        rows = collected
          .map((s: Row) => `<tr><td><a href="/session/${esc(s.briefId)}">${esc(s.briefId)}</a></td><td>${esc(s.project)}</td><td>${esc(s.phase)}</td><td>${esc(s.updated)}</td></tr>`)
          .join("");
      }
    }
  } catch (err) {
    rows = `<tr><td colspan="4">Error: ${esc(String((err as Error).message ?? err))}</td></tr>`;
  }
  respondHtml(res, page("OpenWar dashboard", `
<h1>OpenWar dashboard</h1>
<p>Sessions in <code>${esc(sessionsDir())}</code>. Click a brief id for the per-session view.</p>
<table>
<thead><tr><th>brief_id</th><th>project</th><th>phase</th><th>updated_at</th></tr></thead>
<tbody>${rows}</tbody>
</table>
`));
}

function renderSession(res: ServerResponse, briefId: string, query: URLSearchParams): void {
  const session = readSession(briefId);
  if (!session) {
    respondHtml(res, page(`Session ${briefId}`, `<h1>Not found</h1><p>No session for "${esc(briefId)}".</p>`));
    return;
  }
  const sessionFilePath = sessionFile(briefId);
  void sessionFilePath;
  const { events, empty } = readTrace(briefId);
  const view = query.get("view") ?? "summary";

  const tabs = ["summary", "timing", "cost", "detectors", "tools", "mcp", "trace"]
    .map((v) => v === view
      ? `<span class="tab active">${esc(v)}</span>`
      : `<a class="tab" href="/session/${esc(briefId)}?view=${esc(v)}">${esc(v)}</a>`)
    .join(" ");

  let body: string;
  if (empty) {
    body = `<p>No trace events for "${esc(briefId)}". This session was likely written before v0.8.</p>`;
  } else if (view === "summary") {
    body = `
<pre>
brief_id:   ${esc(session.meta.brief_id)}
project:    ${esc(session.meta.project)}
phase:      ${esc(session.meta.phase)}
mode:       ${esc(session.meta.mode ?? "(unset)")}
started:    ${esc(session.meta.started_at)}
updated:    ${esc(session.meta.updated_at)}
events:     ${events.length}
</pre>`;
  } else if (view === "timing") {
    body = `<pre>${esc(formatTiming(events))}</pre>`;
  } else if (view === "cost") {
    body = `<pre>${esc(formatCost(events))}</pre>`;
  } else if (view === "detectors") {
    body = `<pre>${esc(formatDetectors(events))}</pre>`;
  } else if (view === "tools") {
    body = `<pre>${esc(formatTools(events))}</pre>`;
  } else if (view === "mcp") {
    body = `<pre>${esc(formatMcp(events))}</pre>`;
  } else if (view === "trace") {
    body = `<pre>${esc(formatTrace(events, { full: true }))}</pre>`;
  } else {
    body = `<p>Unknown view "${esc(view)}".</p>`;
  }

  respondHtml(res, page(`Session ${briefId}`, `
<p><a href="/">&larr; all sessions</a></p>
<h1>${esc(briefId)}</h1>
<nav class="tabs">${tabs}</nav>
${body}
`));
}

// --- HTML helpers. No template engine, no React. ---

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${CSS}</style></head><body><main>${content}</main></body></html>`;
}

const CSS = `
body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #fafafa; color: #111; }
main { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
h1 { font-weight: 600; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f3f3f3; }
pre { background: #fff; padding: 1rem; border: 1px solid #eee; overflow-x: auto; white-space: pre; font-family: ui-monospace, Consolas, monospace; }
nav.tabs { margin: 1rem 0; }
.tab { padding: 0.3rem 0.6rem; border-radius: 4px; text-decoration: none; color: #444; background: #ececec; margin-right: 0.3rem; }
.tab.active { background: #111; color: #fff; }
a { color: #0050a0; }
a:hover { text-decoration: underline; }
code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
`;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function respondHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function respondError(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${code} ${message}\n`);
}
