import { describe, expect, it, mock } from "bun:test"
import { createKrunClient, KrunClient, KrunClientError, rpcErrorToMessage } from "./index"

type EventType = "open" | "message" | "error" | "close"
type Listener = (event: any) => void
type SocketState = WebSocket["CONNECTING"] | WebSocket["CLOSED"] | WebSocket["OPEN"]

class FakeWebSocket {
  readyState: SocketState = WebSocket.CONNECTING
  sent: string[] = []

  private listeners: Record<EventType, Set<Listener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }

  addEventListener(type: EventType, listener: Listener): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(type: EventType, listener: Listener): void {
    this.listeners[type].delete(listener)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(code = 1000, reason = "normal closure"): void {
    this.readyState = WebSocket.CLOSED
    this.emit("close", { code, reason, wasClean: true })
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit("open", {})
  }

  serverMessage(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload)
    this.emit("message", { data })
  }

  serverClose(code = 1006, reason = "abrupt close"): void {
    this.readyState = WebSocket.CLOSED
    this.emit("close", { code, reason, wasClean: false })
  }

  serverError(): void {
    this.emit("error", {})
  }

  private emit(type: EventType, event: any): void {
    for (const listener of this.listeners[type]) {
      listener(event)
    }
  }
}

async function waitForSocket(getter: () => FakeWebSocket | null): Promise<FakeWebSocket> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    const socket = getter()
    if (socket) return socket
    await Bun.sleep(1)
  }
  throw new Error("socket was not created in time")
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error("condition was not met in time")
}

function buildQueuedAck(id: string, opId: string) {
  return {
    id,
    ok: true,
    accepted: true,
    opId,
    state: "queued",
    queuedAt: new Date().toISOString(),
  }
}

function buildDone(id: string, opId: string) {
  return {
    event: "op.done",
    id,
    opId,
    kind: "list",
    state: "succeeded",
    ts: new Date().toISOString(),
    ok: true,
    result: {
      code: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    },
  }
}

function buildDoneForKind(id: string, opId: string, kind: string) {
  return {
    event: "op.done",
    id,
    opId,
    kind,
    state: "succeeded",
    ts: new Date().toISOString(),
    ok: true,
    result: {
      code: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    },
  }
}

