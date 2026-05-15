import { z } from "zod"

export const WskrNetworkModeSchema = z.enum(["deny", "allowlist", "open"])
export type WskrNetworkMode = z.infer<typeof WskrNetworkModeSchema>

export const WskrCommandActionSchema = z.enum(["deny", "ask", "allow", "never"])
export type WskrCommandAction = z.infer<typeof WskrCommandActionSchema>

export const WskrAgentProfileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/)

export const WskrProfileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/)

export const WskrMountSchema = z.object({
  host: z.string().min(1).max(2048),
  guest: z.string().min(1).max(1024),
  mode: z.enum(["ro", "rw"]),
})

export const WskrRuntimeSchema = z.object({
  image: z.string().min(1).max(512),
  workdir: z.string().min(1).max(1024),
  mounts: z.array(WskrMountSchema).max(64).default([]),
  cpus: z.number().int().min(1).max(64).default(1),
  memory_mib: z.number().int().min(64).max(262144).default(1024),
  dns: z.string().min(1).max(256).default("1.1.1.1"),
  sandbox_agent_command: z.string().min(1).max(256).default("sandbox-agent"),
  sandbox_agent_args: z.array(z.string().min(1).max(512)).max(64).default([]),
})

export const WskrSecretsSchema = z.object({
  mode: z.enum(["none", "dummy", "brokered"]).default("dummy"),
  allowlist: z.array(z.string().min(1).max(256)).max(256).default([]),
  aliases: z.record(z.string().min(1).max(256), z.string().min(1).max(256)).default({}),
  dummy_prefix: z.string().min(1).max(64).default("DUMMY"),
})

export const WskrNetworkSchema = z
  .object({
    mode: WskrNetworkModeSchema,
    allow_hosts: z.array(z.string().min(1).max(512)).max(256).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "allowlist" && value.allow_hosts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "network.allow_hosts must not be empty when network.mode is 'allowlist'",
      })
    }
  })

export const WskrProfileSchema = z.object({
  command_policy: z.string().min(1).max(128),
  runtime: WskrRuntimeSchema,
  network: WskrNetworkSchema,
  secrets: WskrSecretsSchema,
  auth: z
    .object({
      stub_env: z.record(z.string().min(1).max(128), z.string().max(4096)).default({}),
    })
    .default({ stub_env: {} }),
})

export const WskrCommandRuleSchema = z.object({
  id: z.string().min(1).max(128),
  match: z.string().min(1).max(1024),
  action: WskrCommandActionSchema,
})

export const WskrCommandPolicySchema = z.object({
  default_action: z.enum(["deny", "ask", "allow"]),
  rules: z.array(WskrCommandRuleSchema).max(2048).default([]),
})

export const WskrAuditIncludeKeySchema = z.enum([
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
])

export const WskrAuditSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().min(1).max(2048).default("{stateDir}/wskr-audit.ndjson"),
  include: z
    .array(WskrAuditIncludeKeySchema)
    .default([
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
    ]),
})

export const WskrRedactionRuleSchema = z.object({
  id: z.string().min(1).max(128),
  pattern: z.string().min(1).max(1024),
  replacement: z.string().max(1024).default("[REDACTED]"),
})

export const WskrRedactionSchema = z.object({
  enabled: z.boolean().default(true),
  fail_mode: z.enum(["block", "warn"]).default("block"),
  rules: z.array(WskrRedactionRuleSchema).max(2048).default([]),
})

export const WskrPoolSchema = z.object({
  enabled: z.boolean().default(true),
  max_total_vms: z.number().int().min(1).max(512).default(6),
  per_profile_max_idle: z.number().int().min(1).max(128).default(2),
  idle_ttl_seconds: z.number().int().min(1).max(86400).default(1200),
  startup_timeout_seconds: z.number().int().min(1).max(300).default(45),
})

export const WskrPolicySchema = z.object({
  version: z.number().int().positive().default(1),
  agents: z.object({
    primary: z.record(z.string().min(1).max(64), WskrProfileNameSchema).default({ "*": "strict" }),
    subagent: z.record(z.string().min(1).max(64), WskrProfileNameSchema).default({ "*": "strict" }),
  }),
  command_policies: z.record(z.string().min(1).max(128), WskrCommandPolicySchema),
  profiles: z.record(WskrProfileNameSchema, WskrProfileSchema),
  audit: WskrAuditSchema.default({
    enabled: true,
    path: "{stateDir}/wskr-audit.ndjson",
    include: [
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
  }),
  redaction: WskrRedactionSchema.default({
    enabled: true,
    fail_mode: "block",
    rules: [],
  }),
  pool: WskrPoolSchema.default({
    enabled: true,
    max_total_vms: 6,
    per_profile_max_idle: 2,
    idle_ttl_seconds: 1200,
    startup_timeout_seconds: 45,
  }),
})

export type WskrMount = z.infer<typeof WskrMountSchema>
export type WskrRuntime = z.infer<typeof WskrRuntimeSchema>
export type WskrSecrets = z.infer<typeof WskrSecretsSchema>
export type WskrNetwork = z.infer<typeof WskrNetworkSchema>
export type WskrProfile = z.infer<typeof WskrProfileSchema>
export type WskrCommandRule = z.infer<typeof WskrCommandRuleSchema>
export type WskrCommandPolicy = z.infer<typeof WskrCommandPolicySchema>
export type WskrAuditIncludeKey = z.infer<typeof WskrAuditIncludeKeySchema>
export type WskrAudit = z.infer<typeof WskrAuditSchema>
export type WskrRedactionRule = z.infer<typeof WskrRedactionRuleSchema>
export type WskrRedaction = z.infer<typeof WskrRedactionSchema>
export type WskrPool = z.infer<typeof WskrPoolSchema>
export type WskrPolicy = z.infer<typeof WskrPolicySchema>

export type RuntimePolicy = WskrPolicy & {
  policyFilePath: string
  policyDir: string
}

export type RuleAction = WskrCommandAction
