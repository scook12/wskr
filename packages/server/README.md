# @wskr/server

JSON-RPC server over WebSocket for controlling `krunvm` operations.

## Install and run

### Ephemeral (recommended)

```bash
bunx @wskr/server
```

### Global install

```bash
bun add -g @wskr/server
wskr-server
```

## Transport modes

`@wskr/server` supports both Unix socket and TCP WebSocket transport.

- Default: Unix socket (`KRUN_SERVER_TRANSPORT=unix`)
- Bunx/local and integration testing: TCP (`KRUN_SERVER_TRANSPORT=tcp`)

## Environment variables

- `KRUN_SERVER_TRANSPORT`: `unix` (default) or `tcp`
- `KRUN_SOCKET_PATH`: Unix socket path (default `/run/krunvmd.sock`)
- `KRUN_TCP_HOST`: TCP host for `tcp` transport (default `127.0.0.1`)
- `KRUN_TCP_PORT`: TCP port for `tcp` transport (default `8877`)
- `KRUN_BINARY_PATH`: `krunvm` binary path (default `/usr/local/bin/krunvm`)
- `KRUN_DEFAULT_TIMEOUT_MS`: per-command timeout in ms
- `KRUN_MAX_CONCURRENT_OPS`: max concurrent operations
- `KRUN_MAX_PAYLOAD_BYTES`: websocket payload limit
- `KRUN_WS_IDLE_TIMEOUT_SEC`: websocket idle timeout
- `KRUN_WS_CLOSE_ON_BACKPRESSURE`: websocket backpressure behavior (`true`/`false`)
- `KRUN_ALLOWED_WORKDIRS`: comma-separated allowed workdir roots
- `KRUN_MAX_OUTPUT_BYTES`: max command output size
- `KRUN_FINISHED_OP_TTL_MS`: completed operation retention TTL

## Startup preflight

Startup performs a hard-fail preflight and exits non-zero when required dependencies are missing.

Preflight checks include:

- `krunvm` binary presence and executability
- Unix socket parent directory writability (Unix transport)
- Socket path sanity (must be socket if already present)
- TCP host/port configuration validity (TCP transport)

## Development

```bash
bun run --filter @wskr/server test
```

Integration tests run with a `krunvm` shim by default. Real `krunvm` smoke tests are opt-in:

```bash
bun run --filter @wskr/server test:integration:real
```

## Publishing

```bash
bun publish --cwd packages/types
bun publish --cwd packages/server
```

Publish `@wskr/types` before `@wskr/server`.
