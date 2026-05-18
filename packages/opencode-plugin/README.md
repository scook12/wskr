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
- Applies runtime redaction and audit logging with command minimization (hash + redacted preview).

## Environment

- `OPENCODE_SBX_POLICY_FILE`: override policy file path.
- `OPENCODE_SANDBOX_AGENT_BASE_URL`: connect to existing sandbox-agent.
- `OPENCODE_SANDBOX_AGENT_TOKEN`: token for sandbox-agent access.
- `OPENCODE_SANDBOX_AGENT_READY_TIMEOUT_MS`: provider `/v1/health` readiness timeout before create fails.
- `OPENCODE_WSKR_CLIENT_URL`: explicit WSKR runtime client URL override.
- `OPENCODE_WSKR_SILENCE_INSECURE_WS_WARNING`: set to `1` to suppress warn-only notices for remote `ws://` runtime URLs.

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
- Network policy is enforced at plugin command-policy layer and is not passed as krunvm `create` flags.

## Runtime Compatibility Notes

- Mounts are translated to krunvm `--volume host:guest` values.
- Guest mount paths must be a single root child path (for example `/workspace`).
- Mount `mode` is currently metadata only and is ignored for krunvm CLI arguments.
- Sandbox lifecycle is provisioned via provider `boot` (non-blocking launch) with `/v1/health` readiness checks.

## Development

```bash
bun run --filter @wskr/opencode-plugin test
```
