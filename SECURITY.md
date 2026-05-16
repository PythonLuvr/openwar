# Security Policy

## Reporting a vulnerability

If you find a security issue in OpenWar, please do not open a public GitHub issue.

Instead, report it privately:

- Open a private security advisory on this repo: https://github.com/PythonLuvr/openwar/security/advisories/new
- Or DM the maintainer on Discord: https://discord.gg/ku6GJS92V2

You can expect an initial response within 7 days. Confirmed issues will be patched in the next minor release, or sooner if the severity warrants it.

## Scope

OpenWar is a runtime that drives third-party LLMs and tools. The security boundaries we maintain:

- **Sandbox escape**: a brief's tool calls should never reach paths or hosts outside the authorized scope.
- **Authorization bypass**: a brief's `authorized_costs` list should fully gate destructive operations. Bypassing it via tool name spoofing, category aliasing, or coordinator state manipulation is in scope.
- **State corruption**: the session state files under `~/.openwar/` should not be readable or writable by other users on the system.
- **MCP transport**: the JSON-RPC transport for MCP servers should validate handshake responses and reject malformed messages.

Out of scope:

- Vulnerabilities in third-party LLM providers (Anthropic, OpenAI, Gemini, Grok, etc).
- Vulnerabilities in MCP servers written by other authors.
- Prompt-injection attacks against the LLM itself (these are an active research area, not a runtime security boundary).

## Supported versions

| Version | Security patches |
|---------|------------------|
| 0.4.x   | yes              |
| < 0.4   | no               |

Pin to a known-good version in your `package.json` if you need long-term stability.
