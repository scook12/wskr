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

  const parsed = WskrPolicySchema.safeParse(parsedRaw)
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
