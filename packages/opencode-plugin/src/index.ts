import { tool, ToolDefinition, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { SandboxAgent } from "sandbox-agent"
import { local } from "sandbox-agent/local"
import { wskr, type WskrResolvedSandboxSpec } from "@wskr/provider"
import { createHash } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { type RuleAction, type RuntimePolicy, type WskrProfile } from "@wskr/types"
import { loadRuntimePolicy } from "./runtime-policy-loader"

type Profile = string

type ResolvedProfile = {
  agentName: string
  profile: Profile
  isSubAgent: boolean
  commandPolicyName: string
}

type DecisionReason = "rule" | "never" | "default"

type CommandDecision = {
  action: RuleAction
  ruleId: string
  reason: DecisionReason
}

type SandboxClientHandle = {
  client: SandboxAgent
  key: string
  profile: string
  profileHash: string
  bootedAtMs: number
  teardown: "dispose" | "destroySandbox"
}

type SandboxClientPoolEntry = {
  key: string
  profile: string
  profileHash: string
  lastUsedAt: number
  pending: Promise<SandboxClientHandle>
}

type SandboxClientFactory = (options: {
  profileName: string
  profileHash: string
  policy: RuntimePolicy
  context: ToolContext
  key: string
}) => Promise<SandboxClientHandle>

type MountConfig = RuntimePolicy["profiles"][string]["runtime"]["mounts"][number]

type SandboxPoolDeps = {
  createClient?: SandboxClientFactory
}

type ExecutionResult = {
  output: string
  metadata: Record<string, unknown>
  exitCode: number | null
  sandboxId: string
  durationMs: number
}

type ResolvedSecrets = {
  env: Record<string, string>
  redactions: Array<{ id: string; pattern: string; replacement: string }>
  brokered: string[]
}

type ResolvedNetworkDecision = {
  mode: WskrProfile["network"]["mode"]
  usesNetwork: boolean
  hosts: string[]
}

const NETWORK_COMMAND_NAMES = new Set([
  "curl",
  "wget",
  "ping",
  "nc",
  "ncat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "ftp",
])

type ExecutionBackend = {
  kind: "sandbox-agent"
  run: (options: {
    command: string
    timeout: number
    resolvedProfile: ResolvedProfile
    policy: RuntimePolicy
    context: ToolContext
  }) => Promise<ExecutionResult>
}

type ExecuteDeps = {
  loadPolicy: () => Promise<RuntimePolicy>
  backend: ExecutionBackend
}

type AuditRecord = {
  timestamp: string
  session_id: string
  message_id: string
  agent_name: string
  is_subagent: boolean
  resolved_profile: string
  normalized_command: string
  normalized_command_hash: string
  normalized_command_preview: string
  decision: string
  decision_reason: string
  vm_id: string
  vm_booted_at_ms: number | null
  exit_code: number | null
  duration_ms: number | null
}

const sandboxClients = new Map<string, SandboxClientPoolEntry>()
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_SANDBOX_AGENT_HOST = "127.0.0.1"
const DEFAULT_SANDBOX_AGENT_PORT = 3000
const DEFAULT_SANDBOX_AGENT_BIN = "sandbox-agent"
const SANDBOX_START_MAX_ATTEMPTS = 3
const SANDBOX_START_RETRY_DELAY_MS = 150
const DEFAULT_KRUN_SOCKET_PATH = "/run/krunvmd.sock"
const DEFAULT_KRUN_TCP_HOST = "127.0.0.1"
const DEFAULT_KRUN_TCP_PORT = 8877

type RuntimeClientOptions = {
  url?: string
}

type EnvMap = Record<string, string | undefined>

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function hashShort(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12)
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function toUnixSocketWebSocketUrl(socketPath: string): string {
  return `ws+unix://${socketPath}:/rpc`
}

function deriveKrunClientUrlFromServerEnv(env: EnvMap = process.env): string {
  const transport = normalizeNonEmpty(env.KRUN_SERVER_TRANSPORT) ?? "unix"
  if (transport === "tcp") {
    const host = normalizeNonEmpty(env.KRUN_TCP_HOST) ?? DEFAULT_KRUN_TCP_HOST
    const port = parseBoundedInt(env.KRUN_TCP_PORT, DEFAULT_KRUN_TCP_PORT, 1, 65535)
    return `ws://${host}:${port}/rpc`
  }

  if (transport === "unix") {
    const socketPath = normalizeNonEmpty(env.KRUN_SOCKET_PATH) ?? DEFAULT_KRUN_SOCKET_PATH
    return toUnixSocketWebSocketUrl(socketPath)
  }

  throw new Error("KRUN_SERVER_TRANSPORT must be 'unix' or 'tcp' when deriving WSKR client URL")
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function maybeWarnInsecureRuntimeClientUrl(url: string, env: EnvMap = process.env): void {
  const trimmed = url.trim()
  if (!trimmed.startsWith("ws://")) {
    return
  }

  let hostname = ""
  try {
    const parsed = new URL(trimmed)
    hostname = parsed.hostname
  } catch {
    const withoutScheme = trimmed.slice("ws://".length)
    hostname = withoutScheme.split("/")[0]?.split(":")[0] ?? ""
  }

  if (isLocalHost(hostname)) {
    return
  }

  if (normalizeNonEmpty(env.OPENCODE_WSKR_SILENCE_INSECURE_WS_WARNING) === "1") {
    return
  }

  console.warn(
    `[wskr] Warning: runtime client URL '${trimmed}' uses insecure remote ws:// transport; prefer wss:// or unix socket transport.`,
  )
}

function resolveRuntimeClientOptions(options: {
  policy: RuntimePolicy
  explicitClientOptions?: RuntimeClientOptions
  env?: EnvMap
}): RuntimeClientOptions {
  const env = options.env ?? process.env
  const explicitUrl = normalizeNonEmpty(options.explicitClientOptions?.url)
  if (explicitUrl) {
    maybeWarnInsecureRuntimeClientUrl(explicitUrl, env)
    return { url: explicitUrl }
  }

  const envOverrideUrl = normalizeNonEmpty(env.OPENCODE_WSKR_CLIENT_URL)
  if (envOverrideUrl) {
    maybeWarnInsecureRuntimeClientUrl(envOverrideUrl, env)
    return { url: envOverrideUrl }
  }

  const policyUrl = normalizeNonEmpty(options.policy.client.url)
  if (policyUrl) {
    maybeWarnInsecureRuntimeClientUrl(policyUrl, env)
    return { url: policyUrl }
  }

  const derivedUrl = deriveKrunClientUrlFromServerEnv(env)
  maybeWarnInsecureRuntimeClientUrl(derivedUrl, env)
  return {
    url: derivedUrl,
  }
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const wildcarded = escaped.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${wildcarded}$`)
}

function matchPattern(command: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(command)
}

function resolveAgentProfile(agentName: string, policy: RuntimePolicy): ResolvedProfile {
  const { primary, subagent } = policy.agents
  const subagentProfile = subagent[agentName]
  const primaryProfile = primary[agentName]
  const wildcardSubagent = subagent["*"]
  const wildcardPrimary = primary["*"]

  const isSubAgent = subagentProfile != null
  const profile = isSubAgent
    ? (subagentProfile ?? wildcardSubagent ?? "strict")
    : (primaryProfile ?? wildcardPrimary ?? "strict")

  const profileConfig = policy.profiles[profile]
  const commandPolicyName = profileConfig?.command_policy
  if (!commandPolicyName) {
    throw new Error(`Profile '${profile}' is missing command policy configuration.`)
  }

  return {
    agentName,
    profile: profile as Profile,
    isSubAgent,
    commandPolicyName,
  }
}

function evaluateCommandPolicy(
  command: string,
  policyName: string,
  policy: RuntimePolicy,
): CommandDecision {
  const commandPolicy = policy.command_policies[policyName]
  if (!commandPolicy) {
    return { action: "deny", ruleId: "missing_policy", reason: "default" }
  }

  const normalized = normalizeCommand(command)
  let decision: CommandDecision = {
    action: commandPolicy.default_action,
    ruleId: "policy_default",
    reason: "default",
  }

  for (const rule of commandPolicy.rules ?? []) {
    if (!matchPattern(normalized, rule.match)) {
      continue
    }

    if (rule.action === "never") {
      return {
        action: "deny",
        ruleId: rule.id,
        reason: "never",
      }
    }

    decision = {
      action: rule.action,
      ruleId: rule.id,
      reason: "rule",
    }
  }

  return decision
}

function getProfileHash(profileName: string, policy: RuntimePolicy): string {
  const profileConfig = policy.profiles[profileName]
  if (!profileConfig) {
    return hashShort(profileName)
  }

  return hashShort(stableStringify(profileConfig))
}

function buildLocalProviderEnv(): Record<string, string> {
  const passthrough = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENCODE_SANDBOX_AGENT_TOKEN",
  ]

  const env: Record<string, string> = {}
  for (const key of passthrough) {
    const value = process.env[key]
    if (value) {
      env[key] = value
    }
  }

  return env
}

function computeDummySecretValue(
  secretKey: string,
  policy: RuntimePolicy,
  profileName: string,
): string {
  return `${secretKey}_${policy.version}_${hashShort(profileName)}_${hashShort(secretKey)}`
}

async function resolveSecretValue(
  aliasOrEnvKey: string,
  context: ToolContext,
): Promise<string | undefined> {
  await Effect.runPromise(
    context.ask({
      permission: "wskr.secret",
      patterns: [aliasOrEnvKey],
      always: [aliasOrEnvKey],
      metadata: {
        reason: "secret_broker_request",
        key: aliasOrEnvKey,
      },
    }),
  )

  return process.env[aliasOrEnvKey]
}

async function resolveProfileSecrets(options: {
  policy: RuntimePolicy
  profileName: string
  profile: WskrProfile
  context: ToolContext
}): Promise<ResolvedSecrets> {
  const { policy, profileName, profile, context } = options
  const env: Record<string, string> = {}
  const redactions: Array<{ id: string; pattern: string; replacement: string }> = []
  const brokered: string[] = []

  if (profile.secrets.mode === "none") {
    return { env, redactions, brokered }
  }

  for (const key of profile.secrets.allowlist) {
    const envKey = profile.secrets.aliases[key] ?? key
    let realValue: string | undefined
    if (profile.secrets.mode === "brokered") {
      realValue = await resolveSecretValue(key, context)
      brokered.push(key)
    }

    const dummyValue = `${profile.secrets.dummy_prefix}_${computeDummySecretValue(key, policy, profileName)}`
    env[envKey] = dummyValue

    if (realValue && realValue.length > 0) {
      redactions.push({
        id: `brokered-${key}`,
        pattern: realValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        replacement: "[REDACTED]",
      })
    }

    redactions.push({
      id: `dummy-${key}`,
      pattern: dummyValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      replacement: "[REDACTED]",
    })
  }

  return { env, redactions, brokered }
}

function assertNetworkPolicyEnforceable(profile: WskrProfile): void {
  if (profile.network.mode === "allowlist" && profile.network.allow_hosts.length === 0) {
    throw new Error("network.allow_hosts must not be empty when network.mode is 'allowlist'")
  }
}

function parseCommandTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

function extractLikelyHosts(command: string): string[] {
  const hosts = new Set<string>()
  const urlRegex = /https?:\/\/([^\s/:?#]+)(?::\d+)?(?:[/?#]|$)/gi
  let match: RegExpExecArray | null = urlRegex.exec(command)
  while (match) {
    if (match[1]) {
      hosts.add(match[1].toLowerCase())
    }
    match = urlRegex.exec(command)
  }

  const hostPortRegex = /\b([a-zA-Z0-9.-]+):(\d{1,5})\b/g
  match = hostPortRegex.exec(command)
  while (match) {
    if (match[1]) {
      hosts.add(match[1].toLowerCase())
    }
    match = hostPortRegex.exec(command)
  }

  return Array.from(hosts)
}

function hostMatchesAllowPattern(host: string, pattern: string): boolean {
  const regex = patternToRegExp(pattern.toLowerCase())
  return regex.test(host.toLowerCase())
}

function evaluateNetworkPolicy(command: string, profile: WskrProfile): ResolvedNetworkDecision {
  const tokens = parseCommandTokens(command)
  const commandName = tokens[0]?.toLowerCase() ?? ""
  const hosts = extractLikelyHosts(command)
  const usesNetwork = NETWORK_COMMAND_NAMES.has(commandName) || hosts.length > 0

  if (profile.network.mode === "open") {
    return {
      mode: "open",
      usesNetwork,
      hosts,
    }
  }

  if (!usesNetwork) {
    return {
      mode: profile.network.mode,
      usesNetwork,
      hosts,
    }
  }

  if (profile.network.mode === "deny") {
    throw new Error("Network access denied by runtime policy (network.mode=deny)")
  }

  for (const host of hosts) {
    const allowed = profile.network.allow_hosts.some((pattern) =>
      hostMatchesAllowPattern(host, pattern),
    )
    if (!allowed) {
      throw new Error(`Network host '${host}' is not allowed by runtime policy`)
    }
  }

  return {
    mode: "allowlist",
    usesNetwork,
    hosts,
  }
}

function hasRepoRootPlaceholder(
  mounts: RuntimePolicy["profiles"][string]["runtime"]["mounts"],
): boolean {
  return mounts.some((mount: MountConfig) => mount.host.includes("{repoRoot}"))
}

function getSandboxScope(context: ToolContext, requireWorktree: boolean): string {
  if (context.worktree) return context.worktree
  if (requireWorktree) {
    throw new Error(
      "runtime policy requires a repository root (context.worktree) for {repoRoot} mount expansion",
    )
  }
  return context.directory || process.cwd()
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function sanitizeVmName(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]/g, "-")
  const compacted = normalized.replace(/-+/g, "-")
  return compacted.slice(0, 128)
}

function resolveMountHost(host: string, repoRoot: string): string {
  if (host.includes("{repoRoot}") && !repoRoot) {
    throw new Error("unable to expand {repoRoot} mount host without repository root")
  }
  return host.replaceAll("{repoRoot}", repoRoot)
}

function resolveVolumeMounts(
  mounts: RuntimePolicy["profiles"][string]["runtime"]["mounts"],
  repoRoot: string,
): string[] {
  return mounts.map((mount: MountConfig) => {
    // TODO: Revisit mount mode semantics when krunvm adds explicit ro/rw support.
    const host = resolveMountHost(mount.host, repoRoot)
    return `${host}:${mount.guest}`
  })
}

function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("unable to reserve local port")))
        return
      }
      const reservedPort = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(reservedPort)
      })
    })
  })
}

async function buildWskrResolvedSpec(options: {
  profileName: string
  profileHash: string
  policy: RuntimePolicy
  context: ToolContext
  token?: string
}): Promise<WskrResolvedSandboxSpec> {
  const { profileName, profileHash, policy, context, token } = options
  const profileConfig = policy.profiles[profileName]
  if (!profileConfig) {
    throw new Error(`Profile '${profileName}' is not configured.`)
  }

  const scope = getSandboxScope(context, hasRepoRootPlaceholder(profileConfig.runtime.mounts))
  const scopeHash = hashShort(scope)
  const vmName = sanitizeVmName(`wskr-${profileName}-${profileHash}-${scopeHash}`)

  const providerHost = Bun.env.OPENCODE_SANDBOX_AGENT_HOST ?? DEFAULT_SANDBOX_AGENT_HOST
  const hostPort = await reservePort(providerHost)
  const agentPort = parseBoundedInt(
    Bun.env.OPENCODE_SANDBOX_AGENT_PORT,
    DEFAULT_SANDBOX_AGENT_PORT,
    1,
    65535,
  )
  const cpus = parseBoundedInt(Bun.env.OPENCODE_WSKR_VM_CPUS, 1, 1, 64)
  const memoryMiB = parseBoundedInt(Bun.env.OPENCODE_WSKR_VM_MEMORY_MIB, 1024, 64, 262144)
  const dns = Bun.env.OPENCODE_WSKR_VM_DNS ?? "1.1.1.1"

  const baseUrl = `http://${providerHost}:${hostPort}`
  const volumes = resolveVolumeMounts(profileConfig.runtime.mounts, scope)
  const startEnv = Object.entries(profileConfig.auth.stub_env ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  )
  const startCommand =
    Bun.env.OPENCODE_SANDBOX_AGENT_BIN ??
    profileConfig.runtime.sandbox_agent_command ??
    DEFAULT_SANDBOX_AGENT_BIN
  const startArgs = [
    ...profileConfig.runtime.sandbox_agent_args,
    "--host",
    "0.0.0.0",
    "--port",
    String(agentPort),
  ]
  if (token) {
    startArgs.push("--token", token)
  } else {
    startArgs.push("--no-token")
  }

  return {
    vmName,
    baseUrl,
    create: {
      image: profileConfig.runtime.image,
      name: vmName,
      workdir: profileConfig.runtime.workdir,
      cpus: profileConfig.runtime.cpus ?? cpus,
      dns,
      volumes,
      ports: [`${hostPort}:${agentPort}`],
      memoryMiB: profileConfig.runtime.memory_mib ?? memoryMiB,
    },
    start: {
      name: vmName,
      command: startCommand,
      args: startArgs,
      env: startEnv,
      cpus: profileConfig.runtime.cpus ?? cpus,
      memoryMiB: profileConfig.runtime.memory_mib ?? memoryMiB,
    },
  }
}

async function startSandboxAgentWithRetry(
  start: () => Promise<SandboxAgent>,
  options: {
    maxAttempts?: number
    retryDelayMs?: number
  } = {},
): Promise<SandboxAgent> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? SANDBOX_START_MAX_ATTEMPTS)
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? SANDBOX_START_RETRY_DELAY_MS)
  let attempt = 0
  let lastError: unknown

  while (attempt < maxAttempts) {
    attempt += 1
    try {
      return await start()
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("sandbox startup failed after retry attempts")
}

function getSandboxClientKey(
  profileName: string,
  profileHash: string,
  context: ToolContext,
): string {
  const baseUrl = process.env.OPENCODE_SANDBOX_AGENT_BASE_URL
  if (baseUrl) {
    return `remote:${baseUrl}:${profileHash}`
  }

  const scopeHash = hashShort(getSandboxScope(context, false))
  return `local:${profileName}:${profileHash}:${scopeHash}`
}

async function createSandboxClient(options: {
  profileName: string
  profileHash: string
  policy: RuntimePolicy
  context: ToolContext
  key: string
}): Promise<SandboxClientHandle> {
  const { profileName, profileHash, policy, context, key } = options
  const bootedAtMs = Date.now()
  const baseUrl = process.env.OPENCODE_SANDBOX_AGENT_BASE_URL
  const token = process.env.OPENCODE_SANDBOX_AGENT_TOKEN
  const runtimeClientOptions = resolveRuntimeClientOptions({ policy })

  if (baseUrl) {
    const client = await SandboxAgent.connect({
      baseUrl,
      token,
      waitForHealth: { timeoutMs: 15000 },
    })
    return { client, key, profile: profileName, profileHash, bootedAtMs, teardown: "dispose" }
  }

  let client: SandboxAgent
  if (Bun.env.USE_LOCAL_PROVIDER) {
    client = await startSandboxAgentWithRetry(() =>
      SandboxAgent.start({
        sandbox: local({
          token,
          env: buildLocalProviderEnv(),
        }),
        token,
      }),
    )
  } else {
    client = await startSandboxAgentWithRetry(() =>
      SandboxAgent.start({
        sandbox: wskr({
          token,
          env: buildLocalProviderEnv(),
          clientOptions: runtimeClientOptions,
          resolveSpec: () =>
            buildWskrResolvedSpec({
              profileName,
              profileHash,
              policy,
              context,
              token,
            }),
        }),
        token,
      }),
    )
  }

  return {
    client,
    key,
    profile: profileName,
    profileHash,
    bootedAtMs,
    teardown: "destroySandbox",
  }
}

async function disposeClientEntry(entry: SandboxClientPoolEntry): Promise<void> {
  sandboxClients.delete(entry.key)
  try {
    const handle = await entry.pending
    if (handle.teardown === "destroySandbox") {
      await handle.client.destroySandbox()
    } else {
      await handle.client.dispose()
    }
  } catch {
    // cleanup best effort
  }
}

async function enforcePoolLimit(policy: RuntimePolicy): Promise<void> {
  const max = Math.max(1, policy.pool.max_total_vms)
  while (sandboxClients.size > max) {
    const entries = Array.from(sandboxClients.values())
    const oldest = entries.reduce((left, right) =>
      left.lastUsedAt <= right.lastUsedAt ? left : right,
    )
    await disposeClientEntry(oldest)
  }
}

async function enforcePerProfileLimit(policy: RuntimePolicy): Promise<void> {
  const maxPerProfile = Math.max(1, policy.pool.per_profile_max_idle)
  const entries = Array.from(sandboxClients.values())
  const grouped = new Map<string, SandboxClientPoolEntry[]>()

  for (const entry of entries) {
    const group = grouped.get(entry.profile) ?? []
    group.push(entry)
    grouped.set(entry.profile, group)
  }

  for (const profileEntries of grouped.values()) {
    if (profileEntries.length <= maxPerProfile) {
      continue
    }

    profileEntries.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const overflow = profileEntries.length - maxPerProfile
    for (let index = 0; index < overflow; index += 1) {
      await disposeClientEntry(profileEntries[index])
    }
  }
}

async function pruneIdleClients(policy: RuntimePolicy): Promise<void> {
  const configuredTtlSeconds = policy.pool.idle_ttl_seconds
  const ttlMs = Math.max(1, configuredTtlSeconds) * 1000
  const now = Date.now()
  const entries = Array.from(sandboxClients.values())

  for (const entry of entries) {
    if (now - entry.lastUsedAt > ttlMs) {
      await disposeClientEntry(entry)
    }
  }
}

function isStreamError(error: unknown): boolean {
  return error instanceof Error && /stream error/i.test(error.message)
}

async function getSandboxClient(
  profileName: string,
  policy: RuntimePolicy,
  context: ToolContext,
  deps: SandboxPoolDeps = {},
): Promise<SandboxClientHandle> {
  await pruneIdleClients(policy)

  const profileHash = getProfileHash(profileName, policy)
  const key = getSandboxClientKey(profileName, profileHash, context)
  const createClient = deps.createClient ?? createSandboxClient
  let entry = sandboxClients.get(key)

  if (!entry) {
    entry = {
      key,
      profile: profileName,
      profileHash,
      lastUsedAt: Date.now(),
      pending: createClient({ profileName, profileHash, policy, context, key }),
    }
    sandboxClients.set(key, entry)
    await enforcePerProfileLimit(policy)
    await enforcePoolLimit(policy)
  }

  entry.lastUsedAt = Date.now()

  try {
    return await entry.pending
  } catch (error) {
    sandboxClients.delete(key)
    throw error
  }
}

async function reconnectSandboxClient(
  handle: SandboxClientHandle,
  policy: RuntimePolicy,
  context: ToolContext,
  deps: SandboxPoolDeps = {},
): Promise<SandboxClientHandle> {
  const existing = sandboxClients.get(handle.key)
  if (existing) {
    await disposeClientEntry(existing)
  }

  return getSandboxClient(handle.profile, policy, context, deps)
}

function formatProcessOutput(result: {
  stdout: string
  stderr: string
  exitCode?: number | null
  timedOut: boolean
}): string {
  const outputParts: string[] = []

  if (result.stdout.trim()) {
    outputParts.push(result.stdout.trimEnd())
  }

  if (result.stderr.trim()) {
    outputParts.push(result.stderr.trimEnd())
  }

  if (result.timedOut) {
    outputParts.push("Command timed out.")
  }

  if ((result.exitCode ?? 0) !== 0) {
    outputParts.push(`Failed with exit code ${result.exitCode}.`)
  }

  if (outputParts.length === 0) {
    outputParts.push("(no output)")
  }

  return outputParts.join("\n")
}

function resolveAuditPath(policy: RuntimePolicy): string {
  const stateDir =
    process.env.OPENCODE_STATE_DIR ?? path.join(os.homedir(), ".local", "share", "opencode")
  const template = policy.audit.path ?? "{stateDir}/wskr-audit.ndjson"
  const replaced = template.replace("{stateDir}", stateDir)
  return path.isAbsolute(replaced) ? replaced : path.resolve(policy.policyDir, replaced)
}

async function appendAuditRecord(policy: RuntimePolicy, record: AuditRecord): Promise<void> {
  if (!policy.audit.enabled) {
    return
  }

  const include = new Set(policy.audit.include)
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => include.has(key as AuditRecordKey)),
  )
  const auditPath = resolveAuditPath(policy)
  await mkdir(path.dirname(auditPath), { recursive: true })
  await appendFile(auditPath, `${JSON.stringify(filtered)}\n`, "utf8")
}

