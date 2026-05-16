import { describe, expect, test } from "bun:test"
import { createKrunClient } from "@wskr/client"
import { loadConfig } from "../src/config"
import { startServer } from "../src/lifecycle"

function getRequiredEnv(name: string): string {
  const value = Bun.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for real integration tests`)
  }
  return value
}

describe("server integration (real krunvm)", () => {
  test("list roundtrip with real runtime", async () => {
    if (Bun.env.WSKR_USE_REAL_KRUNVM !== "1") {
      throw new Error("set WSKR_USE_REAL_KRUNVM=1 to run real integration tests")
    }

    const transport = Bun.env.KRUN_SERVER_TRANSPORT ?? "tcp"
    if (transport !== "tcp") {
      throw new Error("real integration test requires KRUN_SERVER_TRANSPORT=tcp")
    }

    const host = Bun.env.KRUN_TCP_HOST ?? "127.0.0.1"
    const port = Number.parseInt(getRequiredEnv("KRUN_TCP_PORT"), 10)
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error("KRUN_TCP_PORT must be a positive integer for real integration tests")
    }

    const config = loadConfig(Bun.env)
    const started = startServer({ config })
    const client = createKrunClient({ url: `ws://${host}:${port}/rpc`, ackTimeoutMs: 4000 })

    try {
      const done = await client.list(false)
      expect(done.ok).toBe(true)
      expect(done.state).toBe("succeeded")
    } finally {
      client.close()
      await started.runtime.stop()
    }
  })
})
