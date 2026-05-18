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
    boot: [] as unknown[],
    del: [] as unknown[],
    inspect: [] as unknown[],
  }

  const client = {
    create: async (payload: unknown) => {
      calls.create.push(payload)
      return okDone()
    },
    boot: async (payload: unknown) => {
      calls.boot.push(payload)
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
    const previousSkipHealth = Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK
    Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK = "1"
    try {
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
            volumes: [],
            ports: [],
            memoryMiB: 512,
          },
          boot: {
            name: "vm-provider-test",
            command: "sandbox-agent",
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
      expect(calls.boot.length).toBe(1)
      expect(calls.del.length).toBe(1)
    } finally {
      if (previousSkipHealth === undefined) {
        delete Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK
      } else {
        Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK = previousSkipHealth
      }
    }
  })

  it("fails create when sandbox health endpoint is not reachable", async () => {
    const { client } = createMockClient()
    const previousTimeout = Bun.env.OPENCODE_SANDBOX_AGENT_READY_TIMEOUT_MS
    Bun.env.OPENCODE_SANDBOX_AGENT_READY_TIMEOUT_MS = "50"

    const provider = wskr({
      client,
      resolveSpec: () => ({
        vmName: "vm-provider-health-fail",
        baseUrl: "http://127.0.0.1:1",
        create: {
          image: "ghcr.io/wskr/base:latest",
          name: "vm-provider-health-fail",
          workdir: "/tmp",
          cpus: 1,
          dns: "1.1.1.1",
          volumes: [],
          ports: [],
          memoryMiB: 512,
        },
        boot: {
          name: "vm-provider-health-fail",
          command: "sandbox-agent",
          cpus: 1,
          memoryMiB: 512,
          args: [],
          env: [],
        },
      }),
    })

    try {
      await expect(provider.create()).rejects.toThrow("sandbox-agent health check failed")
    } finally {
      if (previousTimeout === undefined) {
        delete Bun.env.OPENCODE_SANDBOX_AGENT_READY_TIMEOUT_MS
      } else {
        Bun.env.OPENCODE_SANDBOX_AGENT_READY_TIMEOUT_MS = previousTimeout
      }
    }
  })

  it("throws when resolveSpec is missing for provisioning", async () => {
    const previousSkipHealth = Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK
    Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK = "1"
    try {
      const { client } = createMockClient()
      const provider = wskr({ client })
      await expect(provider.create()).rejects.toThrow(
        "wskr provider requires resolveSpec() to provision a sandbox",
      )
    } finally {
      if (previousSkipHealth === undefined) {
        delete Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK
      } else {
        Bun.env.WSKR_SKIP_SANDBOX_HEALTHCHECK = previousSkipHealth
      }
    }
  })
})
