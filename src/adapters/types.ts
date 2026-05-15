export type { AgentAdapter, SendMessageOptions, StreamEvent, AdapterConfig } from "../types.js";

import type { AgentAdapter, AdapterConfig } from "../types.js";

export interface AdapterFactory {
  id: string;
  create(config: AdapterConfig): AgentAdapter;
}
