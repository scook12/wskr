import { describe, expect, it, mock } from "bun:test"
import { Effect } from "effect"
import type { RuntimePolicy } from "@wskr/types"
import { internal, loadRuntimePolicy } from "./index"

function makePolicy(): RuntimePolicy {
  return {
    version: 1,
    policyDir: "/tmp",
    policyFilePath: "/tmp/wskr.toml",
    agents: {
      primary: { "*": "strict" },
      subagent: { "*": "strict" },
    },
    audit: {
      enabled: true,
      path: "/tmp/audit.ndjson",
      include: [],
    },
    command_policies: {
      strict_readonly: {
        default_action: "deny",
        rules: [
          { id: "allow_git_status", match: "git status*", action: "allow" },
          { id: "never_rm_root", match: "rm -rf /*", action: "never" },
        ],
      },
      release_guarded: {
        default_action: "ask",
        rules: [],
      },
    },
    profiles: {
      strict: {
        command_policy: "strict_readonly",
        runtime: {
          image: "alpine:3.20",
          workdir: "/workspace",
          mounts: [{ host: "{repoRoot}", guest: "/workspace", mode: "rw" }],
          cpus: 1,
          memory_mib: 1024,
          dns: "1.1.1.1",
          sandbox_agent_command: "sandbox-agent",
          sandbox_agent_args: ["server"],
        },
        network: {
          mode: "allowlist",
          allow_hosts: ["github.com", "api.openai.com", "registry.npmjs.org"],
        },
        secrets: {
          mode: "dummy",
          allowlist: [],
          aliases: {},
          dummy_prefix: "DUMMY",
        },
        auth: {
          stub_env: {},
        },
      },
      release: {
        command_policy: "release_guarded",
        runtime: {
          image: "alpine:3.20",
          workdir: "/workspace",
          mounts: [{ host: "{repoRoot}", guest: "/workspace", mode: "rw" }],
          cpus: 1,
          memory_mib: 1024,
          dns: "1.1.1.1",
          sandbox_agent_command: "sandbox-agent",
          sandbox_agent_args: ["server"],
        },
        network: {
          mode: "allowlist",
          allow_hosts: ["github.com"],
        },
        secrets: {
          mode: "dummy",
          allowlist: [],
          aliases: {},
          dummy_prefix: "DUMMY",
        },
        auth: {
          stub_env: {},
        },
      },
    },
    redaction: {
      enabled: true,
      fail_mode: "block",
      rules: [],
    },
    pool: {
      enabled: true,
      max_total_vms: 100,
      per_profile_max_idle: 100,
      idle_ttl_seconds: 3600,
      startup_timeout_seconds: 45,
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

    expect(started).toBe(client as any)
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

  it("rejects allowlist mode with empty hosts", () => {
    const allowlistWithoutHosts = {
      ...makePolicy().profiles.strict,
      network: {
        mode: "allowlist",
        allow_hosts: [],
      },
    }

    expect(() => internal.assertNetworkPolicyEnforceable(allowlistWithoutHosts as any)).toThrow(
      "must not be empty",
    )
  })

  it("denies network command when network mode is deny", () => {
    const profile = {
      ...makePolicy().profiles.strict,
      network: {
        mode: "deny",
        allow_hosts: [],
      },
    }

    expect(() => internal.evaluateNetworkPolicy("curl https://github.com", profile as any)).toThrow(
      "Network access denied",
    )
  })

  it("allows allowlist network command only for permitted hosts", () => {
    const profile = {
      ...makePolicy().profiles.strict,
      network: {
        mode: "allowlist",
        allow_hosts: ["github.com", "*.githubusercontent.com"],
      },
    }

    expect(internal.evaluateNetworkPolicy("curl https://github.com", profile as any)).toMatchObject(
      {
        mode: "allowlist",
        usesNetwork: true,
      },
    )

    expect(() =>
      internal.evaluateNetworkPolicy("curl https://registry.npmjs.org", profile as any),
    ).toThrow("not allowed")
  })

  it("does not block non-network command under deny mode", () => {
    const profile = {
      ...makePolicy().profiles.strict,
      network: {
        mode: "deny",
        allow_hosts: [],
      },
    }

    expect(internal.evaluateNetworkPolicy("git status --short", profile as any)).toMatchObject({
      mode: "deny",
      usesNetwork: false,
    })
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
          client: {} as any,
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose" as const,
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
          } as any,
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose" as const,
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

describe("plugin secrets", () => {
  it("injects deterministic dummy secrets and tracks redactions", async () => {
    const policy = makePolicy()
    policy.profiles.strict.secrets = {
      mode: "dummy",
      allowlist: ["OPENAI_API_KEY", "alias.key"],
      aliases: {
        "alias.key": "ANTHROPIC_API_KEY",
      },
      dummy_prefix: "DUMMY",
    }

    const secrets = await internal.resolveProfileSecrets({
      policy,
      profileName: "strict",
      profile: policy.profiles.strict,
      context: {
        ask: () => ({}) as any,
      } as any,
    })

    expect(Object.keys(secrets.env).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
    expect(secrets.env.OPENAI_API_KEY.startsWith("DUMMY_")).toBe(true)
    expect(secrets.redactions.length).toBe(2)
  })

  it("brokers and redacts real secret when mode is brokered", async () => {
    const policy = makePolicy()
    policy.profiles.strict.secrets = {
      mode: "brokered",
      allowlist: ["OPENAI_API_KEY"],
      aliases: {},
      dummy_prefix: "DUMMY",
    }

    const previousKey = process.env.OPENAI_API_KEY

    try {
      process.env.OPENAI_API_KEY = "sk-test-real-secret"

      const askMock = mock(() => ({}) as any)
      const secrets = await internal.resolveProfileSecrets({
        policy,
        profileName: "strict",
        profile: policy.profiles.strict,
        context: {
          ask: askMock.mockImplementation(() => Effect.void),
        } as any,
      })

      expect(askMock).toHaveBeenCalledTimes(1)
      expect(secrets.brokered).toEqual(["OPENAI_API_KEY"])
      expect(secrets.redactions.some((rule) => rule.id === "brokered-OPENAI_API_KEY")).toBe(true)
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousKey
      }
    }
  })
})

describe("runtime policy loader", () => {
  it("fails closed for invalid wskr.toml", async () => {
    const tempDir = await Bun.$`mktemp -d`.text()
    const policyFile = `${tempDir.trim()}/wskr.toml`
    await Bun.write(
      policyFile,
      `version = 1

[profiles.strict]
command_policy = "strict"
`,
    )

    const previous = process.env.OPENCODE_SBX_POLICY_FILE
    process.env.OPENCODE_SBX_POLICY_FILE = policyFile

    try {
      await expect(loadRuntimePolicy()).rejects.toThrow("Runtime policy validation failed")
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_SBX_POLICY_FILE
      } else {
        process.env.OPENCODE_SBX_POLICY_FILE = previous
      }
    }
  })

  it("supports compact policy syntax for allow/ask/deny/never arrays", async () => {
    const tempDir = await Bun.$`mktemp -d`.text()
    const policyFile = `${tempDir.trim()}/wskr.toml`
    await Bun.write(
      policyFile,
      `version = 1

[agents.primary]
"*" = "strict"

[agents.subagent]
"*" = "strict"

[command_policies.strict_readonly]
default_action = "deny"
allow = ["git status*", "git diff*"]
ask = ["npm publish*"]
never = ["rm -rf /*"]

[profiles.strict]
command_policy = "strict_readonly"

[profiles.strict.runtime]
image = "alpine:3.20"
workdir = "/workspace"
cpus = 1
memory_mib = 1024
dns = "1.1.1.1"
sandbox_agent_command = "sandbox-agent"
sandbox_agent_args = ["server"]

[[profiles.strict.runtime.mounts]]
host = "{repoRoot}"
guest = "/workspace"
mode = "rw"

[profiles.strict.network]
mode = "deny"
allow_hosts = []

[profiles.strict.secrets]
mode = "dummy"
allowlist = []
dummy_prefix = "DUMMY"

[profiles.strict.secrets.aliases]

[profiles.strict.auth]
stub_env = {}
`,
    )

    const previous = process.env.OPENCODE_SBX_POLICY_FILE
    process.env.OPENCODE_SBX_POLICY_FILE = policyFile

    try {
      const policy = await loadRuntimePolicy()
      const rules = policy.command_policies.strict_readonly.rules
      expect(rules.length).toBe(4)
      expect(rules.some((rule) => rule.match === "git status*" && rule.action === "allow")).toBe(
        true,
      )
      expect(rules.some((rule) => rule.match === "npm publish*" && rule.action === "ask")).toBe(
        true,
      )
      expect(rules.some((rule) => rule.match === "rm -rf /*" && rule.action === "never")).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_SBX_POLICY_FILE
      } else {
        process.env.OPENCODE_SBX_POLICY_FILE = previous
      }
    }
  })

  it("loads valid single-file wskr policy", async () => {
    const policyFile = "/Users/sam10266/byox/runtime/wskr/packages/types/src/wskr.toml"
    const previous = process.env.OPENCODE_SBX_POLICY_FILE
    process.env.OPENCODE_SBX_POLICY_FILE = policyFile

    try {
      const policy = await loadRuntimePolicy()
      expect(policy.version).toBe(1)
      expect(policy.profiles.strict.command_policy).toBeTruthy()
      expect(Object.keys(policy.command_policies).length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_SBX_POLICY_FILE
      } else {
        process.env.OPENCODE_SBX_POLICY_FILE = previous
      }
    }
  })
})
