import {
  AckAcceptedSchema,
  AckCancelledSchema,
  AckErrorSchema,
  CancelPayloadSchema,
  type CancelPayload,
  type ChangePayload,
  type CreatePayload,
  type DeletePayload,
  type GetPayload,
  type InspectPayload,
  type ListPayload,
  OpDoneSchema,
  OpUpdateSchema,
  RequestSchema,
  type StartPayload,
  type AckAccepted,
  type AckCancelled,
  type OpDone,
  type OpUpdate,
  type RequestKind,
} from "@wskr/types"

export type {
  AckAccepted,
  AckCancelled,
  CancelPayload,
  ChangePayload,
  CreatePayload,
  DeletePayload,
  GetPayload,
  InspectPayload,
  ListPayload,
  OpDone,
  OpUpdate,
  RequestKind,
  StartPayload,
} from "@wskr/types"

export type RpcKind = RequestKind

export type ClientRpcErrorCode =
  | "ack_timeout"
  | "protocol_error"
  | "transport_error"
  | "connection_closed"
  | "unexpected_ack"

export class KrunClientError extends Error {
  readonly code: ClientRpcErrorCode
  readonly details?: unknown

  constructor(code: ClientRpcErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "KrunClientError"
    this.code = code
    this.details = details
  }
}

export type PendingOperation = {
  id: string
  opId: string
  wait: Promise<OpDone>
}

export type KrunClientOptions = {
  url?: string
  protocols?: string | string[]
  ackTimeoutMs?: number
  websocketFactory?: (url: string, protocols?: string | string[]) => WebSocket
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

type OutboundRequestByKind = {
  get: { kind: "get"; payload: GetPayload }
  create: { kind: "create"; payload: CreatePayload }
  delete: { kind: "delete"; payload: DeletePayload }
  start: { kind: "start"; payload: StartPayload }
  inspect: { kind: "inspect"; payload: InspectPayload }
  changevm: { kind: "changevm"; payload: ChangePayload }
  list: { kind: "list"; payload: ListPayload }
  cancel: { kind: "cancel"; payload: CancelPayload }
}

type OutboundMessageByKind = {
  [K in keyof OutboundRequestByKind]: { id: string } & OutboundRequestByKind[K]
}

type OutboundMessage = OutboundMessageByKind[keyof OutboundMessageByKind]

type ExecutableKind = Exclude<keyof OutboundRequestByKind, "cancel">

type DoneState = {
  deferred: Deferred<OpDone>
  opId?: string
}

function defer<T>(controller?: AbortController): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const { signal } = controller || {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
  })

  return { promise, resolve, reject }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "unknown rpc error"
}

function defaultWebSocketFactory(url: string, protocols?: string | string[]): WebSocket {
  return new WebSocket(url, protocols)
}

export class KrunClient {
  private readonly url: string
  private readonly protocols: string | string[] | undefined
  private readonly ackTimeoutMs: number
  private readonly websocketFactory: (url: string, protocols?: string | string[]) => WebSocket
  private ws: WebSocket | null = null
  private connectPromise: Promise<void> | null = null

  private abortController = new AbortController()
  private pendingAckById = new Map<string, Deferred<AckAccepted | AckCancelled>>()
  private pendingDoneById = new Map<string, DoneState>()
  private pendingDoneByOpId = new Map<string, DoneState>()
  private updateListeners = new Set<(event: OpUpdate) => void>()

  constructor(options: KrunClientOptions = {}) {
    this.url = options.url ?? "ws://127.0.0.1:8877/rpc"
    this.protocols = options.protocols
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5_000
    this.websocketFactory = options.websocketFactory ?? defaultWebSocketFactory
  }

