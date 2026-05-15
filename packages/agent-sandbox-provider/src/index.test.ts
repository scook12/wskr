import { describe, expect, it } from "bun:test"
import type { KrunClient } from "@wskr/client"
import { wskr } from "./index"

function okDone() {
  return {
    event: "op.done" as const,
    id: crypto.randomUUID(),
    opId: crypto.randomUUID(),
    kind: "list" as const,
    state: "succeeded" as const,
    ts: new Date().toISOString(),
    ok: true as const,
    result: {
      code: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    },
  }
}

function createMockClient() {
  const calls = {
    create: [] as unknown[],
    start: [] as unknown[],
    del: [] as unknown[],
    inspect: [] as unknown[],
  }

  const client = {
    create: async (payload: unknown) => {
      calls.create.push(payload)
      return okDone()
    },
    start: async (payload: unknown) => {
      calls.start.push(payload)
      return okDone()
    },
    delete: async (payload: unknown) => {
      calls.del.push(payload)
      return okDone()
    },
    inspect: async (payload: unknown) => {
      calls.inspect.push(payload)
      return okDone()
    },
  } as unknown as KrunClient

  return { client, calls }
}

describe("wskr provider", () => {
  it("implements SandboxProvider shape and provisions/destroys sandbox", async () => {
    const { client, calls } = createMockClient()
    const provider = wskr({
      client,
      resolveSpec: () => ({
        vmName: "vm-provider-test",
        baseUrl: "http://127.0.0.1:3000",
        create: {
          image: "ghcr.io/wskr/base:latest",
          name: "vm-provider-test",
          workdir: "/tmp",
          cpus: 1,
          dns: "1.1.1.1",
          networkMode: "open",
          networkAllowHosts: [],
          volumes: [],
          ports: [],
          memoryMiB: 512,
        },
        start: {
          name: "vm-provider-test",
          cpus: 1,
          memoryMiB: 512,
          args: [],
          env: [],
        },
      }),
    })

    expect(provider.name).toBe("wskr")
    expect(typeof provider.create).toBe("function")
    expect(typeof provider.destroy).toBe("function")
    expect(typeof provider.getUrl).toBe("function")

    const sandboxId = await provider.create()
    expect(sandboxId.startsWith("wskr-")).toBe(true)

    const url = await provider.getUrl?.(sandboxId)
    expect(url).toBe("http://127.0.0.1:3000")

    await provider.destroy(sandboxId)

    expect(calls.create.length).toBe(1)
    expect(calls.start.length).toBe(1)
    expect(calls.del.length).toBe(1)
  })

  it("throws when resolveSpec is missing for provisioning", async () => {
    const { client } = createMockClient()
    const provider = wskr({ client })
    await expect(provider.create()).rejects.toThrow(
      "wskr provider requires resolveSpec() to provision a sandbox",
    )
  })
})
