import { resolve } from "node:path"
import { ProtocolError } from "./errors"

export type ServerTransport = "unix" | "tcp"

export type DaemonConfig = {
  transport: ServerTransport
  unixSocketPath: string
  tcpHost: string
  tcpPort: number
  krunPath: string
  defaultTimeoutMs: number
  maxConcurrentOps: number
  maxPayloadLength: number
  idleTimeoutSec: number
  closeOnBackpressureLimit: boolean
  allowedWorkdirs: string[]
  maxOutputBytes: number
  finishedOpTtlMs: number
}

export type ConfigEnv = Record<string, string | undefined>

function parsePositiveInt(name: string, raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProtocolError("invalid_config", `${name} must be a positive integer`)
  }
  return parsed
}

function parseBoolean(name: string, raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue
  if (raw === "1" || raw.toLowerCase() === "true") return true
  if (raw === "0" || raw.toLowerCase() === "false") return false
  throw new ProtocolError("invalid_config", `${name} must be one of: 1, 0, true, false`)
}

function parseCsv(raw: string | undefined, defaultValue: string[]): string[] {
  if (raw === undefined || raw === "") return defaultValue
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function parseTransport(raw: string | undefined): ServerTransport {
  if (raw === undefined || raw === "" || raw === "unix") return "unix"
  if (raw === "tcp") return "tcp"
  throw new ProtocolError("invalid_config", "KRUN_SERVER_TRANSPORT must be one of: unix, tcp")
}

export function loadConfig(env: ConfigEnv = Bun.env): DaemonConfig {
  return {
    transport: parseTransport(env.KRUN_SERVER_TRANSPORT),
    unixSocketPath: env.KRUN_SOCKET_PATH ?? "/run/krunvmd.sock",
    tcpHost: env.KRUN_TCP_HOST ?? "127.0.0.1",
    tcpPort: parsePositiveInt("KRUN_TCP_PORT", env.KRUN_TCP_PORT, 8877),
    krunPath: env.KRUN_BINARY_PATH ?? "/usr/local/bin/krunvm",
    defaultTimeoutMs: parsePositiveInt(
      "KRUN_DEFAULT_TIMEOUT_MS",
      env.KRUN_DEFAULT_TIMEOUT_MS,
      60_000,
    ),
    maxConcurrentOps: parsePositiveInt("KRUN_MAX_CONCURRENT_OPS", env.KRUN_MAX_CONCURRENT_OPS, 4),
    maxPayloadLength: parsePositiveInt(
      "KRUN_MAX_PAYLOAD_BYTES",
      env.KRUN_MAX_PAYLOAD_BYTES,
      256 * 1024,
    ),
    idleTimeoutSec: parsePositiveInt("KRUN_WS_IDLE_TIMEOUT_SEC", env.KRUN_WS_IDLE_TIMEOUT_SEC, 120),
    closeOnBackpressureLimit: parseBoolean(
      "KRUN_WS_CLOSE_ON_BACKPRESSURE",
      env.KRUN_WS_CLOSE_ON_BACKPRESSURE,
      true,
    ),
    allowedWorkdirs: parseCsv(env.KRUN_ALLOWED_WORKDIRS, ["/tmp"]).map((path) => resolve(path)),
    maxOutputBytes: parsePositiveInt(
      "KRUN_MAX_OUTPUT_BYTES",
      env.KRUN_MAX_OUTPUT_BYTES,
      1024 * 1024,
    ),
    finishedOpTtlMs: parsePositiveInt(
      "KRUN_FINISHED_OP_TTL_MS",
      env.KRUN_FINISHED_OP_TTL_MS,
      5 * 60 * 1000,
    ),
  }
}