  async connect(): Promise<void> {
    if (this.isConnected) return
    if (this.connectPromise) {
      await this.connectPromise
      return
    }

    const { signal } = this.abortController
    this.connectPromise = new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      const ws = this.websocketFactory(this.url, this.protocols)
      this.ws = ws

      let settled = false

      const resolveOnce = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const rejectOnce = (reason: unknown) => {
        if (settled) return
        settled = true
        reject(reason)
      }

      ws.addEventListener("open", () => {
        resolveOnce()
      })

      ws.addEventListener("message", (event) => {
        this.handleMessage(event)
      })

      ws.addEventListener("error", () => {
        rejectOnce(
          new KrunClientError("transport_error", `WebSocket connection failed for ${this.url}`),
        )
      })

      ws.addEventListener("close", (event) => {
        this.ws = null
        rejectOnce(
          new KrunClientError(
            "connection_closed",
            "websocket closed before connection established",
            {
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean,
            },
          ),
        )
        this.cancelAllPending("websocket connection closed")
      })
    })

    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  close(code = 1000, reason = "normal closure"): void {
    if (!this.ws) return
    this.ws.close(code, reason)
  }

  onUpdate(listener: (event: OpUpdate) => void): () => void {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  async enqueue<K extends ExecutableKind>(
    kind: K,
    payload: OutboundRequestByKind[K]["payload"],
  ): Promise<PendingOperation> {
    await this.connect()

    const id = crypto.randomUUID()
    const ackDeferred = defer<AckAccepted | AckCancelled>(this.abortController)
    const doneDeferred = defer<OpDone>(this.abortController)
    const doneState: DoneState = { deferred: doneDeferred }

    this.pendingAckById.set(id, ackDeferred)
    this.pendingDoneById.set(id, doneState)

    this.send({ id, kind, payload } as OutboundMessageByKind[K])

    try {
      const ack = await this.waitForAck(id, ackDeferred)
      if (!("accepted" in ack)) {
        throw new KrunClientError(
          "unexpected_ack",
          "unexpected non-accepted ack for operation enqueue",
          {
            ack,
          },
        )
      }

      doneState.opId = ack.opId
      this.pendingDoneByOpId.set(ack.opId, doneState)

      return {
        id,
        opId: ack.opId,
        wait: doneDeferred.promise,
      }
    } catch (error) {
      this.removeDoneState(id, doneState)
      throw error
    }
  }

  async request<K extends ExecutableKind>(
    kind: K,
    payload: OutboundRequestByKind[K]["payload"],
  ): Promise<OpDone> {
    const pending = await this.enqueue(kind, payload)
    return pending.wait
  }

  async cancel(opId: string): Promise<AckCancelled> {
    await this.connect()

    const id = crypto.randomUUID()
    const payload = CancelPayloadSchema.parse({ opId })
    const ackDeferred = defer<AckAccepted | AckCancelled>(this.abortController)
    this.pendingAckById.set(id, ackDeferred)

    this.send({ id, kind: "cancel", payload })

    const ack = await this.waitForAck(id, ackDeferred)
    if (!("cancelled" in ack)) {
      throw new KrunClientError("unexpected_ack", "unexpected non-cancel ack", { ack })
    }

    return ack
  }

  async get(): Promise<OpDone> {
    return this.request("get", null)
  }

  async create(payload: OutboundRequestByKind["create"]["payload"]): Promise<OpDone> {
    return this.request("create", payload)
  }

  async delete(payload: OutboundRequestByKind["delete"]["payload"]): Promise<OpDone> {
    return this.request("delete", payload)
  }

  async start(payload: OutboundRequestByKind["start"]["payload"]): Promise<OpDone> {
    return this.request("start", payload)
  }

  async inspect(payload: OutboundRequestByKind["inspect"]["payload"]): Promise<OpDone> {
    return this.request("inspect", payload)
  }

  async changevm(payload: OutboundRequestByKind["changevm"]["payload"]): Promise<OpDone> {
    return this.request("changevm", payload)
  }

  async list(debug = false): Promise<OpDone> {
    return this.request("list", { debug })
  }

  private get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN
  }

  private send(message: OutboundMessage): void {
    if (!this.isConnected) {
      throw new KrunClientError("transport_error", "websocket is not connected")
    }

    const parsed = RequestSchema.parse(message)
    this.ws?.send(JSON.stringify(parsed))
  }

  private async waitForAck(
    id: string,
    deferred: Deferred<AckAccepted | AckCancelled>,
  ): Promise<AckAccepted | AckCancelled> {
    const timeout = setTimeout(() => {
      if (!this.pendingAckById.has(id)) return
      this.pendingAckById.delete(id)
      deferred.reject(new KrunClientError("ack_timeout", `ack timeout (${this.ackTimeoutMs}ms)`))
    }, this.ackTimeoutMs)

    try {
      return await deferred.promise
    } finally {
      clearTimeout(timeout)
    }
  }

  private handleMessage(event: MessageEvent): void {
    const text = typeof event.data === "string" ? event.data : String(event.data)
    let raw: unknown

    try {
      raw = JSON.parse(text)
    } catch {
      return
    }

    const opUpdate = OpUpdateSchema.safeParse(raw)
    if (opUpdate.success) {
      for (const listener of this.updateListeners) {
        listener(opUpdate.data)
      }
      return
    }

    const opDone = OpDoneSchema.safeParse(raw)
    if (opDone.success) {
      const doneById = this.pendingDoneById.get(opDone.data.id)
      if (doneById) {
        this.pendingDoneById.delete(opDone.data.id)
        this.pendingDoneByOpId.delete(opDone.data.opId)
        doneById.deferred.resolve(opDone.data)
        return
      }

      const doneByOpId = this.pendingDoneByOpId.get(opDone.data.opId)
      if (doneByOpId) {
        this.pendingDoneByOpId.delete(opDone.data.opId)
        this.pendingDoneById.delete(opDone.data.id)
        doneByOpId.deferred.resolve(opDone.data)
      }
      return
    }

    const ackAccepted = AckAcceptedSchema.safeParse(raw)
    if (ackAccepted.success) {
      const deferred = this.pendingAckById.get(ackAccepted.data.id)
      if (!deferred) return
      this.pendingAckById.delete(ackAccepted.data.id)
      deferred.resolve(ackAccepted.data)
      return
    }

    const ackCancelled = AckCancelledSchema.safeParse(raw)
    if (ackCancelled.success) {
      const deferred = this.pendingAckById.get(ackCancelled.data.id)
      if (!deferred) return
      this.pendingAckById.delete(ackCancelled.data.id)
      deferred.resolve(ackCancelled.data)
      return
    }

    const ackError = AckErrorSchema.safeParse(raw)
    if (!ackError.success) return

    const id = ackError.data.id
    if (id === null) return

    const deferred = this.pendingAckById.get(id)
    if (deferred) {
      this.pendingAckById.delete(id)
      deferred.reject(
        new KrunClientError("protocol_error", ackError.data.error.message, ackError.data.error),
      )
      return
    }

    const doneState = this.pendingDoneById.get(id)
    if (doneState) {
      this.pendingDoneById.delete(id)
      if (doneState.opId) this.pendingDoneByOpId.delete(doneState.opId)
      doneState.deferred.reject(
        new KrunClientError("protocol_error", ackError.data.error.message, ackError.data.error),
      )
    }
  }

  private removeDoneState(id: string, state: DoneState): void {
    this.pendingDoneById.delete(id)
    if (state.opId) this.pendingDoneByOpId.delete(state.opId)
  }

  private cancelAllPending(reason: string | KrunClientError) {
    const abortReason =
      reason instanceof KrunClientError ? reason : new KrunClientError("connection_closed", reason)
    this.abortController.abort(abortReason)
    this.pendingAckById = new Map()
    this.pendingDoneById = new Map()
    this.pendingDoneByOpId = new Map()
    this.abortController = new AbortController()
  }
}

export function createKrunClient(options: KrunClientOptions = {}): KrunClient {
  return new KrunClient(options)
}

export function rpcErrorToMessage(error: unknown): string {
  return toErrorMessage(error)
}
