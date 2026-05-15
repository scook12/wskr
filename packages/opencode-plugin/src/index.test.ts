import { describe, expect, it } from "bun:test"
import type { RuntimePolicy } from "@wskr/types"
import { internal } from "./index"

function makePolicy(): RuntimePolicy {
  return {
    version: 1,
    policyDir: "/tmp",
    agentMap: {
      primary: { "*": "strict" },
      subagent: { "*": "strict" },
    },
    audit: {
      enabled: true,
      sink: "file",
      path: "/tmp/audit.ndjson",
      include: [],
    },
    commandPolicies: {
      strict_readonly: {
        default_action: "deny",
        match_mode: "normalized_command",
        rules: [
          { id: "allow_git_status", match: "git status*", action: "allow" },
          { id: "never_rm_root", match: "rm -rf /*", action: "never" },
        ],
      },
      release_guarded: {
        default_action: "ask",
        match_mode: "normalized_command",
        rules: [],
      },
    },
    defaults: {
      requireSandboxForBash: true,
      failClosed: true,
      unknownAgentProfile: "strict",
      unknownSubagentProfile: "strict",
      subagentInheritsParentProfile: false,
      profileResolutionOrder: ["strict_default"],
    },
    profiles: {
      strict: {
        command_policy: "strict_readonly",
        smol: {
          smolfile: "strict.smol",
          image: "alpine:3.20",
          init: [],
        },
        filesystem: {
          workdir: "/workspace",
          mounts: [{ host: "{repoRoot}", guest: "/workspace", mode: "rw" }],
        },
        network: {
          mode: "allowlist",
          allow_hosts: [],
          allow_cidrs: [],
          deny_private_ranges: true,
        },
        auth: {
          mode: "none",
          stub_env: {},
        },
      },
      release: {
        command_policy: "release_guarded",
        smol: {
          smolfile: "release.smol",
          image: "alpine:3.20",
          init: [],
        },
        filesystem: {
          workdir: "/workspace",
          mounts: [{ host: "{repoRoot}", guest: "/workspace", mode: "rw" }],
        },
        network: {
          mode: "allowlist",
          allow_hosts: [],
          allow_cidrs: [],
          deny_private_ranges: true,
        },
        auth: {
          mode: "none",
          stub_env: {},
        },
      },
    },
    redaction: {
      enabled: true,
      fail_mode: "block",
      rules: [],
    },
    secrets: {
      mode: "none",
      forceNoneWhenUntrustedInput: true,
      classes: {},
    },
    transitions: {
      enabled: true,
      default_action: "deny",
      rules: [],
    },
    vmPool: {
      enabled: true,
      maxTotalVms: 100,
      perProfileMaxIdle: 100,
      idleTtlSeconds: 3600,
      startupTimeoutSeconds: 45,
      reuse_key: [],
    },
  }
}

describe("plugin policy decision matrix", () => {
  it("handles allow, ask, deny default, and never", () => {
    const policy = makePolicy()

    const allow = internal.evaluateCommandPolicy("git status --short", "strict_readonly", policy)
    expect(allow.action).toBe("allow")
    expect(allow.reason).toBe("rule")

    const ask = internal.evaluateCommandPolicy("npm publish", "release_guarded", policy)
    expect(ask.action).toBe("ask")
    expect(ask.reason).toBe("default")

    const denyMissing = internal.evaluateCommandPolicy("echo hi", "missing", policy)
    expect(denyMissing.action).toBe("deny")
    expect(denyMissing.ruleId).toBe("missing_policy")

    const never = internal.evaluateCommandPolicy("rm -rf /*", "strict_readonly", policy)
    expect(never.action).toBe("deny")
    expect(never.reason).toBe("never")
  })
})

describe("plugin startup retry", () => {
  it("retries transient startup failures", async () => {
    let attempts = 0
    const client = { id: "ok" }

    const started = await internal.startSandboxAgentWithRetry(
      async () => {
        attempts += 1
        if (attempts < 3) {
          throw new Error(`transient-${attempts}`)
        }
        return client as any
      },
      {
        retryDelayMs: 1,
      },
    )

    expect(started).toBe(client)
    expect(attempts).toBe(3)
  })

  it("fails after max attempts", async () => {
    let attempts = 0
    await expect(
      internal.startSandboxAgentWithRetry(
        async () => {
          attempts += 1
          throw new Error("still failing")
        },
        {
          maxAttempts: 2,
          retryDelayMs: 1,
        },
      ),
    ).rejects.toThrow("still failing")

    expect(attempts).toBe(2)
  })
})

describe("plugin scope and mounts", () => {
  it("fails fast when repoRoot placeholder requires worktree", () => {
    expect(() =>
      internal.getSandboxScope(
        {
          directory: "/tmp/somewhere",
          worktree: "",
        } as any,
        true,
      ),
    ).toThrow("runtime policy requires a repository root")
  })

  it("expands repoRoot mount placeholders", () => {
    const mounts = [{ host: "{repoRoot}", guest: "/workspace", mode: "rw" }]
    const resolved = internal.resolveVolumeMounts(mounts as any, "/Users/test/repo")
    expect(resolved).toEqual(["/Users/test/repo:/workspace:rw"])
  })
})

describe("plugin pool and teardown", () => {
  it("reuses cached sandbox client by deterministic key", async () => {
    const policy = makePolicy()
    let createCount = 0

    const deps = {
      createClient: async ({ key, profileName, profileHash }: any) => {
        createCount += 1
        return {
          client: {},
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose",
        }
      },
    }

    const context = { worktree: "/repo/a", directory: "/repo/a" } as any
    const first = await internal.getSandboxClient("strict", policy, context, deps)
    const second = await internal.getSandboxClient("strict", policy, context, deps)

    expect(first.key).toBe(second.key)
    expect(createCount).toBe(1)
  })

  it("reconnect replaces pool entry and disposes prior handle", async () => {
    const policy = makePolicy()
    let createCount = 0
    let disposed = 0

    const deps = {
      createClient: async ({ key, profileName, profileHash }: any) => {
        createCount += 1
        return {
          client: {
            dispose: async () => {
              disposed += 1
            },
            destroySandbox: async () => {
              throw new Error("should not destroy in this test")
            },
          },
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose",
        }
      },
    }

    const context = { worktree: "/repo/b", directory: "/repo/b" } as any
    const handle = await internal.getSandboxClient("strict", policy, context, deps)
    const reconnected = await internal.reconnectSandboxClient(handle, policy, context, deps)

    expect(createCount).toBe(2)
    expect(disposed).toBe(1)
    expect(reconnected.key).toBe(handle.key)
  })

  it("uses destroySandbox teardown for provider-managed handles", async () => {
    let destroyed = 0
    let disposed = 0
    const entry = {
      key: "local:test",
      profile: "strict",
      profileHash: "hash",
      lastUsedAt: Date.now(),
      pending: Promise.resolve({
        client: {
          destroySandbox: async () => {
            destroyed += 1
          },
          dispose: async () => {
            disposed += 1
          },
        },
        key: "local:test",
        profile: "strict",
        profileHash: "hash",
        bootedAtMs: Date.now(),
        teardown: "destroySandbox" as const,
      }),
    }

    await internal.disposeClientEntry(entry as any)

    expect(destroyed).toBe(1)
    expect(disposed).toBe(0)
  })
})
