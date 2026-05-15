import {
  createKrunClient,
  type CreatePayload,
  type DeletePayload,
  type InspectPayload,
  type KrunClient,
  type KrunClientOptions,
  type OpDone,
  type StartPayload,
} from "@wskr/client"
import type { SandboxProvider } from "sandbox-agent"

export type WskrProviderSandbox = {
  id: string
  vmName: string
  baseUrl: string
  providerId: string
  metadata: {
    createdAt: string
  }
}

export type WskrResolvedSandboxSpec = {
  vmName: string
  create: CreatePayload
  start: StartPayload
  baseUrl: string
}

export type WskrProviderOptions = {
  client?: KrunClient
  clientOptions?: KrunClientOptions
  resolveSpec?: () => Promise<WskrResolvedSandboxSpec> | WskrResolvedSandboxSpec
  providerName?: string
  token?: string
  env?: Record<string, string>
  onCreate?: (sandbox: WskrProviderSandbox) => void | Promise<void>
  onDestroy?: (sandbox: WskrProviderSandbox) => void | Promise<void>
}

export type WskrProvider = SandboxProvider & {
  list: () => WskrProviderSandbox[]
  get: (providerId: string) => WskrProviderSandbox | undefined
}

type LifecycleDeps = {
  resolveSpec: WskrProviderOptions["resolveSpec"]
  onCreate?: WskrProviderOptions["onCreate"]
  onDestroy?: WskrProviderOptions["onDestroy"]
}

function getClient(options: WskrProviderOptions): KrunClient {
  if (options.client) return options.client
  return createKrunClient(options.clientOptions)
}

function makeProviderId(name: string, vmName: string): string {
  return `${name}-${vmName}-${crypto.randomUUID()}`
}

function toDeletePayload(vmName: string): DeletePayload {
  return { name: vmName }
}

function toInspectPayload(vmName: string): InspectPayload {
  return { name: vmName }
}

async function ensureSuccess(done: OpDone, operation: string): Promise<void> {
  if (!done.ok) {
    throw new Error(`${operation} failed: ${done.error?.message ?? "unknown error"}`)
  }
}

function createLifecycle(client: KrunClient, deps: LifecycleDeps) {
  const sandboxes = new Map<string, WskrProviderSandbox>()

  function resolveSpec(): Promise<WskrResolvedSandboxSpec> | WskrResolvedSandboxSpec {
    if (!deps.resolveSpec) {
      throw new Error("wskr provider requires resolveSpec() to provision a sandbox")
    }
    return deps.resolveSpec()
  }

  async function createSandbox(providerName: string): Promise<WskrProviderSandbox> {
    const spec = await resolveSpec()
    const providerId = makeProviderId(providerName, spec.vmName)

    const createDone = await client.create(spec.create)
    try {
      await ensureSuccess(createDone, `create VM '${spec.vmName}'`)

      const startDone = await client.start(spec.start)
      await ensureSuccess(startDone, `start VM '${spec.vmName}'`)
    } catch (error) {
      try {
        const rollbackDone = await client.delete(toDeletePayload(spec.vmName))
        await ensureSuccess(rollbackDone, `rollback VM '${spec.vmName}'`)
      } catch {
        // rollback best effort
      }
      throw error
    }

    const sandbox: WskrProviderSandbox = {
      id: spec.vmName,
      vmName: spec.vmName,
      baseUrl: spec.baseUrl,
      providerId,
      metadata: {
        createdAt: new Date().toISOString(),
      },
    }

    sandboxes.set(providerId, sandbox)
    await deps.onCreate?.(sandbox)
    return sandbox
  }

  async function destroySandbox(providerId: string): Promise<void> {
    const sandbox = sandboxes.get(providerId)
    if (!sandbox) return

    sandboxes.delete(providerId)

    const done = await client.delete(toDeletePayload(sandbox.vmName))
    await ensureSuccess(done, `destroy VM '${sandbox.vmName}'`)
    await deps.onDestroy?.(sandbox)
  }

  async function reconnectSandbox(providerId: string): Promise<void> {
    const sandbox = sandboxes.get(providerId)
    if (!sandbox) {
      throw new Error(`Unknown sandbox '${providerId}'`)
    }

    const done = await client.inspect(toInspectPayload(sandbox.vmName))
    await ensureSuccess(done, `inspect VM '${sandbox.vmName}'`)
  }

  async function ensureServer(providerId: string): Promise<void> {
    const sandbox = sandboxes.get(providerId)
    if (!sandbox) {
      throw new Error(`Unknown sandbox '${providerId}'`)
    }

    const done = await client.inspect(toInspectPayload(sandbox.vmName))
    await ensureSuccess(done, `ensure server on VM '${sandbox.vmName}'`)
  }

  return {
    sandboxes,
    createSandbox,
    destroySandbox,
    reconnectSandbox,
    ensureServer,
  }
}

export function wskr(options: WskrProviderOptions): WskrProvider {
  const providerName = options.providerName ?? "wskr"
  const client = getClient(options)
  const lifecycle = createLifecycle(client, {
    resolveSpec: options.resolveSpec,
    onCreate: options.onCreate,
    onDestroy: options.onDestroy,
  })

  return {
    name: providerName,
    defaultCwd: "/tmp",
    async create() {
      const sandbox = await lifecycle.createSandbox(providerName)
      return sandbox.providerId
    },
    async destroy(sandboxId) {
      await lifecycle.destroySandbox(sandboxId)
    },
    async reconnect(sandboxId) {
      await lifecycle.reconnectSandbox(sandboxId)
    },
    async getUrl(sandboxId) {
      const sandbox = lifecycle.sandboxes.get(sandboxId)
      if (!sandbox) {
        throw new Error(`Unknown sandbox '${sandboxId}'`)
      }
      return sandbox.baseUrl
    },
    async ensureServer(sandboxId) {
      await lifecycle.ensureServer(sandboxId)
    },
    list() {
      return Array.from(lifecycle.sandboxes.values())
    },
    get(providerId) {
      return lifecycle.sandboxes.get(providerId)
    },
  }
}

export function createSandboxRuntimeClient(options: KrunClientOptions = {}): KrunClient {
  return createKrunClient(options)
}

export async function pingSandboxRuntime(options: KrunClientOptions = {}): Promise<OpDone> {
  const client = createKrunClient(options)
  try {
    return await client.get()
  } finally {
    client.close()
  }
}

export default wskr