describe("KrunClient unit", () => {
  it("normalizes ws+unix URL variants", async () => {
    let socket: FakeWebSocket | null = null
    const wsFactoryCalls: string[] = []
    const client = new KrunClient({
      url: "ws+unix:/usr/local/run/krunvmd.sock:/rpc",
      websocketFactory: (url) => {
        wsFactoryCalls.push(url)
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const connectPromise = client.connect()
    await waitFor(() => wsFactoryCalls.length === 1)
    expect(wsFactoryCalls[0]).toBe("ws+unix:///usr/local/run/krunvmd.sock:/rpc")
    ;(socket as FakeWebSocket).open()
    await connectPromise
  })

  it("falls back to node ws for ws+unix wrong-scheme errors", async () => {
    const calls: string[] = []
    const factory = mock((url: string) => {
      calls.push(url)
      if (calls.length === 1) {
        throw new Error("Wrong url scheme for WebSocket")
      }
      const socket = new FakeWebSocket()
      queueMicrotask(() => socket.open())
      return socket as unknown as WebSocket
    })

    const client = new KrunClient({
      url: "ws+unix:///usr/local/run/krunvmd.sock:/rpc",
      websocketFactory: factory as any,
    })
    await client.connect()

    expect(calls).toEqual([
      "ws+unix:///usr/local/run/krunvmd.sock:/rpc",
      "ws+unix:/usr/local/run/krunvmd.sock:/rpc",
    ])
  })

  it("requests and resolves with ack + op.done", async () => {
    let socket: FakeWebSocket | null = null
    const client = new KrunClient({
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const promise = client.list(true)
    const ws = await waitForSocket(() => socket)
    ws.open()
    await waitFor(() => ws.sent.length > 0)

    expect(ws.sent.length).toBe(1)
    const outbound = JSON.parse(ws.sent[0] ?? "{}")
    expect(outbound.kind).toBe("list")
    expect(outbound.payload.debug).toBe(true)

    const opId = crypto.randomUUID()
    ws.serverMessage(buildQueuedAck(outbound.id, opId))
    ws.serverMessage(buildDone(outbound.id, opId))

    const done = await promise
    expect(done.ok).toBe(true)
    expect(done.result?.stdout).toBe("ok")
  })

  it("rejects with protocol error details on ack error", async () => {
    let socket: FakeWebSocket | null = null
    const client = new KrunClient({
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const promise = client.list()
    const ws = await waitForSocket(() => socket)
    ws.open()
    await waitFor(() => ws.sent.length > 0)

    const outbound = JSON.parse(ws.sent[0] ?? "{}")
    ws.serverMessage({
      id: outbound.id,
      ok: false,
      error: {
        code: "forbidden",
        message: "denied",
      },
    })

    const error = await promise.catch((err) => err)
    expect(error).toBeInstanceOf(KrunClientError)
    expect(error).toMatchObject({ code: "protocol_error", message: "denied" })
  })

  it("rejects on ack timeout and cleans pending state", async () => {
    let socket: FakeWebSocket | null = null
    const client = new KrunClient({
      ackTimeoutMs: 10,
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const promise = client.list()
    const ws = await waitForSocket(() => socket)
    ws.open()
    await waitFor(() => ws.sent.length > 0)

    await expect(promise).rejects.toMatchObject({ code: "ack_timeout" })

    const pendingDoneById = (client as any).pendingDoneById as Map<string, unknown>
    const pendingAckById = (client as any).pendingAckById as Map<string, unknown>

    expect(pendingDoneById.size).toBe(0)
    expect(pendingAckById.size).toBe(0)
  })

  it("rejects connect when socket closes before open", async () => {
    let socket: FakeWebSocket | null = null
    const client = new KrunClient({
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const connecting = client.connect()
    const ws = await waitForSocket(() => socket)
    ws.serverClose(1006, "closed early")

    await expect(connecting).rejects.toMatchObject({ code: "connection_closed" })
  })

  it("rejects connect when websocket emits transport error before open", async () => {
    let socket: FakeWebSocket | null = null
    const client = new KrunClient({
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const connecting = client.connect()
    const ws = await waitForSocket(() => socket)
    ws.serverError()

    await expect(connecting).rejects.toMatchObject({ code: "transport_error" })
  })

  it("convenience methods emit expected request kind and payload", async () => {
    const cases: Array<{
      kind: string
      payload: unknown
      call: (client: KrunClient) => Promise<unknown>
    }> = [
      {
        kind: "get",
        payload: null,
        call: (client) => client.get(),
      },
      {
        kind: "create",
        payload: {
          image: "alpine:latest",
          name: "vm-test",
          workdir: "/tmp",
          cpus: 1,
          dns: "1.1.1.1",
          volumes: [],
          ports: [],
          memoryMiB: 512,
        },
        call: (client) =>
          client.create({
            image: "alpine:latest",
            name: "vm-test",
            workdir: "/tmp",
            cpus: 1,
            dns: "1.1.1.1",
            volumes: [],
            ports: [],
            memoryMiB: 512,
          }),
      },
      {
        kind: "delete",
        payload: { name: "vm-test" },
        call: (client) => client.delete({ name: "vm-test" }),
      },
      {
        kind: "boot",
        payload: {
          name: "vm-test",
          command: "sandbox-agent",
          args: ["server", "--no-token"],
          env: [],
          cpus: 1,
          memoryMiB: 512,
        },
        call: (client) =>
          client.boot({
            name: "vm-test",
            command: "sandbox-agent",
            args: ["server", "--no-token"],
            env: [],
            cpus: 1,
            memoryMiB: 512,
          }),
      },
      {
        kind: "start",
        payload: {
          name: "vm-test",
          cpus: 1,
          memoryMiB: 512,
          args: [],
          env: [],
        },
        call: (client) =>
          client.start({
            name: "vm-test",
            cpus: 1,
            memoryMiB: 512,
            args: [],
            env: [],
          }),
      },
      {
        kind: "inspect",
        payload: { name: "vm-test" },
        call: (client) => client.inspect({ name: "vm-test" }),
      },
      {
        kind: "changevm",
        payload: { name: "vm-test" },
        call: (client) => client.changevm({ name: "vm-test" }),
      },
      {
        kind: "list",
        payload: { debug: true },
        call: (client) => client.list(true),
      },
    ]

    for (const testCase of cases) {
      let socket: FakeWebSocket | null = null
      const client = new KrunClient({
        websocketFactory: () => {
          socket = new FakeWebSocket()
          return socket as unknown as WebSocket
        },
      })

      const promise = testCase.call(client)
      const ws = await waitForSocket(() => socket)
      ws.open()
      await waitFor(() => ws.sent.length > 0)

      const outbound = JSON.parse(ws.sent[0] ?? "{}")
      expect(outbound.kind).toBe(testCase.kind)
      expect(outbound.payload).toEqual(testCase.payload)

      const opId = crypto.randomUUID()
      ws.serverMessage(buildQueuedAck(outbound.id, opId))
      ws.serverMessage(buildDoneForKind(outbound.id, opId, testCase.kind))

      const done = await promise
      expect(done).toBeTruthy()
      client.close()
    }
  })

  it("factory and error message helper work as expected", () => {
    let socket: FakeWebSocket | null = null
    const client = createKrunClient({
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    expect(client).toBeInstanceOf(KrunClient)
    expect(rpcErrorToMessage(new Error("boom"))).toBe("boom")
    expect(rpcErrorToMessage("unknown")).toBe("unknown rpc error")
  })

  it("emits op.update events to registered listeners", async () => {
    let socket: FakeWebSocket | null = null
    const client = new KrunClient({
      websocketFactory: () => {
        socket = new FakeWebSocket()
        return socket as unknown as WebSocket
      },
    })

    const updates: string[] = []
    const unsubscribe = client.onUpdate((update) => {
      updates.push(update.state)
    })

    const promise = client.list()
    const ws = await waitForSocket(() => socket)
    ws.open()
    await waitFor(() => ws.sent.length > 0)

    const outbound = JSON.parse(ws.sent[0] ?? "{}")
    const opId = crypto.randomUUID()
    ws.serverMessage(buildQueuedAck(outbound.id, opId))
    ws.serverMessage({
      event: "op.update",
      id: outbound.id,
      opId,
      kind: "list",
      state: "running",
      ts: new Date().toISOString(),
    })
    ws.serverMessage(buildDone(outbound.id, opId))

    await promise
    unsubscribe()

    expect(updates).toEqual(["running"])
  })
})

describe("KrunClient integration", () => {
  it("round-trips list request with a real websocket server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname !== "/rpc") {
          return new Response("Not Found", { status: 404 })
        }

        const upgraded = srv.upgrade(req)
        if (upgraded) return
        return new Response("Upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          const request = JSON.parse(
            typeof message === "string" ? message : message.toString("utf8"),
          )
          if (request.kind !== "list") return

          const opId = crypto.randomUUID()
          ws.send(JSON.stringify(buildQueuedAck(request.id, opId)))
          ws.send(
            JSON.stringify({
              event: "op.done",
              id: request.id,
              opId,
              kind: "list",
              state: "succeeded",
              ts: new Date().toISOString(),
              ok: true,
              result: {
                code: 0,
                stdout: "from-server",
                stderr: "",
                durationMs: 2,
              },
            }),
          )
        },
      },
    })

    try {
      const client = new KrunClient({ url: `ws://127.0.0.1:${server.port}/rpc` })
      const done = await client.list()
      client.close()

      expect(done.ok).toBe(true)
      expect(done.result?.stdout).toBe("from-server")
    } finally {
      server.stop(true)
    }
  })

  it("round-trips cancel acknowledgement with real websocket server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname !== "/rpc") {
          return new Response("Not Found", { status: 404 })
        }

        const upgraded = srv.upgrade(req)
        if (upgraded) return
        return new Response("Upgrade failed", { status: 400 })
      },
      websocket: {
        message(ws, message) {
          const request = JSON.parse(
            typeof message === "string" ? message : message.toString("utf8"),
          )
          if (request.kind !== "cancel") return

          ws.send(
            JSON.stringify({
              id: request.id,
              ok: true,
              cancelled: true,
              opId: request.payload.opId,
            }),
          )
        },
      },
    })

    try {
      const client = new KrunClient({ url: `ws://127.0.0.1:${server.port}/rpc` })
      const opId = crypto.randomUUID()
      const cancelled = await client.cancel(opId)
      client.close()

      expect(cancelled.cancelled).toBe(true)
      expect(cancelled.opId).toBe(opId)
    } finally {
      server.stop(true)
    }
  })
})