type AuditRecordKey = keyof AuditRecord

function buildAuditRecord(params: {
  context: ToolContext
  resolvedProfile: ResolvedProfile
  command: string
  policy: RuntimePolicy
  decision: string
  decisionReason: string
  vmId?: string
  vmBootedAtMs?: number
  exitCode?: number | null
  durationMs?: number | null
}): AuditRecord {
  const auditCommandFields = buildAuditCommandFields(params.command, params.policy)

  return {
    timestamp: new Date().toISOString(),
    session_id: params.context.sessionID,
    message_id: params.context.messageID,
    agent_name: params.context.agent,
    is_subagent: params.resolvedProfile.isSubAgent,
    resolved_profile: params.resolvedProfile.profile,
    normalized_command: auditCommandFields.normalized_command,
    normalized_command_hash: auditCommandFields.normalized_command_hash,
    normalized_command_preview: auditCommandFields.normalized_command_preview,
    decision: params.decision,
    decision_reason: params.decisionReason,
    vm_id: params.vmId ?? "",
    vm_booted_at_ms: params.vmBootedAtMs ?? null,
    exit_code: params.exitCode ?? null,
    duration_ms: params.durationMs ?? null,
  }
}

function applyRedaction(output: string, policy: RuntimePolicy): string {
  if (!policy.redaction.enabled) {
    return output
  }

  let result = output
  for (const rule of policy.redaction.rules ?? []) {
    try {
      const regex = new RegExp(rule.pattern, "g")
      result = result.replace(regex, rule.replacement)
    } catch {
      if (policy.redaction.fail_mode === "block") {
        throw new Error(`Invalid redaction rule '${rule.id}'.`)
      }
    }
  }

  return result
}

