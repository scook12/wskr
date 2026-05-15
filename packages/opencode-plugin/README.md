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
- `OPENCODE_WSKR_CLIENT_URL`: explicit WSKR runtime client URL override.

## Runtime Client URL Resolution

When provisioning through `@wskr/provider`, the plugin chooses the WSKR client URL in this order:

1. Explicit provider client options (`clientOptions.url`) if set in plugin code.
2. `OPENCODE_WSKR_CLIENT_URL` environment override.
3. `[client].url` in `wskr.toml`.
4. Auto-derived from server env:
   - `KRUN_SERVER_TRANSPORT=tcp` -> `ws://$KRUN_TCP_HOST:$KRUN_TCP_PORT/rpc`
   - `KRUN_SERVER_TRANSPORT=unix` (default) -> `ws+unix://$KRUN_SOCKET_PATH:/rpc`

## Workdir Alignment

- Profile runtime `workdir` values are sent to the WSKR server in `create` requests.
- Server forwards `workdir` to the runtime command layer.
- Runtime policy ownership stays in plugin/client configuration.

## Development

```bash
bun run --filter @wskr/opencode-plugin test
```
