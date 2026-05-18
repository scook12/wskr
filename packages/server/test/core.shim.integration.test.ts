import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createKrunClient } from "@wskr/client"
import type { DaemonConfig } from "../src/config"
import { startServer } from "../src/lifecycle"
import { createServer } from "../src/server"
import { cleanupDir, createShimBinary, getFreePort, makeTempDir } from "./helpers"

const useReal = Bun.env.WSKR_USE_REAL_KRUNVM === "1"

function buildConfig(
  dir: string,
  port: number,
  krunPath: string,
  overrides: Partial<DaemonConfig> = {},
): DaemonConfig {
  return {
    transport: "tcp",
    unixSocketPath: `${dir}/unused.sock`,
    tcpHost: "127.0.0.1",
    tcpPort: port,
    krunPath,
    defaultTimeoutMs: 1000,
    maxConcurrentOps: 2,
    maxPayloadLength: 128 * 1024,
    idleTimeoutSec: 30,
    closeOnBackpressureLimit: true,
    maxOutputBytes: 128 * 1024,
    finishedOpTtlMs: 1000,
    ...overrides,
  }
}

async function openRawWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket open timeout")), 1500)
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timeout)
        reject(new Error("websocket open failed"))
      },
      { once: true },
    )
  })
  return ws
}

async function nextMessage(ws: WebSocket): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("message timeout")), 1500)
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout)
        const text = typeof event.data === "string" ? event.data : String(event.data)
        resolve(JSON.parse(text))
      },
      { once: true },
    )
  })
}

async function waitForDone(
  ws: WebSocket,
  opId: string,
): Promise<{
  event: "op.done"
  opId: string
  state: string
  ok: boolean
  error?: { code: string; message: string }
}> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 3000) {
    const message = (await nextMessage(ws)) as { event?: string; opId?: string }
    if (message.event === "op.done" && message.opId === opId) {
      return message as {
        event: "op.done"
        opId: string
        state: string
        ok: boolean
        error?: { code: string; message: string }
      }
    }
  }

  throw new Error("timed out waiting for op.done")
}

