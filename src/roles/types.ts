// Re-export the v0.4 role-related types from the central types file so
// consumers can import either path (`openwar/roles/types` or `openwar`).

export type {
  RoleDefinition,
  RoleContext,
  RoleResult,
  RoleCost,
  RoleId,
  BuiltInRoleId,
} from "../types.js";