function buildAuditCommandFields(
  command: string,
  policy: RuntimePolicy,
): {
  normalized_command: string
  normalized_command_hash: string
  normalized_command_preview: string
} {
  const normalized = normalizeCommand(command)
  const normalized_command_hash = sha256Hex(normalized)
  const normalized_command_preview = applyRedaction(normalized, policy).slice(0, 200)

  return {
    normalized_command: normalized_command_preview,
    normalized_command_hash,
    normalized_command_preview,
  }
}

function getTimeoutMs(timeout?: number): number {
  if (!timeout) {
    return DEFAULT_TIMEOUT_MS
  }

  return Math.max(1000, Math.min(timeout, 600000))
}

export const internal = {
  evaluateCommandPolicy,
  resolveAgentProfile,
  getProfileHash,
  getSandboxClientKey,
  getSandboxScope,
  resolveMountHost,
  resolveVolumeMounts,
  toUnixSocketWebSocketUrl,
  deriveKrunClientUrlFromServerEnv,
  maybeWarnInsecureRuntimeClientUrl,
  resolveRuntimeClientOptions,
  buildWskrResolvedSpec,
  startSandboxAgentWithRetry,
  createSandboxClient,
  getSandboxClient,
  reconnectSandboxClient,
  disposeClientEntry,
  applyRedaction,
  buildAuditCommandFields,
  formatProcessOutput,
  parseBoundedInt,
  sanitizeVmName,
  resolveProfileSecrets,
  assertNetworkPolicyEnforceable,
  evaluateNetworkPolicy,
  runCommandWithSandboxAgent,
  executePolicyBashCommand,
}

