// Role registry. Built-in roles are registered at module-load time;
// forkers add custom roles via `registerRole(def)`. The registry is the
// authoritative source the brief validator consults when checking that a
// brief's `roles:` field references known ids.

import type { RoleDefinition, RoleId } from "../types.js";
import { plannerDefinition } from "./planner.js";
import { executorDefinition } from "./executor.js";
import { reviewerDefinition } from "./reviewer.js";
import { criticDefinition } from "./critic.js";

const registry = new Map<RoleId, RoleDefinition>();

export function registerRole(def: RoleDefinition): void {
  if (!def.id || typeof def.id !== "string") {
    throw new Error("Role definition requires a non-empty string id.");
  }
  registry.set(def.id, def);
}

export function getRole(id: RoleId): RoleDefinition | undefined {
  return registry.get(id);
}

export function listRoles(): RoleDefinition[] {
  return [...registry.values()];
}

export function listRoleIds(): RoleId[] {
  return [...registry.keys()];
}

// Replace a registered role. Mostly used in tests to swap built-ins for
// deterministic prompts. Does not warn on missing prior registration.
export function setRole(def: RoleDefinition): void {
  registry.set(def.id, def);
}

// Test/utility: clear non-builtin entries. Built-ins are re-registered at
// the bottom of this module on first import; tests that need a clean slate
// can call this and then re-import this module to reset.
export function _resetRegistryToBuiltIns(): void {
  registry.clear();
  registerBuiltIns();
}

function registerBuiltIns(): void {
  registerRole(plannerDefinition);
  registerRole(executorDefinition);
  registerRole(reviewerDefinition);
  registerRole(criticDefinition);
}

// Side effect at load: every consumer of the registry sees built-ins.
registerBuiltIns();
