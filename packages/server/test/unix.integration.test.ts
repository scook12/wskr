import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createKrunClient } from "@wskr/client"
import { loadConfig } from "../src/config"
import { startServer } from "../src/lifecycle"
import { createServer } from "../src/server"
import { cleanupDir, createShimBinary, getFreePort, makeTempDir } from "./helpers"

const useReal = Bun.env.WSKR_USE_REAL_KRUNVM === "1"

describe("server unix transport", () => {
  test("starts unix transport and cleans up socket path on stop", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-unix-transport-")
    const socketPath = join(dir, "run", "server.sock")
    const shimPath = createShimBinary(dir)

    const started = startServer({
      config: {
        transport: "unix",
        unixSocketPath: socketPath,
        tcpHost: "127.0.0.1",
        tcpPort: await getFreePort(),
        krunPath: shimPath,
        defaultTimeoutMs: 1000,
        maxConcurrentOps: 1,
        maxPayloadLength: 128 * 1024,
        idleTimeoutSec: 30,
        closeOnBackpressureLimit: true,
        allowedWorkdirs: [dir],
        maxOutputBytes: 128 * 1024,
        finishedOpTtlMs: 1000,
      },
    })

    try {
      expect(started.runtime.endpoint).toBe(`unix:${socketPath}`)
      const stat = await Bun.file(socketPath).stat()
      expect(stat.mode & 0o777).toBe(0o660)
    } finally {
      await started.runtime.stop()
      const existsAfterStop = await Bun.file(socketPath).exists()
      expect(existsAfterStop).toBe(false)
      cleanupDir(dir)
    }
  })

  test("startup fails when stale socket path is a non-socket file", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-unix-stale-file-")
    const socketPath = join(dir, "run", "server.sock")
    const shimPath = createShimBinary(dir)
    mkdirSync(join(dir, "run"), { recursive: true })
    await Bun.write(socketPath, "bad-stale-file")

    try {
      expect(() =>
        startServer({
          config: {
            transport: "unix",
            unixSocketPath: socketPath,
            tcpHost: "127.0.0.1",
            tcpPort: 0,
            krunPath: shimPath,
            defaultTimeoutMs: 1000,
            maxConcurrentOps: 1,
            maxPayloadLength: 128 * 1024,
            idleTimeoutSec: 30,
            closeOnBackpressureLimit: true,
            allowedWorkdirs: [dir],
            maxOutputBytes: 128 * 1024,
            finishedOpTtlMs: 1000,
          },
        }),
      ).toThrow("startup preflight failed")
    } finally {
      cleanupDir(dir)
    }
  })

  test("createServer rejects stale unix path when bypassing lifecycle preflight", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-unix-bypass-preflight-")
    const socketPath = join(dir, "run", "server.sock")
    const shimPath = createShimBinary(dir)
    mkdirSync(join(dir, "run"), { recursive: true })
    await Bun.write(socketPath, "bad-stale-file")

    try {
      const config = loadConfig({
        KRUN_SERVER_TRANSPORT: "unix",
        KRUN_SOCKET_PATH: socketPath,
        KRUN_BINARY_PATH: shimPath,
        KRUN_ALLOWED_WORKDIRS: dir,
      })
      expect(() => createServer(config)).toThrow("refusing to remove non-socket path")
    } finally {
      cleanupDir(dir)
    }
  })

  test("client default TCP endpoint works in tcp mode", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-default-client-endpoint-")
    const shimPath = createShimBinary(dir)

    const port = await getFreePort()
    const started = startServer({
      config: {
        transport: "tcp",
        unixSocketPath: `${dir}/unused.sock`,
        tcpHost: "127.0.0.1",
        tcpPort: port,
        krunPath: shimPath,
        defaultTimeoutMs: 1000,
        maxConcurrentOps: 1,
        maxPayloadLength: 128 * 1024,
        idleTimeoutSec: 30,
        closeOnBackpressureLimit: true,
        allowedWorkdirs: [dir],
        maxOutputBytes: 128 * 1024,
        finishedOpTtlMs: 1000,
      },
    })

    const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc` })
    try {
      const done = await client.list(true)
      expect(done.ok).toBe(true)
      expect(done.result?.stdout).toContain("debug-vm")
    } finally {
      client.close()
      await started.runtime.stop()
      cleanupDir(dir)
    }
  })
})
