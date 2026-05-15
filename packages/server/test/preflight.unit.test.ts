import { chmodSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { DaemonConfig } from "../src/config"
import { assertPreflight, runPreflight } from "../src/preflight"
import { ProtocolError } from "../src/errors"
import { cleanupDir, createShimBinary, makeTempDir } from "./helpers"

function makeConfig(overrides: Partial<DaemonConfig>): DaemonConfig {
  return {
    transport: "unix",
    unixSocketPath: "/tmp/wskr.sock",
    tcpHost: "127.0.0.1",
    tcpPort: 8877,
    krunPath: "/usr/local/bin/krunvm",
    defaultTimeoutMs: 60_000,
    maxConcurrentOps: 4,
    maxPayloadLength: 256 * 1024,
    idleTimeoutSec: 120,
    closeOnBackpressureLimit: true,
    allowedWorkdirs: ["/tmp"],
    maxOutputBytes: 1024 * 1024,
    finishedOpTtlMs: 5000,
    ...overrides,
  }
}

describe("preflight", () => {
  test("passes with executable shim", () => {
    const dir = makeTempDir("wskr-preflight-ok-")
    try {
      const shim = createShimBinary(dir)
      const socketPath = join(dir, "sock", "server.sock")
      const result = runPreflight(
        makeConfig({
          transport: "unix",
          krunPath: shim,
          unixSocketPath: socketPath,
        }),
      )
      expect(result.report.ok).toBe(true)
      expect(result.report.checks.length).toBeGreaterThan(0)
    } finally {
      cleanupDir(dir)
    }
  })

  test("fails when shim is not executable", () => {
    const dir = makeTempDir("wskr-preflight-noexec-")
    try {
      const shim = createShimBinary(dir)
      chmodSync(shim, 0o644)
      expect(() =>
        assertPreflight(
          makeConfig({
            krunPath: shim,
            unixSocketPath: join(dir, "sock", "server.sock"),
          }),
        ),
      ).toThrow(ProtocolError)
    } finally {
      cleanupDir(dir)
    }
  })

  test("passes tcp mode", () => {
    const dir = makeTempDir("wskr-preflight-tcp-")
    try {
      const shim = createShimBinary(dir)
      const result = runPreflight(
        makeConfig({
          transport: "tcp",
          krunPath: shim,
          tcpHost: "127.0.0.1",
          tcpPort: 9933,
        }),
      )
      expect(result.report.ok).toBe(true)
    } finally {
      cleanupDir(dir)
    }
  })
})
