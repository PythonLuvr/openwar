// Native tool registry. Maps name → { definition, executor }.

import type { ToolDefinition, ToolExecutor } from "../types.js";
import { READ_FILE_DEFINITION, readFileExecutor } from "./read_file.js";
import { WRITE_FILE_DEFINITION, writeFileExecutor } from "./write_file.js";
import { LIST_DIR_DEFINITION, listDirExecutor } from "./list_dir.js";
import { SHELL_EXEC_DEFINITION, shellExecExecutor } from "./shell_exec.js";
import { HTTP_FETCH_DEFINITION, httpFetchExecutor } from "./http_fetch.js";
import { APPLY_PATCH_DEFINITION, applyPatchExecutor } from "./apply_patch.js";
import { READ_PROJECT_MEMORY_DEFINITION, readProjectMemoryExecutor } from "./read_project_memory.js";
import { WRITE_PROJECT_MEMORY_DEFINITION, writeProjectMemoryExecutor } from "./write_project_memory.js";

export interface NativeTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

export const NATIVE_TOOLS: ReadonlyMap<string, NativeTool> = new Map([
  ["read_file",   { definition: READ_FILE_DEFINITION,   executor: readFileExecutor }],
  ["write_file",  { definition: WRITE_FILE_DEFINITION,  executor: writeFileExecutor }],
  ["list_dir",    { definition: LIST_DIR_DEFINITION,    executor: listDirExecutor }],
  ["shell_exec",  { definition: SHELL_EXEC_DEFINITION,  executor: shellExecExecutor }],
  ["http_fetch",  { definition: HTTP_FETCH_DEFINITION,  executor: httpFetchExecutor }],
  ["apply_patch", { definition: APPLY_PATCH_DEFINITION, executor: applyPatchExecutor }],
  ["read_project_memory",  { definition: READ_PROJECT_MEMORY_DEFINITION,  executor: readProjectMemoryExecutor }],
  ["write_project_memory", { definition: WRITE_PROJECT_MEMORY_DEFINITION, executor: writeProjectMemoryExecutor }],
]);

export function listNativeDefinitions(): ToolDefinition[] {
  return [...NATIVE_TOOLS.values()].map(t => t.definition);
}

export function getNativeTool(name: string): NativeTool | undefined {
  return NATIVE_TOOLS.get(name);
}