export { loadRuntimePolicy } from "./runtime-policy-loader"

async function runCommandWithSandboxAgent(options: {
  command: string
  timeout: number
  resolvedProfile: ResolvedProfile
  policy: RuntimePolicy
  context: ToolContext
  poolDeps?: SandboxPoolDeps
}): Promise<ExecutionResult> {
  const { command, timeout, resolvedProfile, policy, context, poolDeps } = options
  const profileConfig = policy.profiles[resolvedProfile.profile]
  if (!profileConfig) {
    throw new Error(`Profile '${resolvedProfile.profile}' is not configured.`)
  }

  assertNetworkPolicyEnforceable(profileConfig)
  const networkDecision = evaluateNetworkPolicy(command, profileConfig)
  const resolvedSecrets = await resolveProfileSecrets({
    policy,
    profileName: resolvedProfile.profile,
    profile: profileConfig,
    context,
  })

  const cwdCandidates = [profileConfig.runtime.workdir, context.directory, context.worktree].filter(
    (value, index, array) => Boolean(value) && array.indexOf(value) === index,
  )

  const runtimeEnv = {
    ...(profileConfig.auth.stub_env ?? {}),
    ...resolvedSecrets.env,
  }

  let handle = await getSandboxClient(resolvedProfile.profile, policy, context, poolDeps)

  let lastError: unknown
  let result: {
    stdout: string
    stderr: string
    exitCode?: number | null
    timedOut: boolean
    durationMs: number
    stdoutTruncated: boolean
    stderrTruncated: boolean
  } | null = null
  let resolvedCwd = cwdCandidates[0] ?? context.directory

  for (const cwd of cwdCandidates) {
    try {
      result = await handle.client.runProcess({
        // intentionally run through shell for parity with prior bash behavior
        command: "sh",
        args: ["-lc", command],
        cwd,
        env: runtimeEnv,
        timeoutMs: timeout,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      })
      resolvedCwd = cwd
      break
    } catch (error) {
      if (isStreamError(error)) {
        handle = await reconnectSandboxClient(handle, policy, context, poolDeps)
        try {
          result = await handle.client.runProcess({
            command: "sh",
            args: ["-lc", command],
            cwd,
            env: runtimeEnv,
            timeoutMs: timeout,
            maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          })
          resolvedCwd = cwd
          break
        } catch (reconnectError) {
          lastError = reconnectError
          continue
        }
      }

      lastError = error
      continue
    }
  }

  if (!result) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Sandbox execution failed for command '${command}'.`)
  }

  const output = applyRedaction(formatProcessOutput(result), {
    ...policy,
    redaction: {
      ...policy.redaction,
      rules: [...policy.redaction.rules, ...resolvedSecrets.redactions],
    },
  })

  return {
    output,
    metadata: {
      backend: "sandbox-agent",
      sandboxClientKey: handle.key,
      profileHash: handle.profileHash,
      sandboxBootMs: handle.bootedAtMs,
      profile: resolvedProfile.profile,
      cwd: resolvedCwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      secretsMode: profileConfig.secrets.mode,
      brokeredSecrets: resolvedSecrets.brokered,
      networkMode: networkDecision.mode,
      networkUses: networkDecision.usesNetwork,
      networkHosts: networkDecision.hosts,
    },
    exitCode: result.exitCode ?? null,
    sandboxId: handle.key,
    durationMs: result.durationMs,
  }
}

const sandboxAgentBackend: ExecutionBackend = {
  kind: "sandbox-agent",
  run: runCommandWithSandboxAgent,
}

const defaultExecuteDeps: ExecuteDeps = {
  loadPolicy: loadRuntimePolicy,
  backend: sandboxAgentBackend,
}

async function executePolicyBashCommand(options: {
  args: { command: string; timeout?: number }
  context: ToolContext
  deps?: ExecuteDeps
}): Promise<ToolResult> {
  const { args, context, deps = defaultExecuteDeps } = options
  const backend = deps.backend
  const command = normalizeCommand(args.command)
  if (!command) {
    throw new Error("Command must not be empty.")
  }
  const timeoutMs = getTimeoutMs(args.timeout)

  const policy = await deps.loadPolicy()
  const resolvedProfile = resolveAgentProfile(context.agent, policy)
  const decision = evaluateCommandPolicy(command, resolvedProfile.commandPolicyName, policy)

  if (decision.action === "deny") {
    const message =
      decision.reason === "never"
        ? `Command denied by non-overridable runtime policy rule '${decision.ruleId}'.`
        : `Command denied by runtime policy rule '${decision.ruleId}'.`
    await appendAuditRecord(
      policy,
      buildAuditRecord({
        context,
        resolvedProfile,
        command,
        policy,
        decision: "deny",
        decisionReason: message,
      }),
    )
    throw new Error(message)
  }

  if (decision.action === "ask") {
    await Effect.runPromise(
      context.ask({
        permission: "bash",
        patterns: [command],
        always: [command],
        metadata: {
          policyRule: decision.ruleId,
          profile: resolvedProfile.profile,
          commandPolicy: resolvedProfile.commandPolicyName,
          backend: backend.kind,
        },
      }),
    )
  }

  try {
    const execution = await backend.run({
      command,
      timeout: timeoutMs,
      resolvedProfile,
      policy,
      context,
    })

    await appendAuditRecord(
      policy,
      buildAuditRecord({
        context,
        resolvedProfile,
        command,
        policy,
        decision: decision.action,
        decisionReason: decision.ruleId,
        vmId: execution.sandboxId,
        vmBootedAtMs: execution.metadata.sandboxBootMs as number,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
      }),
    )

    return {
      output: execution.output,
      metadata: execution.metadata,
    }
  } catch (error) {
    await appendAuditRecord(
      policy,
      buildAuditRecord({
        context,
        resolvedProfile,
        command,
        policy,
        decision: decision.action,
        decisionReason: error instanceof Error ? error.message : String(error),
      }),
    )
    throw error
  }
}

const opencodeBashTool: ToolDefinition = tool({
  description: "Runtime-policy bash wrapper using Sandbox Agent process API",
  args: {
    command: tool.schema.string(),
    timeout: tool.schema.number().int().positive().max(600000).optional(),
  },
  async execute(
    args: { command: string; timeout?: number },
    context: ToolContext,
  ): Promise<ToolResult> {
    return executePolicyBashCommand({ args, context })
  },
})

export default opencodeBashTool
