import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { WskrPolicySchema, type RuntimePolicy } from "@wskr/types"

const DEFAULT_POLICY_FILE = resolve(homedir(), ".config", "opencode", "wskr.toml")

function getPolicyFilePath(): string {
  const configuredPath = process.env.OPENCODE_SBX_POLICY_FILE ?? DEFAULT_POLICY_FILE
  return resolve(configuredPath)
}

async function ensureReadableFile(path: string): Promise<void> {
  await access(path, constants.R_OK)
}

type RawPolicyRecord = Record<string, unknown>

type CompactRuleAction = "allow" | "ask" | "deny" | "never"

type NormalizedRule = {
  id: string
  match: string
  action: CompactRuleAction
}

function isObjectRecord(value: unknown): value is RawPolicyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toRuleId(base: string, index: number, usedIds: Set<string>): string {
  const seed = `${base}_${index + 1}`
  if (!usedIds.has(seed)) {
    usedIds.add(seed)
    return seed
  }

  let suffix = 2
  while (usedIds.has(`${seed}_${suffix}`)) {
    suffix += 1
  }

  const id = `${seed}_${suffix}`
  usedIds.add(id)
  return id
}

function normalizeCompactRuleEntry(
  value: unknown,
  action: CompactRuleAction,
  index: number,
  usedIds: Set<string>,
): NormalizedRule {
  if (typeof value === "string") {
    return {
      id: toRuleId(action, index, usedIds),
      match: value,
      action,
    }
  }

  if (isObjectRecord(value) && typeof value.match === "string") {
    const explicitId = typeof value.id === "string" ? value.id : undefined
    const id = explicitId ? toRuleId(explicitId, index, usedIds) : toRuleId(action, index, usedIds)
    return {
      id,
      match: value.match,
      action,
    }
  }

  throw new Error(`Invalid compact '${action}' rule entry at index ${index}`)
}

function normalizeExplicitRuleEntry(
  value: unknown,
  index: number,
  usedIds: Set<string>,
): NormalizedRule {
  if (
    isObjectRecord(value) &&
    typeof value.match === "string" &&
    typeof value.action === "string" &&
    ["allow", "ask", "deny", "never"].includes(value.action)
  ) {
    const explicitId = typeof value.id === "string" ? value.id : undefined
    const id = explicitId ? toRuleId(explicitId, index, usedIds) : toRuleId("rule", index, usedIds)
    return {
      id,
      match: value.match,
      action: value.action as CompactRuleAction,
    }
  }

  throw new Error(`Invalid command policy rule entry at index ${index}`)
}

function normalizeCommandPolicy(policyName: string, rawPolicy: unknown): RawPolicyRecord {
  if (!isObjectRecord(rawPolicy)) {
    throw new Error(`command_policies.${policyName} must be an object`)
  }

  const usedIds = new Set<string>()
  const normalizedRules: NormalizedRule[] = []

  const explicitRules = rawPolicy.rules
  if (explicitRules !== undefined) {
    if (!Array.isArray(explicitRules)) {
      throw new Error(`command_policies.${policyName}.rules must be an array`)
    }
    for (let i = 0; i < explicitRules.length; i += 1) {
      normalizedRules.push(normalizeExplicitRuleEntry(explicitRules[i], i, usedIds))
    }
  }

  const compactActionKeys: CompactRuleAction[] = ["allow", "ask", "deny", "never"]
  for (const action of compactActionKeys) {
    const compactRules = rawPolicy[action]
    if (compactRules === undefined) {
      continue
    }

    if (!Array.isArray(compactRules)) {
      throw new Error(`command_policies.${policyName}.${action} must be an array`)
    }

    for (let i = 0; i < compactRules.length; i += 1) {
      normalizedRules.push(normalizeCompactRuleEntry(compactRules[i], action, i, usedIds))
    }
  }

  const defaultAction =
    typeof rawPolicy.default_action === "string" ? rawPolicy.default_action : "deny"

  return {
    ...rawPolicy,
    default_action: defaultAction,
    rules: normalizedRules,
  }
}

function normalizePolicy(rawPolicy: unknown): unknown {
  if (!isObjectRecord(rawPolicy)) {
    return rawPolicy
  }

  const commandPolicies = rawPolicy.command_policies
  if (!isObjectRecord(commandPolicies)) {
    return rawPolicy
  }

  const normalizedCommandPolicies: RawPolicyRecord = {}
  for (const [policyName, value] of Object.entries(commandPolicies)) {
    normalizedCommandPolicies[policyName] = normalizeCommandPolicy(policyName, value)
  }

  return {
    ...rawPolicy,
    command_policies: normalizedCommandPolicies,
  }
}

export async function loadRuntimePolicy(): Promise<RuntimePolicy> {
  const policyFilePath = getPolicyFilePath()

  try {
    await ensureReadableFile(policyFilePath)
  } catch {
    throw new Error(`Unable to read runtime policy file: ${policyFilePath}`)
  }

  let parsedRaw: unknown
  try {
    const content = await Bun.file(policyFilePath).text()
    parsedRaw = Bun.TOML.parse(content)
  } catch (error) {
    throw new Error(
      `Invalid TOML in runtime policy file '${policyFilePath}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const normalizedRaw = normalizePolicy(parsedRaw)

  const parsed = WskrPolicySchema.safeParse(normalizedRaw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const issuePath = issue?.path?.join(".") || "(root)"
    throw new Error(
      `Runtime policy validation failed at '${issuePath}': ${issue?.message ?? "invalid runtime policy"}`,
    )
  }

  const policy = parsed.data

  if (!policy.profiles.strict) {
    throw new Error("Runtime policy must include 'profiles.strict'.")
  }

  for (const [profileName, profile] of Object.entries(policy.profiles)) {
    if (!policy.command_policies[profile.command_policy]) {
      throw new Error(
        `Profile '${profileName}' references unknown command policy '${profile.command_policy}'.`,
      )
    }
  }

  return {
    ...policy,
    policyFilePath,
    policyDir: dirname(policyFilePath),
  }
}
