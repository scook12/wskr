# AGENTS.md

Guidance for coding agents working in the `wskr` monorepo.

## What this repo is

`wskr` is a Bun-first TypeScript monorepo for krunvm-backed runtime isolation:

- `@wskr/server`: WebSocket JSON-RPC daemon that executes krunvm operations.
- `@wskr/client`: TypeScript client SDK for the server protocol.
- `@wskr/provider` (in `packages/agent-sandbox-provider`): Agent Sandbox provider built on `@wskr/client`.
- `@wskr/opencode-plugin`: OpenCode plugin that wraps bash execution with runtime policy enforcement and sandbox execution.
- `@wskr/types`: shared Zod schemas and protocol/runtime policy types used by all packages.

## Runtime + toolchain (important)

- Use `bun` for everything: install, run, test, build, and publish.
- Do not switch scripts to `node`, `npm`, `pnpm`, or `yarn` unless explicitly requested.
- Bun APIs are intentionally used across packages (`Bun.serve`, `Bun.spawn`, `Bun.file`, `Bun.TOML`, `Bun.which`), so Node-only rewrites are not drop-in safe.
- Repo requires Bun (`packageManager: bun@1.2.16`, `engines.bun >= 1.1.0`).

## Workspace layout

Root workspaces (in dependency order):

1. `packages/types` (`@wskr/types`)
2. `packages/server` (`@wskr/server`)
3. `packages/client` (`@wskr/client`)
4. `packages/agent-sandbox-provider` (`@wskr/provider`)
5. `packages/opencode-plugin` (`@wskr/opencode-plugin`)

Dependency direction:

- `types` <- (`server`, `client`)
- `client` <- `provider`
- (`provider`, `types`) <- `opencode-plugin`

If you change protocol or runtime policy schemas in `@wskr/types`, check all downstream packages.

## High-level architecture decisions

### 1) Server is queue-based, async, and connection-scoped

- Server accepts JSON-RPC-like messages over WebSocket at `/rpc`.
- Operations are acknowledged immediately (`accepted`), then emit `op.update` and terminal `op.done` events.
- Execution is queue-limited by `KRUN_MAX_CONCURRENT_OPS`.
- Cancel is connection-scoped: a client cannot cancel another connection's operation.
- Finished operations are retained for a TTL (`KRUN_FINISHED_OP_TTL_MS`) and then garbage-collected.

### 2) Security defaults are fail-closed where possible

- Startup preflight is hard-fail: missing/non-executable `krunvm` or invalid transport config exits non-zero.
- Unix socket startup refuses to remove stale non-socket paths.

### 3) Protocol and policy contracts are schema-first

- `@wskr/types` is the single source of truth for wire schemas and runtime policy schemas (Zod).
- Server parsing and client parsing both validate against shared schemas.
- Runtime policy loading in plugin validates TOML and fails closed on missing/invalid policy.

### 4) OpenCode plugin enforces policy before execution

- Policy file defaults to `~/.config/opencode/wskr.toml` (override with `OPENCODE_SBX_POLICY_FILE`).
- Command decisions follow policy actions: `allow`, `ask`, `deny`, and non-overridable `never`.
- Network policy is evaluated at command layer (`open` / `deny` / `allowlist`) before process execution.
- Secrets modes (`none`, `dummy`, `brokered`) and output redaction are built in.
- Audit records are appended as NDJSON when enabled.
- Sandbox clients are pooled and reused with idle/pruning limits from policy.

## Common commands

Run from repo root:

```bash
bun install
bun run build
bun run typecheck
bun run test
bun run format
bun run format:check
```

Workspace-specific examples:

```bash
bun run --filter @wskr/server test
bun run --filter @wskr/server test:integration
bun run --filter @wskr/server test:integration:real
bun run --filter @wskr/client test
bun run --filter @wskr/provider test
bun run --filter @wskr/opencode-plugin test
```

Notes:

- Root `dev` runs all workspace `dev` scripts (`bun run --workspaces dev`). Prefer `--filter` during focused work.
- Root `build`/`typecheck` use TypeScript project references (`tsc -b`).

## Testing model

- Test runner is Bun (`bun test`).
- Coverage is enabled globally in `bunfig.toml`.
- Server integration tests use a Bun-based `krunvm` shim by default.
- Real krunvm integration path is opt-in via `WSKR_USE_REAL_KRUNVM=1` and runs dedicated real tests (`test/real.integration.test.ts`).

When changing server protocol/lifecycle behavior, run at least:

```bash
bun run --filter @wskr/server test
bun run --filter @wskr/client test
```

## Transport and endpoint expectations

- Server default transport is Unix socket (`KRUN_SERVER_TRANSPORT=unix`).
- Client default URL is TCP WebSocket (`ws://127.0.0.1:8877/rpc`).
- If relying on client defaults, run server in TCP mode or override client URL.

## Formatting + TypeScript conventions

- Formatting is Biome (`biome format --write .`), with 2-space indentation and double quotes.
- Biome linter is disabled; do not assume lint tasks catch correctness issues.
- TS config is strict, ES modules, Bundler module resolution, and Bun types.
- Most packages emit declarations only; `@wskr/client` emits JS + d.ts to `dist`.

## Release and publish workflow

- Release scripts are Bun-based and driven from root.
- Dry run: `bun run release:dry-run`.
- Publish order matters: publish `@wskr/types` before dependents.
- Existing scripted sequence: `types -> client -> server`.

## Agent working agreement for this repo

- Prefer minimal, targeted edits; preserve Bun-first assumptions.
- Avoid introducing Node-only runtime assumptions in shared paths.
- Keep protocol and policy changes backwards-aware; update tests in affected packages.
- Do not edit generated `dist` outputs manually.
- When in doubt, validate behavior with workspace-filtered tests before broad root test runs.
