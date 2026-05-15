import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
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

  test("fails when krun binary cannot be resolved from PATH", () => {
    const dir = makeTempDir("wskr-preflight-missing-binary-")
    try {
      const result = runPreflight(
        makeConfig({
          krunPath: "definitely-not-a-real-krunvm-binary",
          unixSocketPath: join(dir, "sock", "server.sock"),
        }),
      )

      expect(result.report.ok).toBe(false)
      const krunCheck = result.report.checks.find((check) => check.name === "krun_binary")
      expect(krunCheck?.ok).toBe(false)
      expect(krunCheck?.message).toContain("not found")
    } finally {
      cleanupDir(dir)
    }
  })

  test("fails when krun path is not a regular file", () => {
    const dir = makeTempDir("wskr-preflight-not-file-")
    try {
      const nonFilePath = join(dir, "krunvm-dir")
      mkdirSync(nonFilePath, { recursive: true })
      const result = runPreflight(
        makeConfig({
          krunPath: nonFilePath,
          unixSocketPath: join(dir, "sock", "server.sock"),
        }),
      )

      expect(result.report.ok).toBe(false)
      const krunCheck = result.report.checks.find((check) => check.name === "krun_binary")
      expect(krunCheck?.ok).toBe(false)
      expect(krunCheck?.message).toContain("not a file")
    } finally {
      cleanupDir(dir)
    }
  })

  test("fails when unix socket path exists as non-socket file", () => {
    const dir = makeTempDir("wskr-preflight-bad-socket-path-")
    try {
      const shim = createShimBinary(dir)
      const socketPath = join(dir, "sock", "server.sock")
      mkdirSync(join(dir, "sock"), { recursive: true })
      writeFileSync(socketPath, "not-a-socket")

      const result = runPreflight(
        makeConfig({
          transport: "unix",
          krunPath: shim,
          unixSocketPath: socketPath,
        }),
      )

      expect(result.report.ok).toBe(false)
      const socketCheck = result.report.checks.find((check) => check.name === "unix_socket_path")
      expect(socketCheck?.ok).toBe(false)
      expect(socketCheck?.message).toContain("not a socket")
    } finally {
      cleanupDir(dir)
    }
  })

  test("fails tcp mode when host is empty", () => {
    const dir = makeTempDir("wskr-preflight-empty-tcp-host-")
    try {
      const shim = createShimBinary(dir)
      const result = runPreflight(
        makeConfig({
          transport: "tcp",
          krunPath: shim,
          tcpHost: "   ",
          tcpPort: 9999,
        }),
      )

      expect(result.report.ok).toBe(false)
      const hostCheck = result.report.checks.find((check) => check.name === "tcp_host")
      expect(hostCheck?.ok).toBe(false)
      expect(hostCheck?.message).toContain("must not be empty")
    } finally {
      cleanupDir(dir)
    }
  })

  test("fails when resolved absolute krun path does not exist", () => {
    const dir = makeTempDir("wskr-preflight-missing-abs-")
    try {
      const result = runPreflight(
        makeConfig({
          krunPath: join(dir, "missing-krunvm"),
          unixSocketPath: join(dir, "sock", "server.sock"),
        }),
      )

      expect(result.report.ok).toBe(false)
      const krunCheck = result.report.checks.find((check) => check.name === "krun_binary")
      expect(krunCheck?.ok).toBe(false)
      expect(krunCheck?.message).toContain("does not exist")
    } finally {
      cleanupDir(dir)
    }
  })

  test("accepts unix socket path when pre-existing entry is an actual socket", () => {
    const dir = makeTempDir("wskr-preflight-existing-socket-")
    try {
      const shim = createShimBinary(dir)
      const socketPath = join(dir, "sock", "server.sock")
      mkdirSync(join(dir, "sock"), { recursive: true })

      const runtime = Bun.listen({
        unix: socketPath,
        socket: {
          open() {},
          data() {},
          close() {},
        },
      })

      try {
        const result = runPreflight(
          makeConfig({
            transport: "unix",
            krunPath: shim,
            unixSocketPath: socketPath,
          }),
        )

        expect(result.report.ok).toBe(true)
        const socketCheck = result.report.checks.find((check) => check.name === "unix_socket_path")
        expect(socketCheck?.ok).toBe(true)
        expect(socketCheck?.message).toContain("can be reused")
      } finally {
        runtime.stop(true)
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("fails unix socket parent access check when parent is non-directory", () => {
    const dir = makeTempDir("wskr-preflight-parent-nondir-")
    try {
      const shim = createShimBinary(dir)
      const badParent = join(dir, "parent-file")
      writeFileSync(badParent, "not-a-dir")

      const result = runPreflight(
        makeConfig({
          transport: "unix",
          krunPath: shim,
          unixSocketPath: join(badParent, "server.sock"),
        }),
      )

      expect(result.report.ok).toBe(false)
      const parentCheck = result.report.checks.find((check) => check.name === "unix_socket_parent")
      expect(parentCheck?.ok).toBe(false)
      expect(parentCheck?.message).toContain("not writable")
    } finally {
      cleanupDir(dir)
    }
  })

  test("passes when krun path is symlink to executable", () => {
    const dir = makeTempDir("wskr-preflight-symlink-")
    try {
      const shim = createShimBinary(dir)
      const symlinkPath = join(dir, "krunvm-link")
      symlinkSync(shim, symlinkPath)

      const result = runPreflight(
        makeConfig({
          krunPath: symlinkPath,
          unixSocketPath: join(dir, "sock", "server.sock"),
        }),
      )

      expect(result.report.ok).toBe(true)
      const krunCheck = result.report.checks.find((check) => check.name === "krun_binary")
      expect(krunCheck?.ok).toBe(true)
      expect(krunCheck?.message).toContain("is executable")
    } finally {
      cleanupDir(dir)
    }
  })
})
