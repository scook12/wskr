import { z } from "zod"

export const KRUNVM_BACKEND_COMMANDS = [
  "create",
  "boot",
  "start",
  "inspect",
  "list",
  "delete",
  "changevm",
] as const

export const KrunvmBackendCommandSchema = z.enum(KRUNVM_BACKEND_COMMANDS)
export type KrunvmBackendCommand = z.infer<typeof KrunvmBackendCommandSchema>

export const KRUNVM_OPTION_SPECS = {
  "--name": { takesValue: true, repeatable: false },
  "--cpus": { takesValue: true, repeatable: false },
  "--mem": { takesValue: true, repeatable: false },
  "--dns": { takesValue: true, repeatable: false },
  "--workdir": { takesValue: true, repeatable: false },
  "--volume": { takesValue: true, repeatable: true },
  "--port": { takesValue: true, repeatable: true },
  "--new-name": { takesValue: true, repeatable: false },
  "--remove-volumes": { takesValue: false, repeatable: false },
  "--remove-ports": { takesValue: false, repeatable: false },
  "--env": { takesValue: true, repeatable: true },
  "-d": { takesValue: false, repeatable: false },
} as const

export type KrunvmOptionFlag = keyof typeof KRUNVM_OPTION_SPECS

export const KRUNVM_ALLOWED_FLAGS_BY_COMMAND: {
  [K in KrunvmBackendCommand]: ReadonlyArray<KrunvmOptionFlag>
} = {
  create: ["--name", "--cpus", "--mem", "--dns", "--workdir", "--volume", "--port"],
  boot: ["--cpus", "--mem", "--env"],
  changevm: [
    "--new-name",
    "--cpus",
    "--mem",
    "--workdir",
    "--remove-volumes",
    "--volume",
    "--remove-ports",
    "--port",
  ],
  start: ["--cpus", "--mem", "--env"],
  list: ["-d"],
  inspect: [],
  delete: [],
}

const MIN_POSITIONAL_ARGS_BY_COMMAND: Record<KrunvmBackendCommand, number> = {
  create: 1,
  boot: 1,
  start: 1,
  inspect: 1,
  list: 0,
  delete: 1,
  changevm: 1,
}

export const KrunvmInvocationSchema = z
  .object({
    command: KrunvmBackendCommandSchema,
    args: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const allowed = new Set(KRUNVM_ALLOWED_FLAGS_BY_COMMAND[value.command])
    const seen = new Map<KrunvmOptionFlag, number>()
    let positionalCount = 0

    for (let i = 0; i < value.args.length; i += 1) {
      if ((value.command === "start" || value.command === "boot") && positionalCount >= 1) {
        positionalCount += value.args.length - i
        break
      }

      const token = value.args[i]
      if (token === "--") {
        positionalCount += value.args.length - i - 1
        break
      }

      if (!token.startsWith("-")) {
        positionalCount += 1
        continue
      }

      if (!(token in KRUNVM_OPTION_SPECS)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown backend option '${token}' for krunvm ${value.command}`,
          path: ["args", i],
        })
        continue
      }

      const flag = token as KrunvmOptionFlag
      if (!allowed.has(flag)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `option '${flag}' is not supported for krunvm ${value.command}`,
          path: ["args", i],
        })
      }

      const currentSeen = (seen.get(flag) ?? 0) + 1
      seen.set(flag, currentSeen)
      const spec = KRUNVM_OPTION_SPECS[flag]
      if (!spec.repeatable && currentSeen > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `option '${flag}' may only be specified once for krunvm ${value.command}`,
          path: ["args", i],
        })
      }

      if (spec.takesValue) {
        const next = value.args[i + 1]
        if (next === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `option '${flag}' requires a value for krunvm ${value.command}`,
            path: ["args", i],
          })
          continue
        }
        i += 1
      }
    }

    const minPositionals = MIN_POSITIONAL_ARGS_BY_COMMAND[value.command]
    if (positionalCount < minPositionals) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `krunvm ${value.command} requires at least ${minPositionals} positional argument(s)`,
        path: ["args"],
      })
    }
  })

export type KrunvmInvocation = z.infer<typeof KrunvmInvocationSchema>

export function parseKrunvmInvocation(value: unknown): KrunvmInvocation {
  return KrunvmInvocationSchema.parse(value)
}

export function safeParseKrunvmInvocation(value: unknown) {
  return KrunvmInvocationSchema.safeParse(value)
}