async function waitForAccepted(
  ws: WebSocket,
  id: string,
): Promise<{
  id: string
  ok: true
  accepted: true
  opId: string
}> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 3000) {
    const message = (await nextMessage(ws)) as {
      id?: string
      ok?: boolean
      accepted?: boolean
      opId?: string
    }
    if (message.id === id && message.ok === true && message.accepted === true && message.opId) {
      return message as {
        id: string
        ok: true
        accepted: true
        opId: string
      }
    }
  }

  throw new Error(`timed out waiting for accepted ack for ${id}`)
}

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
        config: buildConfig(dir, port, shimPath),
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
        config: buildConfig(dir, port, shimPath, {
          defaultTimeoutMs: 2000,
          maxConcurrentOps: 1,
        }),
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

  test("returns protocol errors for invalid json and unknown kind", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-protocol-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      const ws = await openRawWebSocket(`ws://127.0.0.1:${port}/rpc`)
      try {
        ws.send("{ bad-json")
        const invalidJson = (await nextMessage(ws)) as {
          ok: boolean
          id: string | null
          error: { code: string }
        }
        expect(invalidJson.ok).toBe(false)
        expect(invalidJson.id).toBeNull()
        expect(invalidJson.error.code).toBe("invalid_json")

        ws.send(JSON.stringify({ id: "u1", kind: "launch", payload: {} }))
        const unknownKind = (await nextMessage(ws)) as {
          ok: boolean
          id: string | null
          error: { code: string }
        }
        expect(unknownKind.ok).toBe(false)
        expect(unknownKind.id).toBeNull()
        expect(unknownKind.error.code).toBe("unknown_kind")
      } finally {
        ws.close(1000, "done")
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("create passes krunvm-compatible --volume host:guest args", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-create-volumes-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      const ws = await openRawWebSocket(`ws://127.0.0.1:${port}/rpc`)
      try {
        const id = crypto.randomUUID()
        ws.send(
          JSON.stringify({
            id,
            kind: "create",
            payload: {
              image: "alpine:3.20",
              name: "vm-create-volume-test",
              workdir: "/workspace",
              cpus: 1,
              memoryMiB: 512,
              dns: "1.1.1.1",
              volumes: ["/tmp:/workspace", "/var/tmp:/cache"],
              ports: [],
            },
          }),
        )

        const accepted = await waitForAccepted(ws, id)
        expect(accepted.id).toBe(id)

        let createInvocation: { command?: string; args?: string[] } | null = null
        const startedAt = Date.now()
        while (Date.now() - startedAt < 3000) {
          const message = (await nextMessage(ws)) as {
            event?: string
            id?: string
            opId?: string
            ok?: boolean
            result?: { stdout?: string }
          }
          if (message.event === "op.done" && message.id === id && message.opId === accepted.opId) {
            expect(message.ok).toBe(true)
            const stdout = message.result?.stdout ?? ""
            createInvocation = JSON.parse(stdout) as { command?: string; args?: string[] }
            break
          }
        }

        expect(createInvocation).not.toBeNull()
        expect(createInvocation?.command).toBe("create")
        const args = createInvocation?.args ?? []
        const volumeFlags: string[] = []
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === "--volume" && args[i + 1]) {
            volumeFlags.push(args[i + 1])
          }
        }
        expect(volumeFlags).toEqual(["/tmp:/workspace", "/var/tmp:/cache"])
        expect(volumeFlags.some((value) => value.endsWith(":ro") || value.endsWith(":rw"))).toBe(
          false,
        )
      } finally {
        ws.close(1000, "done")
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("boot request maps to detached start invocation", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-boot-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      const ws = await openRawWebSocket(`ws://127.0.0.1:${port}/rpc`)
      try {
        const id = crypto.randomUUID()
        ws.send(
          JSON.stringify({
            id,
            kind: "boot",
            payload: {
              name: "vm-boot-test",
              command: "sandbox-agent",
              args: ["server", "--host", "0.0.0.0", "--port", "3000", "--no-token"],
              env: ["FOO=bar"],
              cpus: 1,
              memoryMiB: 512,
            },
          }),
        )

        const accepted = await waitForAccepted(ws, id)
        expect(accepted.id).toBe(id)

        let invocation: { command?: string; args?: string[] } | null = null
        const startedAt = Date.now()
        while (Date.now() - startedAt < 3000) {
          const message = (await nextMessage(ws)) as {
            event?: string
            id?: string
            opId?: string
            ok?: boolean
            result?: { stdout?: string }
          }
          if (message.event === "op.done" && message.id === id && message.opId === accepted.opId) {
            expect(message.ok).toBe(true)
            invocation = { command: "start", args: [] }
            break
          }
        }

        expect(invocation).not.toBeNull()
        expect(invocation?.command).toBe("start")
      } finally {
        ws.close(1000, "done")
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("rejects create with nested guest volume path", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-create-invalid-guest-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      const ws = await openRawWebSocket(`ws://127.0.0.1:${port}/rpc`)
      try {
        const id = crypto.randomUUID()
        ws.send(
          JSON.stringify({
            id,
            kind: "create",
            payload: {
              image: "alpine:3.20",
              name: "vm-invalid-guest-path",
              workdir: "/workspace",
              cpus: 1,
              memoryMiB: 512,
              dns: "1.1.1.1",
              volumes: ["/tmp:/workspace/subdir"],
              ports: [],
            },
          }),
        )

        const failed = (await nextMessage(ws)) as {
          id: string | null
          ok: boolean
          error: { code: string; message: string }
        }
        expect(failed.id).toBeNull()
        expect(failed.ok).toBe(false)
        expect(failed.error.code).toBe("invalid_message")
      } finally {
        ws.close(1000, "done")
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("rejects cancel for unknown op id", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-cancel-not-found-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })
      try {
        await expect(client.cancel(crypto.randomUUID())).rejects.toMatchObject({
          code: "protocol_error",
          message: "operation not found",
        })
      } finally {
        client.close()
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("rejects cross-client cancellation", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-cancel-forbidden-")
    const previousDelay = Bun.env.WSKR_SHIM_DELAY_MS

    try {
      Bun.env.WSKR_SHIM_DELAY_MS = "500"
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath, {
          defaultTimeoutMs: 2000,
          maxConcurrentOps: 1,
        }),
      })

      const wsA = await openRawWebSocket(`ws://127.0.0.1:${port}/rpc`)
      const wsB = await openRawWebSocket(`ws://127.0.0.1:${port}/rpc`)

      try {
        const listId = crypto.randomUUID()
        wsA.send(JSON.stringify({ id: listId, kind: "list", payload: { debug: false } }))
        const ackA = await waitForAccepted(wsA, listId)
        expect(ackA.id).toBe(listId)
        expect(ackA.ok).toBe(true)
        expect(ackA.accepted).toBe(true)

        const cancelIdB = crypto.randomUUID()
        wsB.send(JSON.stringify({ id: cancelIdB, kind: "cancel", payload: { opId: ackA.opId } }))
        const forbidden = (await nextMessage(wsB)) as {
          id: string
          ok: boolean
          error: { code: string; message: string }
        }
        expect(forbidden.id).toBe(cancelIdB)
        expect(forbidden.ok).toBe(false)
        expect(forbidden.error.code).toBe("forbidden")
        expect(forbidden.error.message).toBe("cannot cancel another client's operation")

        const cancelIdA = crypto.randomUUID()
        wsA.send(JSON.stringify({ id: cancelIdA, kind: "cancel", payload: { opId: ackA.opId } }))
        const cancelledAck = (await nextMessage(wsA)) as {
          id: string
          ok: boolean
          cancelled: true
          opId: string
        }
        expect(cancelledAck.id).toBe(cancelIdA)
        expect(cancelledAck.ok).toBe(true)
        expect(cancelledAck.cancelled).toBe(true)

        const done = await waitForDone(wsA, ackA.opId)
        expect(done.state).toBe("cancelled")
        expect(done.error?.code).toBe("cancelled")
      } finally {
        wsA.close(1000, "done")
        wsB.close(1000, "done")
        await started.runtime.stop()
      }
    } finally {
      Bun.env.WSKR_SHIM_DELAY_MS = previousDelay
      cleanupDir(dir)
    }
  })

  test("cancels queued operation before execution", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-queued-cancel-")
    const previousDelay = Bun.env.WSKR_SHIM_DELAY_MS

    try {
      Bun.env.WSKR_SHIM_DELAY_MS = "700"
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath, {
          defaultTimeoutMs: 2000,
          maxConcurrentOps: 1,
        }),
      })

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })
      let firstWait: Promise<unknown> | null = null
      let secondWait: Promise<unknown> | null = null

      try {
        const first = await client.enqueue("list", { debug: false })
        const second = await client.enqueue("list", { debug: false })
        firstWait = first.wait
        secondWait = second.wait
        const ack = await client.cancel(second.opId)
        expect(ack.cancelled).toBe(true)

        const doneSecond = await second.wait
        expect(doneSecond.state).toBe("cancelled")
        expect(doneSecond.error?.message).toBe("operation cancelled before execution")

        const ackFirst = await client.cancel(first.opId)
        expect(ackFirst.cancelled).toBe(true)
        const doneFirst = await first.wait
        expect(doneFirst.state).toBe("cancelled")
      } finally {
        if (firstWait) {
          await firstWait.catch(() => undefined)
        }
        if (secondWait) {
          await secondWait.catch(() => undefined)
        }
        client.close()
        await started.runtime.stop()
      }
    } finally {
      Bun.env.WSKR_SHIM_DELAY_MS = previousDelay
      cleanupDir(dir)
    }
  })

  test("marks operations as timed_out when command exceeds timeout", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-timeout-")
    const previousDelay = Bun.env.WSKR_SHIM_DELAY_MS

    try {
      Bun.env.WSKR_SHIM_DELAY_MS = "350"
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath, {
          defaultTimeoutMs: 40,
        }),
      })

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })

      try {
        const done = await client.list(false)
        expect(done.ok).toBe(false)
        expect(done.state).toBe("timed_out")
        expect(done.error?.code).toBe("timeout")
      } finally {
        client.close()
        await started.runtime.stop()
      }
    } finally {
      Bun.env.WSKR_SHIM_DELAY_MS = previousDelay
      cleanupDir(dir)
    }
  })

  test("returns executor_error when command cannot be spawned", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-spawn-fail-")
    try {
      const port = await getFreePort()
      const runtime = createServer(
        buildConfig(dir, port, join(dir, "missing-krunvm-binary"), {
          defaultTimeoutMs: 100,
        }),
      )

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })

      try {
        const done = await client.list(false)
        expect(done.ok).toBe(false)
        expect(done.state).toBe("failed")
        expect(done.error?.code).toBe("executor_error")
        expect(done.error?.message).toBe("failed to spawn command")
      } finally {
        client.close()
        await runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("returns 404 for non-rpc routes", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-http-404-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      try {
        const res = await fetch(`http://127.0.0.1:${port}/nope`)
        expect(res.status).toBe(404)
      } finally {
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("returns executor_error details when command exits non-zero", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-exit-nonzero-")
    try {
      const port = await getFreePort()
      const runtime = createServer(
        buildConfig(dir, port, join(dir, "unused-krun-binary")),
        async ({ command }) => {
          return {
            argv: ["/fake/krunvm", command],
            code: 7,
            stdout: "",
            stderr: "forced failure",
            durationMs: 1,
          }
        },
      )

      const client = createKrunClient({ url: `ws://127.0.0.1:${port}/rpc`, ackTimeoutMs: 2000 })

      try {
        const done = await client.list(false)
        expect(done.ok).toBe(false)
        expect(done.state).toBe("failed")
        expect(done.error?.code).toBe("executor_error")
        expect(done.error?.message).toBe("krunvm list failed")
        const details = done.error?.details as { code?: number; stderr?: string }
        expect(details.code).toBe(7)
        expect(details.stderr).toContain("forced failure")
      } finally {
        client.close()
        await runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })

  test("returns 400 when /rpc request is not websocket upgrade", async () => {
    if (useReal) {
      return
    }

    const dir = makeTempDir("wskr-integration-upgrade-fail-")
    try {
      const shimPath = createShimBinary(dir)
      const port = await getFreePort()
      const started = startServer({
        config: buildConfig(dir, port, shimPath),
      })

      try {
        const res = await fetch(`http://127.0.0.1:${port}/rpc`)
        expect(res.status).toBe(400)
      } finally {
        await started.runtime.stop()
      }
    } finally {
      cleanupDir(dir)
    }
  })
})
