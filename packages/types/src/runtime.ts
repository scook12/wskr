type AuditKeys =
  | "timestamp"
  | "session_id"
  | "message_id"
  | "agent_name"
  | "is_subagent"
  | "resolved_profile"
  | "normalized_command"
  | "decision"
  | "decision_reason"
  | "vm_id"
  | "vm_booted_at_ms"
  | "exit_code"
  | "duration_ms"

type Action = "deny" | "ask" | "allow"
export type RuleAction = Action | "never"

type CommandPolicy = {
  id?: string
  default_action: Action
  match_mode: string
  rules: { id: string; match: string; action: RuleAction }[]
}

type Profile = {
  command_policy: string
  smol: {
    smolfile: string
    image: string
    init: string[]
  }
  filesystem: {
    workdir: string
    mounts: { host: string; guest: string; mode: string }[]
  }
  network: {
    mode: "allowlist" | "deny" | "disabled" | "open"
    allow_hosts: string[]
    allow_cidrs: string[]
    deny_private_ranges: boolean
  }
  auth: {
    mode: string
    stub_env?: Record<string, string>
  }
}

type VmPoolOverrides = {
  enabled: boolean
  idle_ttl_seconds: number
}

type RedactionRule = {
  id: string
  type: "regex"
  pattern: string
  replacement: string
}

type TransitionRule = {
  from: string
  to: string[]
  action: Action
}

type AgentMap = {
  [agent: string]: "strict" | "build" | "research"
}

export type RuntimePolicy = {
  version: number
  policyDir: string
  agentMap: {
    primary: AgentMap
    subagent: AgentMap
  }
  audit: {
    enabled: boolean
    sink: string
    path: string
    include: AuditKeys[]
  }
  commandPolicies: Record<string, CommandPolicy>
  defaults: {
    requireSandboxForBash: boolean
    failClosed: boolean
    unknownAgentProfile: string
    unknownSubagentProfile: string
    subagentInheritsParentProfile: boolean
    profileResolutionOrder: string[]
  }
  profiles: {
    [name: string]: Profile
  }
  redaction: {
    enabled: boolean
    fail_mode: string
    rules: RedactionRule[]
  }
  secrets: {
    mode: string
    forceNoneWhenUntrustedInput: boolean
    classes: Record<string, unknown>
  }
  transitions: {
    enabled: boolean
    default_action: Action
    rules: TransitionRule[]
  }
  vmPool: {
    enabled: boolean
    maxTotalVms: number
    perProfileMaxIdle: number
    idleTtlSeconds: number
    startupTimeoutSeconds: number
    reuse_key: string[]
    phase2TestOverrides?: VmPoolOverrides
  }
}
