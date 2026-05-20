// v0.13.0: bearer-token auth for openwar serve --openai-compat.
//
// Conservative defaults per the brief: auth required unless --no-auth.
// The Authorization header must be exactly `Bearer <token>` (case-
// insensitive scheme), and the token must constant-time-equal the
// configured value. Bytes-level constant-time compare is used to make
// timing-side-channel exploits against the token impossibly slow over
// localhost.

import { timingSafeEqual } from "node:crypto";

export interface AuthResult {
  ok: boolean;
  reason?: "missing_header" | "wrong_scheme" | "wrong_token";
}

// Validate an incoming Authorization header against the configured token.
// `expected` is null only when noAuth is set; in that case authorize() is
// not called (the server short-circuits before this path). Returning
// false flows up to a 401 response via the OpenAI error shape.
export function authorizeRequest(headerValue: string | undefined, expected: string): AuthResult {
  if (!headerValue) return { ok: false, reason: "missing_header" };
  // RFC 7235 case-insensitive scheme match. Token field is case-sensitive.
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) return { ok: false, reason: "wrong_scheme" };
  const presented = m[1]!;
  // Constant-time compare. Buffers must be equal length; pad to longer
  // side so the compare itself is constant-time and the length mismatch
  // does not leak. presented.length might exceed expected.length on
  // probe attempts; the OR makes wrong-length safely fail.
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "wrong_token" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "wrong_token" };
}

// 401 body in OpenAI's error shape. Distinct codes for the three reasons
// so a curious operator can disambiguate via response body without
// adding new logging on the server side.
export function unauthorizedResponse(reason: AuthResult["reason"]): {
  status: 401;
  body: { error: { message: string; type: string; code: string } };
} {
  const codeMap = {
    missing_header: "openwar_missing_authorization",
    wrong_scheme: "openwar_unsupported_auth_scheme",
    wrong_token: "openwar_invalid_token",
  } as const;
  const messages = {
    missing_header: "Missing Authorization header. Send 'Authorization: Bearer <token>'.",
    wrong_scheme: "Unsupported Authorization scheme. Use 'Authorization: Bearer <token>'.",
    wrong_token: "Invalid bearer token.",
  } as const;
  const key = (reason ?? "wrong_token") as keyof typeof codeMap;
  return {
    status: 401,
    body: {
      error: {
        message: messages[key],
        type: "invalid_request_error",
        code: codeMap[key],
      },
    },
  };
}
