#!/usr/bin/env bun

import { ProtocolError } from "./errors"
import { log } from "./logging"
import { startServer } from "./lifecycle"

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof ProtocolError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message,
    }
  }

  return {
    code: "internal_error",
    message: String(error),
  }
}

try {
  const { config, report, runtime } = startServer()

  log("info", "preflight_passed", {
    transport: config.transport,
    endpoint: runtime.endpoint,
    checks: report.checks,
  })
} catch (error) {
  log("error", "startup_failed", formatError(error))
  process.exit(1)
}
