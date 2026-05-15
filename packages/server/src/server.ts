import type { ServerWebSocket, WebSocketHandler } from "bun"
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import type {
  AckCancelled,
  ExecutableRequest,
  JobState,
  KrunCommand,
  OpDone,
  OpUpdate,
  RequestAccepted,
  RpcRequest,
} from "@wskr/types"
import { argsForRequest } from "./args"
import type { DaemonConfig } from "./config"
import { ProtocolError, toRpcError } from "./errors"
import { log } from "./logging"
import { parseIncomingMessage, send } from "./protocol"

type SocketData = {
  connectionId: string
  opIds: Set<string>
}

export type CommandResult = {
  argv: string[]
  code: number
  stdout: string
  stderr: string
  durationMs: number
}

type OperationRecord = {
  opId: string
  requestId: string
  connectionId: string
  kind: ExecutableRequest["kind"]
  request: ExecutableRequest
  state: JobState
  createdAt: number
  startedAt?: number
  finishedAt?: number
  abortController: AbortController
}

type ServerLike = {
  stop(closeActiveConnections?: boolean): Promise<void> | void
}

export type CommandExecutor = (params: {
  command: KrunCommand
  args: string[]
  timeoutMs: number
  signal: AbortSignal
  config: DaemonConfig
}) => Promise<CommandResult>

export type RuntimeServer = {
  endpoint: string
  stop: () => Promise<void>
}

function cleanupSocketPath(socketPath: string): void {
  if (existsSync(socketPath)) {
    const stat = lstatSync(socketPath)
    if (!stat.isSocket()) {
      throw new ProtocolError("invalid_config", `refusing to remove non-socket path: ${socketPath}`)
    }
    rmSync(socketPath)
  }

  mkdirSync(dirname(socketPath), { recursive: true })
}

async function runCommandDefault(
  config: DaemonConfig,
  command: KrunCommand,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CommandResult> {
  const argv = [config.krunPath, command, ...args]
  const startedAt = performance.now()

  const timeoutController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, timeoutMs)
  const onAbort = () => timeoutController.abort()
  signal.addEventListener("abort", onAbort, { once: true })

  try {
    const child = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      signal: timeoutController.signal,
      maxBuffer: config.maxOutputBytes,
    })

    const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("")
    const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("")

    const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, child.exited])

    if (timedOut && code !== 0 && !signal.aborted) {
      throw new ProtocolError("timeout", `command exceeded timeout (${timeoutMs}ms)`)
    }

    return {
      argv,
      code,
      stdout,
      stderr,
      durationMs: Math.round(performance.now() - startedAt),
    }
  } catch (error) {
    if (signal.aborted) {
      throw new ProtocolError("cancelled", "operation cancelled by client")
    }

    if (timeoutController.signal.aborted) {
      throw new ProtocolError("timeout", `command exceeded timeout (${timeoutMs}ms)`)
    }

    throw new ProtocolError("executor_error", "failed to spawn command", {
      cause: error instanceof Error ? error.message : String(error),
      argv,
    })
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", onAbort)
  }
}

function resolveExecutor(config: DaemonConfig, executor?: CommandExecutor): CommandExecutor {
  if (executor) return executor

  return async (params) =>
    runCommandDefault(config, params.command, params.args, params.timeoutMs, params.signal)
}

