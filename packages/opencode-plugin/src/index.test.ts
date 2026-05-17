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
    client: {},
    pool: {
      enabled: true,
      max_total_vms: 100,
      per_profile_max_idle: 100,
      idle_ttl_seconds: 3600,
      startup_timeout_seconds: 45,
    },
  }
}

describe("runtime client URL resolution", () => {
  const originalWarn = console.warn

  function withWarnCapture(run: (warn: ReturnType<typeof mock>) => void): void {
    const warn = mock(() => {})
    console.warn = warn as any
    try {
      run(warn)
    } finally {
      console.warn = originalWarn
    }
  }

  it("derives unix socket URL by default", () => {
    const url = internal.deriveKrunClientUrlFromServerEnv({})
    expect(url).toBe("ws+unix:///run/krunvmd.sock:/rpc")
  })

  it("derives tcp URL from server env", () => {
    const url = internal.deriveKrunClientUrlFromServerEnv({
      KRUN_SERVER_TRANSPORT: "tcp",
      KRUN_TCP_HOST: "0.0.0.0",
      KRUN_TCP_PORT: "9988",
    })
    expect(url).toBe("ws://0.0.0.0:9988/rpc")
  })

  it("uses precedence explicit > env override > policy > derived", () => {
    withWarnCapture(() => {
      const policy = makePolicy()
      policy.client = {
        url: "ws://policy-host:1001/rpc",
      }

      const env = {
        OPENCODE_WSKR_CLIENT_URL: "ws://env-host:1002/rpc",
        KRUN_SERVER_TRANSPORT: "tcp",
        KRUN_TCP_HOST: "derived-host",
        KRUN_TCP_PORT: "1003",
      }

      const explicit = internal.resolveRuntimeClientOptions({
        policy,
        explicitClientOptions: { url: "ws://explicit-host:1000/rpc" },
        env,
      })
      expect(explicit.url).toBe("ws://explicit-host:1000/rpc")

      const fromEnv = internal.resolveRuntimeClientOptions({
        policy,
        env,
      })
      expect(fromEnv.url).toBe("ws://env-host:1002/rpc")

      const fromPolicy = internal.resolveRuntimeClientOptions({
        policy,
        env: {
          KRUN_SERVER_TRANSPORT: "tcp",
          KRUN_TCP_HOST: "derived-host",
          KRUN_TCP_PORT: "1003",
        },
      })
      expect(fromPolicy.url).toBe("ws://policy-host:1001/rpc")

      const fromDerived = internal.resolveRuntimeClientOptions({
        policy: {
          ...policy,
          client: {},
        },
        env: {
          KRUN_SERVER_TRANSPORT: "tcp",
          KRUN_TCP_HOST: "derived-host",
          KRUN_TCP_PORT: "1003",
        },
      })
      expect(fromDerived.url).toBe("ws://derived-host:1003/rpc")
    })
  })

  it("warns for insecure remote ws:// runtime client URLs", () => {
    withWarnCapture((warn) => {
      const policy = makePolicy()
      const fromPolicy = internal.resolveRuntimeClientOptions({
        policy: {
          ...policy,
          client: { url: "ws://remote-host:8877/rpc" },
        },
      })
      expect(fromPolicy.url).toBe("ws://remote-host:8877/rpc")
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  it("does not warn for local ws:// runtime client URLs", () => {
    withWarnCapture((warn) => {
      internal.maybeWarnInsecureRuntimeClientUrl("ws://127.0.0.1:8877/rpc", {})
      internal.maybeWarnInsecureRuntimeClientUrl("ws://localhost:8877/rpc", {})
      expect(warn).toHaveBeenCalledTimes(0)
    })
  })

  it("allows warning to be silenced via env override", () => {
    withWarnCapture((warn) => {
      internal.maybeWarnInsecureRuntimeClientUrl("ws://remote-host:8877/rpc", {
        OPENCODE_WSKR_SILENCE_INSECURE_WS_WARNING: "1",
      })
      expect(warn).toHaveBeenCalledTimes(0)
    })
  })
})

function createToolContext(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    worktree: "/repo",
    directory: "/repo",
    ask: () => Effect.void,
    ...overrides,
  } as any
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
    expect(resolved).toEqual(["/Users/test/repo:/workspace"])
  })

  it("accepts mount mode omission and defaults to readonly semantics", () => {
    const mounts = [{ host: "{repoRoot}", guest: "/workspace" }]
    const resolved = internal.resolveVolumeMounts(mounts as any, "/Users/test/repo")
    expect(resolved).toEqual(["/Users/test/repo:/workspace"])
  })

  it("builds krunvm-compatible create ports as host:guest", async () => {
    const policy = makePolicy()
    const spec = await internal.buildWskrResolvedSpec({
      profileName: "strict",
      profileHash: "hash123",
      policy,
      context: createToolContext({ worktree: "/repo", directory: "/repo" }),
      token: "token-1",
    })

    expect(spec.create.ports.length).toBe(1)
    expect(spec.create.ports[0]).toMatch(/^\d{1,5}:\d{1,5}$/)
    expect(spec.create.ports[0]?.includes("/")).toBe(false)
  })

  it("rejects policy with invalid mount guest path shape", async () => {
    const invalidToml = `
version = 1

[agents.primary]
"*" = "strict"

[agents.subagent]
"*" = "strict"

[command_policies.strict_readonly]
default_action = "deny"

[profiles.strict]
command_policy = "strict_readonly"

[profiles.strict.runtime]
image = "alpine:3.20"
workdir = "/workspace"
cpus = 1
memory_mib = 512
dns = "1.1.1.1"
sandbox_agent_command = "sandbox-agent"
sandbox_agent_args = ["server"]

[[profiles.strict.runtime.mounts]]
host = "{repoRoot}"
guest = "/workspace/subdir"

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
`

    const dir = `/tmp/wskr-policy-invalid-${Date.now()}`
    const policyPath = `${dir}/wskr.toml`
    await Bun.write(policyPath, invalidToml)

    const previousPolicyFile = process.env.OPENCODE_SBX_POLICY_FILE
    process.env.OPENCODE_SBX_POLICY_FILE = policyPath
    try {
      await expect(loadRuntimePolicy()).rejects.toThrow(
        "mount guest must be a root child path like '/workspace'",
      )
    } finally {
      if (previousPolicyFile === undefined) {
        delete process.env.OPENCODE_SBX_POLICY_FILE
      } else {
        process.env.OPENCODE_SBX_POLICY_FILE = previousPolicyFile
      }
    }
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

describe("audit command minimization", () => {
  it("hashes command and redacts preview", () => {
    const policy = makePolicy()
    policy.redaction.rules = [
      {
        id: "api-token",
        pattern: "sk-[A-Za-z0-9]+",
        replacement: "[REDACTED]",
      },
    ]

    const command = "curl -H 'Authorization: Bearer sk-abc123' https://example.com"
    const fields = internal.buildAuditCommandFields(command, policy)

    expect(fields.normalized_command_hash).toHaveLength(64)
    expect(fields.normalized_command_preview).toContain("[REDACTED]")
    expect(fields.normalized_command_preview).not.toContain("sk-abc123")
    expect(fields.normalized_command).toBe(fields.normalized_command_preview)
  })

  it("caps preview length to avoid over-logging", () => {
    const policy = makePolicy()
    const longCommand = `echo ${"a".repeat(1000)}`
    const fields = internal.buildAuditCommandFields(longCommand, policy)
    expect(fields.normalized_command_preview.length).toBe(200)
  })
})

describe("plugin pool and teardown", () => {
  it("removes failed pending entry and retries creation", async () => {
    const policy = makePolicy()
    let createCount = 0

    const deps = {
      createClient: async () => {
        createCount += 1
        throw new Error("boot failed")
      },
    }

    const context = createToolContext({ worktree: "/repo/fail", directory: "/repo/fail" })
    await expect(internal.getSandboxClient("strict", policy, context, deps)).rejects.toThrow(
      "boot failed",
    )
    await expect(internal.getSandboxClient("strict", policy, context, deps)).rejects.toThrow(
      "boot failed",
    )

    expect(createCount).toBe(2)
  })

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

  it("fails closed when broker approval rejects", async () => {
    const policy = makePolicy()
    policy.profiles.strict.secrets = {
      mode: "brokered",
      allowlist: ["OPENAI_API_KEY"],
      aliases: {},
      dummy_prefix: "DUMMY",
    }

    await expect(
      internal.resolveProfileSecrets({
        policy,
        profileName: "strict",
        profile: policy.profiles.strict,
        context: {
          ask: () => Effect.fail(new Error("user denied")),
        } as any,
      }),
    ).rejects.toThrow("user denied")
  })
})

describe("plugin execution backend", () => {
  it("reconnects after stream error and succeeds", async () => {
    const policy = makePolicy()
    const context = createToolContext({ worktree: "/repo/reconnect", directory: "/repo/reconnect" })
    const isolatedProfile = `strict-${Date.now()}-reconnect`
    policy.profiles[isolatedProfile] = structuredClone(policy.profiles.strict)

    const runCalls: string[] = []
    let firstHandle = true

    const poolDeps = {
      createClient: async ({ key, profileName, profileHash }: any) => {
        const client = {
          runProcess: async (input: { cwd: string }) => {
            runCalls.push(input.cwd)
            if (firstHandle) {
              firstHandle = false
              throw new Error("stream error: connection dropped")
            }

            return {
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              durationMs: 5,
              stdoutTruncated: false,
              stderrTruncated: false,
            }
          },
          dispose: async () => {},
          destroySandbox: async () => {},
        } as any

        return {
          client,
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose" as const,
        }
      },
    }

    try {
      const result = await internal.runCommandWithSandboxAgent({
        command: "git status --short",
        timeout: 10_000,
        resolvedProfile: {
          agentName: "build",
          profile: isolatedProfile,
          isSubAgent: false,
          commandPolicyName: policy.profiles[isolatedProfile].command_policy,
        },
        policy,
        context,
        poolDeps,
      })

      expect(result.output).toContain("ok")
      expect(runCalls.length).toBeGreaterThanOrEqual(2)
    } finally {
      // no shared test hooks/state reset required
    }
  })

  it("falls back to alternate cwd when first cwd fails", async () => {
    const policy = makePolicy()
    const context = createToolContext({
      worktree: "/repo/alt",
      directory: "/repo/alt/subdir",
    })
    const isolatedProfile = `strict-${Date.now()}-altcwd`
    policy.profiles[isolatedProfile] = structuredClone(policy.profiles.strict)

    const attemptedCwds: string[] = []

    const poolDeps = {
      createClient: async ({ key, profileName, profileHash }: any) => {
        const client = {
          runProcess: async (input: { cwd: string }) => {
            attemptedCwds.push(input.cwd)
            if (input.cwd === "/workspace") {
              throw new Error("cwd missing")
            }

            return {
              stdout: "ok-alt",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              durationMs: 7,
              stdoutTruncated: false,
              stderrTruncated: false,
            }
          },
          dispose: async () => {},
          destroySandbox: async () => {},
        } as any

        return {
          client,
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose" as const,
        }
      },
    }

    try {
      const result = await internal.runCommandWithSandboxAgent({
        command: "git status --short",
        timeout: 10_000,
        resolvedProfile: {
          agentName: "build",
          profile: isolatedProfile,
          isSubAgent: false,
          commandPolicyName: policy.profiles[isolatedProfile].command_policy,
        },
        policy,
        context,
        poolDeps,
      })

      expect(result.output).toContain("ok-alt")
      expect(attemptedCwds[0]).toBe("/workspace")
      expect(attemptedCwds.includes("/repo/alt/subdir")).toBe(true)
    } finally {
      // no shared test hooks/state reset required
    }
  })

  it("throws when no cwd candidate succeeds", async () => {
    const policy = makePolicy()
    const context = createToolContext({
      worktree: "/repo/fail-all",
      directory: "/repo/fail-all/subdir",
    })
    const isolatedProfile = `strict-${Date.now()}-allfail`
    policy.profiles[isolatedProfile] = structuredClone(policy.profiles.strict)

    const poolDeps = {
      createClient: async ({ key, profileName, profileHash }: any) => {
        const client = {
          runProcess: async () => {
            throw new Error("all cwd failed")
          },
          dispose: async () => {},
          destroySandbox: async () => {},
        } as any

        return {
          client,
          key,
          profile: profileName,
          profileHash,
          bootedAtMs: Date.now(),
          teardown: "dispose" as const,
        }
      },
    }

    try {
      await expect(
        internal.runCommandWithSandboxAgent({
          command: "git status --short",
          timeout: 10_000,
          resolvedProfile: {
            agentName: "build",
            profile: isolatedProfile,
            isSubAgent: false,
            commandPolicyName: policy.profiles[isolatedProfile].command_policy,
          },
          policy,
          context,
          poolDeps,
        }),
      ).rejects.toThrow("all cwd failed")
    } finally {
      // no shared test hooks/state reset required
    }
  })
})

describe("plugin execute behavior", () => {
  it("denies command and emits denial message for never rule", async () => {
    const policy = makePolicy()
    const context = createToolContext()

    await expect(
      internal.executePolicyBashCommand({
        args: { command: "rm -rf /*" },
        context,
        deps: {
          loadPolicy: async () => policy,
          backend: {
            kind: "sandbox-agent",
            run: async () => {
              throw new Error("backend should not run on deny")
            },
          },
        },
      }),
    ).rejects.toThrow("non-overridable runtime policy rule")
  })

  it("requests approval when decision is ask and executes backend", async () => {
    const policy = makePolicy()
    policy.agents.primary.release = "release"
    const asked: unknown[] = []
    const context = createToolContext({
      agent: "release",
      ask: (input: unknown) => {
        asked.push(input)
        return Effect.void
      },
    })

    const result = await internal.executePolicyBashCommand({
      args: { command: "npm publish" },
      context,
      deps: {
        loadPolicy: async () => policy,
        backend: {
          kind: "sandbox-agent",
          run: async () => ({
            output: "ok",
            metadata: { sandboxBootMs: 1 },
            exitCode: 0,
            sandboxId: "sandbox-1",
            durationMs: 10,
          }),
        },
      },
    })

    expect(asked.length).toBe(1)
    expect(typeof result).toBe("object")
    expect((result as any).output).toBe("ok")
  })

  it("records backend errors in execution path", async () => {
    const policy = makePolicy()
    const context = createToolContext()

    await expect(
      internal.executePolicyBashCommand({
        args: { command: "git status --short" },
        context,
        deps: {
          loadPolicy: async () => policy,
          backend: {
            kind: "sandbox-agent",
            run: async () => {
              throw new Error("backend exploded")
            },
          },
        },
      }),
    ).rejects.toThrow("backend exploded")
  })

  it("rejects empty command before policy/backend execution", async () => {
    const context = createToolContext()
    await expect(
      internal.executePolicyBashCommand({
        args: { command: "    " },
        context,
        deps: {
          loadPolicy: async () => {
            throw new Error("should not load")
          },
          backend: {
            kind: "sandbox-agent",
            run: async () => {
              throw new Error("should not run")
            },
          },
        },
      }),
    ).rejects.toThrow("Command must not be empty")
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

[client]
url = "ws+unix:///tmp/wskr-test.sock:/rpc"

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
      expect(policy.client.url).toBe("ws+unix:///tmp/wskr-test.sock:/rpc")
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

  it("fails closed for invalid compact rule entries", async () => {
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
allow = [123]

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
      await expect(loadRuntimePolicy()).rejects.toThrow("Invalid compact 'allow' rule entry")
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_SBX_POLICY_FILE
      } else {
        process.env.OPENCODE_SBX_POLICY_FILE = previous
      }
    }
  })

  it("fails closed when compact action field is not an array", async () => {
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
allow = "git status*"

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
      await expect(loadRuntimePolicy()).rejects.toThrow(
        "command_policies.strict_readonly.allow must be an array",
      )
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
