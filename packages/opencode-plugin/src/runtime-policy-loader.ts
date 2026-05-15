import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import type { RuntimePolicy } from "@wskr/types"

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "opencode", "runtime-policy")

async function getRuntimeConfigPath() {
  const configuredPath = process.env.OPENCODE_SBX_POLICY_DIR ?? DEFAULT_CONFIG_PATH
  const path = resolve(configuredPath)
  try {
    await access(path, constants.R_OK | constants.X_OK)
    return { path, access: true }
  } catch {
    return { path, access: false }
  }
}

function getPolicyConfigKey(filename: string): string {
  switch (filename) {
    case "agent-map.toml":
      return "agentMap"
    case "audit.toml":
      return "audit"
    case "command-policies.toml":
      return "commandPolicies"
    case "defaults.toml":
      return "defaults"
    case "profiles.toml":
      return "profiles"
    case "redaction.toml":
      return "redaction"
    case "secrets.toml":
      return "secrets"
    case "transitions.toml":
      return "transitions"
    case "vm-pool.toml":
      return "vmPool"
    default:
      return ""
  }
}

async function parseTomlFile(fileName: string) {
  const file = Bun.file(fileName)
  const content = await file.text()
  return Bun.TOML.parse(content)
}

function getTomlSource(input: any, key: string): any {
  if (input == null || typeof input !== "object") {
    return {}
  }

  return input[key] ?? input
}

function mapDefaults(input: any): RuntimePolicy["defaults"] {
  const defaults = getTomlSource(input, "defaults")
  return {
    requireSandboxForBash: defaults.require_sandbox_for_bash ?? true,
    failClosed: defaults.fail_closed ?? true,
    unknownAgentProfile: defaults.unknown_agent_profile ?? "strict",
    unknownSubagentProfile: defaults.unknown_subagent_profile ?? "strict",
    subagentInheritsParentProfile: defaults.subagent_inherits_parent_profile ?? false,
    profileResolutionOrder: defaults.profile_resolution_order ?? [
      "explicit_subagent_map",
      "explicit_primary_agent_map",
      "strict_default",
    ],
  }
}

function mapVmPool(input: any): RuntimePolicy["vmPool"] {
  const vmPool = getTomlSource(input, "vm_pool")
  const phase2TestOverrides = getTomlSource(input, "phase2_test_overrides")
  const hasOverrides =
    phase2TestOverrides &&
    typeof phase2TestOverrides === "object" &&
    Object.keys(phase2TestOverrides).length > 0
  return {
    enabled: vmPool.enabled ?? true,
    maxTotalVms: vmPool.max_total_vms ?? 6,
    perProfileMaxIdle: vmPool.per_profile_max_idle ?? 2,
    idleTtlSeconds: vmPool.idle_ttl_seconds ?? 1200,
    startupTimeoutSeconds: vmPool.startup_timeout_seconds ?? 45,
    reuse_key: vmPool.reuse_key ?? [],
    phase2TestOverrides: hasOverrides
      ? {
          enabled: phase2TestOverrides.enabled ?? false,
          idle_ttl_seconds: phase2TestOverrides.idle_ttl_seconds ?? 1200,
        }
      : undefined,
  }
}

function mapAudit(input: any, policyDir: string): RuntimePolicy["audit"] {
  const audit = getTomlSource(input, "audit")
  return {
    enabled: true,
    sink: audit.sink ?? "file",
    path: audit.path ?? join(policyDir, "runtime-policy-audit.ndjson"),
    include: audit.include ?? [
      "timestamp",
      "session_id",
      "message_id",
      "agent_name",
      "is_subagent",
      "resolved_profile",
      "normalized_command",
      "decision",
      "decision_reason",
      "vm_id",
      "vm_booted_at_ms",
      "exit_code",
      "duration_ms",
    ],
  }
}

