import { describe, expect, test } from "bun:test"
import { createKrunClient } from "@wskr/client"
import { startServer } from "../src/lifecycle"
import { cleanupDir, createShimBinary, getFreePort, makeTempDir } from "./helpers"

const useReal = Bun.env.WSKR_USE_REAL_KRUNVM === "1"

describe("server integration (shim default)", () => {
  test("list request roundtrip", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-")
    const previousDelay = Bun.env.WSKR_SHIM_DELAY_MS
    const previousFail = Bun.env.WSKR_SHIM_FAIL_COMMAND

    try {
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
          maxConcurrentOps: 2,
          maxPayloadLength: 128 * 1024,
          idleTimeoutSec: 30,
          closeOnBackpressureLimit: true,
          allowedWorkdirs: [dir],
          maxOutputBytes: 128 * 1024,
          finishedOpTtlMs: 1000,
        },
      })

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })
      try {
        const done = await client.list(true)
        expect(done.ok).toBe(true)
        expect(done.state).toBe("succeeded")
        expect(done.result?.stdout).toContain("debug-vm")
      } finally {
        client.close()
        await started.runtime.stop()
      }
    } finally {
      Bun.env.WSKR_SHIM_DELAY_MS = previousDelay
      Bun.env.WSKR_SHIM_FAIL_COMMAND = previousFail
      cleanupDir(dir)
    }
  })

  test("cancel running operation", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-cancel-")
    const previousDelay = Bun.env.WSKR_SHIM_DELAY_MS
    const previousFail = Bun.env.WSKR_SHIM_FAIL_COMMAND

    try {
      Bun.env.WSKR_SHIM_DELAY_MS = "500"
      Bun.env.WSKR_SHIM_FAIL_COMMAND = ""

      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: {
          transport: "tcp",
          unixSocketPath: `${dir}/unused.sock`,
          tcpHost: "127.0.0.1",
          tcpPort: port,
          krunPath: shimPath,
          defaultTimeoutMs: 2000,
          maxConcurrentOps: 1,
          maxPayloadLength: 128 * 1024,
          idleTimeoutSec: 30,
          closeOnBackpressureLimit: true,
          allowedWorkdirs: [dir],
          maxOutputBytes: 128 * 1024,
          finishedOpTtlMs: 1000,
        },
      })

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })
      try {
        const pending = await client.enqueue("list", { debug: false })
        const ack = await client.cancel(pending.opId)
        expect(ack.cancelled).toBe(true)

        const done = await pending.wait
        expect(done.ok).toBe(false)
        expect(done.state).toBe("cancelled")
        expect(done.error?.code).toBe("cancelled")
      } finally {
        client.close()
        await started.runtime.stop()
      }
    } finally {
      Bun.env.WSKR_SHIM_DELAY_MS = previousDelay
      Bun.env.WSKR_SHIM_FAIL_COMMAND = previousFail
      cleanupDir(dir)
    }
  })
})
