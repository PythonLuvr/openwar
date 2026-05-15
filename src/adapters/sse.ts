// Minimal SSE (Server-Sent Events) line parser.
// Yields one parsed event per `data:` field. Handles multi-line data blocks.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) yield ev;
    }
  }
  if (buffer.trim()) {
    const ev = parseBlock(buffer);
    if (ev) yield ev;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return event !== undefined ? { event, data: dataLines.join("\n") } : { data: dataLines.join("\n") };
}
