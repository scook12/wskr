# @wskr/opencode-plugin

OpenCode tool plugin that enforces WSKR runtime policy for command execution.

## Install

```bash
bun add @wskr/opencode-plugin
```

## Behavior

- Loads runtime policy from `~/.config/opencode/wskr.toml` by default.
- Resolves agent -> profile -> command policy.
- Enforces command decisions (`allow` / `ask` / `deny` / `never`).
- Runs commands through Sandbox Agent with WSKR provider.
- Applies runtime redaction and audit logging.

## Environment

- `OPENCODE_SBX_POLICY_FILE`: override policy file path.
- `OPENCODE_SANDBOX_AGENT_BASE_URL`: connect to existing sandbox-agent.
- `OPENCODE_SANDBOX_AGENT_TOKEN`: token for sandbox-agent access.

## Development

```bash
bun run --filter @wskr/opencode-plugin test
```
