// v0.7.1: hand-rolled TOML serializer. Scoped to exactly what OpenWar's
// Codex MCP config needs; not a general-purpose library.
//
// Supports:
//   - Dotted section headers ([mcp_servers.openwar])
//   - String values (basic strings, double-quoted)
//   - String array values (["a", "b", "c"])
//
// Does NOT support: integers, floats, booleans, dates, inline tables,
// multi-line strings, tables of tables, comments, anything beyond what
// MCP config requires.
//
// Escape rules follow TOML 1.0 for basic strings:
//   \b \t \n \f \r \" \\
//   non-printable Unicode via \uXXXX (4 hex digits)
//
// Public surface: TomlConfig type + writeTomlConfig() function. Keep small.

export interface TomlConfig {
  // Section -> { key -> value }. Section is the dotted header (e.g.
  // "mcp_servers.openwar"). Values are strings or string arrays only.
  // Insertion order is preserved in the output so the operator can read
  // the file top-to-bottom in a predictable shape.
  sections: Array<{
    header: string;
    fields: Array<{ key: string; value: string | string[] }>;
  }>;
}

// Serialize a TomlConfig to the canonical TOML 1.0 form. Output is
// deterministic byte-for-byte for the same input; tests rely on this.
export function writeTomlConfig(config: TomlConfig): string {
  const out: string[] = [];
  for (let i = 0; i < config.sections.length; i++) {
    const section = config.sections[i]!;
    if (i > 0) out.push("");
    out.push(`[${section.header}]`);
    for (const field of section.fields) {
      out.push(`${field.key} = ${formatValue(field.value)}`);
    }
  }
  // TOML files conventionally end with a newline.
  return out.join("\n") + "\n";
}

function formatValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[" + value.map(escapeBasicString).join(", ") + "]";
  }
  return escapeBasicString(value);
}

// Wrap a string in double quotes and escape per TOML 1.0 basic-string rules.
// Exported for tests; not part of the public API surface.
export function escapeBasicString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 0x08: out += "\\b"; break;
      case 0x09: out += "\\t"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0d: out += "\\r"; break;
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      default:
        // Control characters (U+0000 - U+001F minus the ones handled above,
        // plus U+007F) must be escaped via \uXXXX. Other Unicode is left
        // as-is because UTF-8 is the canonical TOML encoding.
        if (ch < 0x20 || ch === 0x7f) {
          out += "\\u" + ch.toString(16).padStart(4, "0").toUpperCase();
        } else {
          out += s[i];
        }
        break;
    }
  }
  out += '"';
  return out;
}

// v0.7.1 read-modify-write helper. Replaces an existing section block
// in raw TOML text or appends it if not present. Operates on text
// boundaries (section header at column 0 to next section header at
// column 0 or EOF). No TOML parser required.
//
// Used by the Codex registry entry to preserve other sections an operator
// may have hand-written in ~/.codex/config.toml. Brief Phase 0 pick (a).
export function upsertTomlSection(
  existing: string,
  sectionHeader: string,
  sectionBody: string,
): string {
  // Normalize CRLF to LF for boundary detection; we re-emit LF.
  const text = existing.replace(/\r\n/g, "\n");
  // Find the section header at column 0. Match exactly to avoid clobbering
  // a header that happens to be a prefix of another section.
  const headerLine = `[${sectionHeader}]`;
  const headerIdx = findHeaderIndex(text, headerLine);
  // Compose the replacement block. Strip any trailing newlines on the body;
  // we re-add exactly one to terminate the section cleanly.
  const trimmedBody = sectionBody.replace(/\n+$/, "");
  const replacement = `${headerLine}\n${trimmedBody}\n`;
  if (headerIdx === -1) {
    // Append. Ensure separation from existing content; if existing already
    // ends with a blank line, don't add a second one.
    if (text.length === 0) return replacement;
    const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return text + sep + replacement;
  }
  // Find the end of this section: either the next [header] line at column 0
  // or EOF. Skip past the header line itself when searching.
  const afterHeader = headerIdx + headerLine.length;
  const nextHeaderIdx = findNextHeaderIndex(text, afterHeader);
  const before = text.slice(0, headerIdx);
  const after = nextHeaderIdx === -1 ? "" : text.slice(nextHeaderIdx);
  // Preserve whatever separation existed before the section we're replacing.
  // Append separation before `after` so the next section keeps its position.
  const trailingSep = after.length > 0 && !replacement.endsWith("\n\n") && !after.startsWith("\n") ? "\n" : "";
  return before + replacement + trailingSep + after;
}

// Find a header at column 0 (start of file or after newline). Returns the
// index of the [ character, or -1 when absent.
function findHeaderIndex(text: string, headerLine: string): number {
  // First line check.
  if (text.startsWith(headerLine) && (text.length === headerLine.length || text[headerLine.length] === "\n")) {
    return 0;
  }
  // Subsequent lines.
  const needle = "\n" + headerLine;
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return -1;
    // Ensure the match ends at a newline or EOF, not partway through a
    // longer header (e.g. [foo] vs [foo.bar]).
    const endOfMatch = idx + needle.length;
    if (endOfMatch === text.length || text[endOfMatch] === "\n") {
      return idx + 1;
    }
    from = idx + 1;
  }
}

// Find the next header at column 0 starting at `from`. Returns the index
// of the [ character, or -1 when absent.
function findNextHeaderIndex(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    if (nl === -1) return -1;
    const lineStart = nl + 1;
    if (lineStart < text.length && text[lineStart] === "[") {
      return lineStart;
    }
    i = lineStart;
  }
  return -1;
}
