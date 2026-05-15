import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { transcriptFile } from "./paths.js";
import { ensureSessionsDir } from "./persist.js";
import type { Message } from "../types.js";

export interface TranscriptEntry {
  at: string;
  brief_id: string;
  message: Message;
}

// Append-only JSONL log per session. Each line is a single Message wrapped
// with brief_id + timestamp for easy filtering across briefs.
export function appendTranscript(briefId: string, message: Message): void {
  ensureSessionsDir();
  const path = transcriptFile(briefId);
  const entry: TranscriptEntry = {
    at: new Date().toISOString(),
    brief_id: briefId,
    message,
  };
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export function readTranscript(briefId: string): TranscriptEntry[] {
  const path = transcriptFile(briefId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TranscriptEntry => e !== null);
}