function mapSecrets(input: any): RuntimePolicy["secrets"] {
  const secrets = getTomlSource(input, "secrets")
  return {
    mode: secrets.mode ?? "none",
    forceNoneWhenUntrustedInput: secrets.force_none_when_untrusted_input ?? true,
    classes: secrets.classes ?? {},
  }
}

function mapRedaction(input: any): RuntimePolicy["redaction"] {
  const redaction = getTomlSource(input, "redaction")
  return {
    enabled: redaction.enabled ?? true,
    fail_mode: redaction.fail_mode ?? "block",
    rules: redaction.rules ?? [],
  }
}

function mapTransitions(input: any): RuntimePolicy["transitions"] {
  const transitions = getTomlSource(input, "transitions")
  return {
    enabled: transitions.enabled ?? true,
    default_action: transitions.default_action ?? "deny",
    rules: transitions.rules ?? [],
  }
}

function mapAgentMap(input: any): RuntimePolicy["agentMap"] {
  const source = getTomlSource(input, "agent_map")
  return {
    primary: source.primary ?? { "*": "strict" },
    subagent: source.subagent ?? { "*": "strict" },
  }
}

function validateRuntimePolicy(policy: RuntimePolicy): void {
  if (!policy.profiles.strict) {
    throw new Error("Runtime policy must include 'profiles.strict'.")
  }

  for (const [profileName, profile] of Object.entries(policy.profiles)) {
    if (!profile.command_policy) {
      throw new Error(`Profile '${profileName}' is missing command_policy.`)
    }

    if (!policy.commandPolicies[profile.command_policy]) {
      throw new Error(
        `Profile '${profileName}' references unknown command policy '${profile.command_policy}'.`,
      )
    }
  }
}

export async function loadRuntimePolicy(): Promise<RuntimePolicy> {
  const { path, access } = await getRuntimeConfigPath()
  if (!access) throw new Error("Unable to access runtime policy directory")
  const policyFiles = await readdir(path, { recursive: true })
  const policy: RuntimePolicy = {
    version: 1,
    policyDir: path,
    agentMap: {
      primary: { "*": "strict" },
      subagent: { "*": "strict" },
    },
    audit: {
      enabled: true,
      sink: "file",
      path: join(path, "runtime-policy-audit.ndjson"),
      include: [],
    },
    commandPolicies: {},
    defaults: {
      requireSandboxForBash: true,
      failClosed: true,
      unknownAgentProfile: "strict",
      unknownSubagentProfile: "strict",
      subagentInheritsParentProfile: false,
      profileResolutionOrder: [
        "explicit_subagent_map",
        "explicit_primary_agent_map",
        "strict_default",
      ],
    },
    profiles: {},
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
      maxTotalVms: 6,
      perProfileMaxIdle: 2,
      idleTtlSeconds: 1200,
      startupTimeoutSeconds: 45,
      reuse_key: [],
    },
  }

  for (const relativeFile of policyFiles) {
    if (!relativeFile.endsWith(".toml")) continue
    const key = getPolicyConfigKey(basename(relativeFile))
    if (key) {
      const absolutePath = isAbsolute(relativeFile) ? relativeFile : join(path, relativeFile)
      const parsed = await parseTomlFile(absolutePath)
      switch (key) {
        case "agentMap":
          policy.agentMap = mapAgentMap(parsed)
          break
        case "audit":
          policy.audit = mapAudit(parsed, path)
          break
        case "commandPolicies":
          policy.commandPolicies = getTomlSource(parsed, "command_policies")
          break
        case "defaults":
          policy.defaults = mapDefaults(parsed)
          break
        case "profiles":
          policy.profiles = getTomlSource(parsed, "profiles")
          break
        case "redaction":
          policy.redaction = mapRedaction(parsed)
          break
        case "secrets":
          policy.secrets = mapSecrets(parsed)
          break
        case "transitions":
          policy.transitions = mapTransitions(parsed)
          break
        case "vmPool":
          policy.vmPool = mapVmPool(parsed)
          break
      }
    }
  }

  validateRuntimePolicy(policy)

  return policy
}