function createOperationManager(config: DaemonConfig, executor: CommandExecutor) {
  const operations = new Map<string, OperationRecord>()
  const queue: string[] = []
  const activeSockets = new Map<string, ServerWebSocket<SocketData>>()
  let runningOps = 0

  function enqueueOperation(ws: ServerWebSocket<SocketData>, request: ExecutableRequest): string {
    const opId = crypto.randomUUID()
    const operation: OperationRecord = {
      opId,
      requestId: request.id,
      connectionId: ws.data.connectionId,
      kind: request.kind,
      request,
      state: "queued",
      createdAt: Date.now(),
      abortController: new AbortController(),
    }

    operations.set(opId, operation)
    ws.data.opIds.add(opId)
    queue.push(opId)

    const accepted: RequestAccepted = {
      id: request.id,
      ok: true,
      accepted: true,
      opId,
      state: "queued",
      queuedAt: new Date(operation.createdAt).toISOString(),
    }
    send(ws, accepted)

    log("info", "op_queued", {
      opId,
      requestId: request.id,
      connectionId: ws.data.connectionId,
      kind: request.kind,
    })

    scheduleQueue()
    return opId
  }

  function cancelOperation(operation: OperationRecord): void {
    if (operation.state === "queued") {
      operation.state = "cancelled"
      operation.finishedAt = Date.now()
      const idx = queue.indexOf(operation.opId)
      if (idx >= 0) queue.splice(idx, 1)
    } else if (operation.state === "running") {
      operation.abortController.abort()
    }
  }

  function emitUpdate(operation: OperationRecord): void {
    const ws = activeSockets.get(operation.connectionId)
    if (!ws) return

    const update: OpUpdate = {
      event: "op.update",
      opId: operation.opId,
      id: operation.requestId,
      kind: operation.kind,
      state: operation.state,
      ts: new Date().toISOString(),
    }
    send(ws, update)
  }

  function emitDone(
    operation: OperationRecord,
    payload: Omit<OpDone, "event" | "opId" | "id" | "kind" | "state" | "ts">,
  ): void {
    const ws = activeSockets.get(operation.connectionId)
    if (!ws) return

    const done: OpDone = {
      event: "op.done",
      opId: operation.opId,
      id: operation.requestId,
      kind: operation.kind,
      state: operation.state,
      ts: new Date().toISOString(),
      ...payload,
    }
    send(ws, done)
  }

  function cleanupFinishedOperation(operation: OperationRecord): void {
    const ws = activeSockets.get(operation.connectionId)
    ws?.data.opIds.delete(operation.opId)

    const cleanupTimer = setTimeout(() => {
      const existing = operations.get(operation.opId)
      if (existing && existing.finishedAt !== undefined) {
        operations.delete(operation.opId)
      }
    }, config.finishedOpTtlMs)
    ;(cleanupTimer as { unref?: () => void }).unref?.()
  }

  async function executeOperation(
    request: ExecutableRequest,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const { command, args } = argsForRequest(request, config)
    const result = await executor({
      command,
      args,
      timeoutMs: config.defaultTimeoutMs,
      signal,
      config,
    })

    if (result.code !== 0) {
      if (signal.aborted) {
        throw new ProtocolError("cancelled", "operation cancelled by client")
      }

      throw new ProtocolError("executor_error", `krunvm ${command} failed`, {
        code: result.code,
        stderr: result.stderr,
        argv: result.argv,
      })
    }

    return result
  }

  async function runOperation(operation: OperationRecord): Promise<void> {
    runningOps += 1
    operation.state = "running"
    operation.startedAt = Date.now()
    emitUpdate(operation)

    log("info", "op_started", {
      opId: operation.opId,
      requestId: operation.requestId,
      kind: operation.kind,
    })

    try {
      const result = await executeOperation(operation.request, operation.abortController.signal)
      operation.state = "succeeded"
      operation.finishedAt = Date.now()

      emitDone(operation, {
        ok: true,
        result: {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        },
      })

      log("info", "op_succeeded", {
        opId: operation.opId,
        requestId: operation.requestId,
        kind: operation.kind,
        durationMs: result.durationMs,
        exitCode: result.code,
      })
    } catch (error) {
      const rpcError = toRpcError(error, operation.requestId)
      operation.state =
        rpcError.error.code === "timeout"
          ? "timed_out"
          : rpcError.error.code === "cancelled"
            ? "cancelled"
            : "failed"
      operation.finishedAt = Date.now()

      emitDone(operation, {
        ok: false,
        error: rpcError.error,
      })

      if (operation.state === "cancelled") {
        log("info", "op_cancelled", {
          opId: operation.opId,
          requestId: operation.requestId,
          kind: operation.kind,
          state: operation.state,
          error: rpcError.error,
        })
      } else if (operation.state === "timed_out") {
        log("warn", "op_timed_out", {
          opId: operation.opId,
          requestId: operation.requestId,
          kind: operation.kind,
          state: operation.state,
          error: rpcError.error,
        })
      } else {
        log("warn", "op_failed", {
          opId: operation.opId,
          requestId: operation.requestId,
          kind: operation.kind,
          state: operation.state,
          error: rpcError.error,
        })
      }
    } finally {
      cleanupFinishedOperation(operation)
      runningOps -= 1
      scheduleQueue()
    }
  }

  function scheduleQueue(): void {
    while (runningOps < config.maxConcurrentOps && queue.length > 0) {
      const opId = queue.shift()
      if (!opId) break

      const operation = operations.get(opId)
      if (!operation || operation.state !== "queued") continue

      void runOperation(operation)
    }
  }

  const websocket: WebSocketHandler<SocketData> = {
    data: {} as SocketData,
    maxPayloadLength: config.maxPayloadLength,
    idleTimeout: config.idleTimeoutSec,
    closeOnBackpressureLimit: config.closeOnBackpressureLimit,
    open(ws) {
      activeSockets.set(ws.data.connectionId, ws)
      log("info", "ws_open", { connectionId: ws.data.connectionId })
    },
    message(ws, message) {
      let parsed: RpcRequest

      try {
        parsed = parseIncomingMessage(message)
      } catch (error) {
        send(ws, toRpcError(error, null))
        return
      }

      if (parsed.kind === "cancel") {
        const operation = operations.get(parsed.payload.opId)
        if (!operation) {
          send(ws, toRpcError(new ProtocolError("not_found", "operation not found"), parsed.id))
          return
        }

        if (operation.connectionId !== ws.data.connectionId) {
          send(
            ws,
            toRpcError(
              new ProtocolError("forbidden", "cannot cancel another client's operation"),
              parsed.id,
            ),
          )
          return
        }

        cancelOperation(operation)

        const cancelledAck: AckCancelled = {
          id: parsed.id,
          ok: true,
          cancelled: true,
          opId: parsed.payload.opId,
        }
        send(ws, cancelledAck)

        if (operation.state === "cancelled") {
          emitDone(operation, {
            ok: false,
            error: {
              code: "cancelled",
              message: "operation cancelled before execution",
            },
          })
          cleanupFinishedOperation(operation)
        }

        return
      }

      enqueueOperation(ws, parsed)
    },
    close(ws, code, reason) {
      activeSockets.delete(ws.data.connectionId)

      for (const opId of ws.data.opIds) {
        const operation = operations.get(opId)
        if (!operation) continue
        if (operation.state === "queued") {
          cancelOperation(operation)
          cleanupFinishedOperation(operation)
          continue
        }

        if (operation.state === "running") {
          cancelOperation(operation)
        }
      }

      scheduleQueue()

      log("info", "ws_close", {
        connectionId: ws.data.connectionId,
        code,
        reason,
      })
    },
    drain(ws) {
      log("info", "ws_drain", { connectionId: ws.data.connectionId })
    },
  }

  return {
    websocket,
    activeSockets,
  }
}

