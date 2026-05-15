import { constants } from "node:fs"
import { accessSync, existsSync, lstatSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { DaemonConfig } from "./config"
import { ProtocolError } from "./errors"

export type PreflightCheck = {
  name: string
  ok: boolean
  message: string
  details?: unknown
}

export type PreflightReport = {
  ok: boolean
  checks: PreflightCheck[]
}

function resolveKrunPath(krunPath: string): string | null {
  if (krunPath.includes("/") || krunPath.startsWith(".")) {
    return krunPath
  }

  return Bun.which(krunPath)
}

export function runPreflight(config: DaemonConfig): {
  config: DaemonConfig
  report: PreflightReport
} {
  const checks: PreflightCheck[] = []
  let resolvedKrunPath = config.krunPath

  const resolved = resolveKrunPath(config.krunPath)
  if (!resolved) {
    checks.push({
      name: "krun_binary",
      ok: false,
      message: `krun binary not found: ${config.krunPath}`,
    })
  } else {
    resolvedKrunPath = resolved

    if (!existsSync(resolvedKrunPath)) {
      checks.push({
        name: "krun_binary",
        ok: false,
        message: `krun binary path does not exist: ${resolvedKrunPath}`,
      })
    } else {
      const stat = lstatSync(resolvedKrunPath)
      if (!stat.isFile()) {
        checks.push({
          name: "krun_binary",
          ok: false,
          message: `krun binary path is not a file: ${resolvedKrunPath}`,
        })
      } else {
        try {
          accessSync(resolvedKrunPath, constants.X_OK)
          checks.push({
            name: "krun_binary",
            ok: true,
            message: `krun binary is executable: ${resolvedKrunPath}`,
          })
        } catch {
          checks.push({
            name: "krun_binary",
            ok: false,
            message: `krun binary is not executable: ${resolvedKrunPath}`,
          })
        }
      }
    }
  }

  if (config.transport === "unix") {
    const socketDir = dirname(config.unixSocketPath)

    try {
      mkdirSync(socketDir, { recursive: true })
      accessSync(socketDir, constants.W_OK | constants.X_OK)
      checks.push({
        name: "unix_socket_parent",
        ok: true,
        message: `socket directory is writable: ${socketDir}`,
      })
    } catch {
      checks.push({
        name: "unix_socket_parent",
        ok: false,
        message: `socket directory is not writable: ${socketDir}`,
      })
    }

    if (existsSync(config.unixSocketPath)) {
      const stat = lstatSync(config.unixSocketPath)
      if (stat.isSocket()) {
        checks.push({
          name: "unix_socket_path",
          ok: true,
          message: `existing socket path can be reused: ${config.unixSocketPath}`,
        })
      } else {
        checks.push({
          name: "unix_socket_path",
          ok: false,
          message: `socket path exists but is not a socket: ${config.unixSocketPath}`,
        })
      }
    } else {
      checks.push({
        name: "unix_socket_path",
        ok: true,
        message: `socket path is available: ${config.unixSocketPath}`,
      })
    }
  } else {
    if (config.tcpHost.trim().length === 0) {
      checks.push({
        name: "tcp_host",
        ok: false,
        message: "tcp host must not be empty",
      })
    } else {
      checks.push({
        name: "tcp_host",
        ok: true,
        message: `tcp host configured: ${config.tcpHost}`,
      })
    }

    checks.push({
      name: "tcp_port",
      ok: true,
      message: `tcp port configured: ${config.tcpPort}`,
    })
  }

  const report: PreflightReport = {
    ok: checks.every((check) => check.ok),
    checks,
  }

  return {
    config: {
      ...config,
      krunPath: resolvedKrunPath,
    },
    report,
  }
}

export function assertPreflight(config: DaemonConfig): {
  config: DaemonConfig
  report: PreflightReport
} {
  const result = runPreflight(config)
  if (result.report.ok) {
    return result
  }

  throw new ProtocolError("invalid_config", "startup preflight failed", result.report)
}