export function createServer(config: DaemonConfig, executor?: CommandExecutor): RuntimeServer {
  const resolvedExecutor = resolveExecutor(config, executor)
  const { websocket, activeSockets } = createOperationManager(config, resolvedExecutor)

  if (config.transport === "unix") {
    cleanupSocketPath(config.unixSocketPath)
  }

  const options =
    config.transport === "unix"
      ? {
          unix: config.unixSocketPath,
          websocket,
          fetch(req: Request, instance: Bun.Server<SocketData>) {
            const url = new URL(req.url)
            if (url.pathname !== "/rpc") {
              return new Response("Not Found", { status: 404 })
            }

            const upgraded = instance.upgrade(req, {
              data: {
                connectionId: crypto.randomUUID(),
                opIds: new Set<string>(),
              },
            })

            if (upgraded) return
            return new Response("Upgrade failed", { status: 400 })
          },
          error(error: Error) {
            log("error", "server_error", {
              message: error?.message ?? String(error),
            })
            return new Response("Internal Server Error", { status: 500 })
          },
        }
      : {
          hostname: config.tcpHost,
          port: config.tcpPort,
          websocket,
          fetch(req: Request, instance: Bun.Server<SocketData>) {
            const url = new URL(req.url)
            if (url.pathname !== "/rpc") {
              return new Response("Not Found", { status: 404 })
            }

            const upgraded = instance.upgrade(req, {
              data: {
                connectionId: crypto.randomUUID(),
                opIds: new Set<string>(),
              },
            })

            if (upgraded) return
            return new Response("Upgrade failed", { status: 400 })
          },
          error(error: Error) {
            log("error", "server_error", {
              message: error?.message ?? String(error),
            })
            return new Response("Internal Server Error", { status: 500 })
          },
        }

  const server = Bun.serve<SocketData>(options)

  if (config.transport === "unix") {
    chmodSync(config.unixSocketPath, 0o660)
  }

  const endpoint =
    config.transport === "unix"
      ? `unix:${config.unixSocketPath}`
      : `ws://${config.tcpHost}:${config.tcpPort}/rpc`

  log("info", "server_started", {
    endpoint,
    transport: config.transport,
    krunPath: config.krunPath,
    maxConcurrentOps: config.maxConcurrentOps,
  })

  const stop = async (): Promise<void> => {
    for (const ws of activeSockets.values()) {
      ws.close(1001, "server shutdown")
    }

    const stopResult = (server as ServerLike).stop(true)
    if (stopResult && typeof (stopResult as Promise<void>).then === "function") {
      void Promise.resolve(stopResult).catch((error) => {
        log("warn", "server_stop_error", {
          endpoint,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    }

    if (config.transport === "unix" && existsSync(config.unixSocketPath)) {
      const stat = lstatSync(config.unixSocketPath)
      if (stat.isSocket()) {
        rmSync(config.unixSocketPath)
      }
    }
  }

  return {
    endpoint,
    stop,
  }
}
