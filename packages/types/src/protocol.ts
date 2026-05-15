import { z } from "zod"

export const ERROR_CODES = [
  "invalid_json",
  "invalid_message",
  "unknown_kind",
  "invalid_config",
  "validation_failed",
  "forbidden",
  "not_found",
  "executor_error",
  "timeout",
  "cancelled",
  "internal_error",
] as const

export const ErrorCodeSchema = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const

export const JobStateSchema = z.enum(JOB_STATES)
export type JobState = z.infer<typeof JobStateSchema>

export const KRUN_COMMANDS = [
  "get",
  "create",
  "delete",
  "start",
  "inspect",
  "changevm",
  "list",
] as const
export type KrunCommand = (typeof KRUN_COMMANDS)[number]

export const REQUEST_KINDS = [
  "get",
  "create",
  "delete",
  "start",
  "inspect",
  "changevm",
  "list",
  "cancel",
] as const

export const RequestKindSchema = z.enum(REQUEST_KINDS)
export const ExecutableRequestKindSchema = z.enum(KRUN_COMMANDS)
export type RequestKind = z.infer<typeof RequestKindSchema>
export type ExecutableRequestKind = z.infer<typeof ExecutableRequestKindSchema>
export const KNOWN_KINDS = new Set<RequestKind>(REQUEST_KINDS)

export const RequestIdSchema = z.string().min(1).max(128)
export const VmNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, "name must match /^[a-zA-Z0-9._-]+$/")
export const EnvPairSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=.*/, "env must be KEY=value")
export const PortMappingSchema = z
  .string()
  .regex(/^\d{1,5}:\d{1,5}(\/(tcp|udp))?$/, "invalid port mapping")

export const GetPayloadSchema = z.null()

export const CreatePayloadSchema = z.object({
  image: z.string().min(1).max(512),
  name: VmNameSchema,
  workdir: z.string().min(1).max(1024),
  cpus: z.number().int().min(1).max(64),
  dns: z.string().min(1).max(256),
  volumes: z.array(z.string().min(1).max(2048)).max(64),
  ports: z.array(PortMappingSchema).max(64),
  memoryMiB: z.number().int().min(64).max(262144),
})

export const ChangePayloadSchema = z
  .object({
    name: VmNameSchema,
    newName: VmNameSchema.optional(),
    cpus: z.number().int().min(1).max(64).optional(),
    memoryMiB: z.number().int().min(64).max(262144).optional(),
    workdir: z.string().min(1).max(1024).optional(),
    removeVolumes: z.boolean().optional(),
    volumes: z.array(z.string().min(1).max(2048)).max(64).optional(),
    removePorts: z.boolean().optional(),
    ports: z.array(PortMappingSchema).max(64).optional(),
  })
  .refine((value) => !(value.removeVolumes === true && value.volumes && value.volumes.length > 0), {
    message: "removeVolumes cannot be combined with volumes",
  })
  .refine((value) => !(value.removePorts === true && value.ports && value.ports.length > 0), {
    message: "removePorts cannot be combined with ports",
  })

export const DeletePayloadSchema = z.object({
  name: VmNameSchema,
})

export const InspectPayloadSchema = z.object({
  name: VmNameSchema,
})

export const StartPayloadSchema = z.object({
  name: VmNameSchema,
  command: z.string().min(1).max(512).optional(),
  args: z.array(z.string().min(1).max(2048)).max(128).default([]),
  env: z.array(EnvPairSchema).max(128).default([]),
  cpus: z.number().int().min(1).max(64),
  memoryMiB: z.number().int().min(64).max(262144),
})

export const ListPayloadSchema = z.object({
  debug: z.boolean().optional(),
})

export const CancelPayloadSchema = z.object({
  opId: z.string().uuid(),
})

export const RequestSchema = z.discriminatedUnion("kind", [
  z.object({ id: RequestIdSchema, kind: z.literal("get"), payload: GetPayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("create"), payload: CreatePayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("delete"), payload: DeletePayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("start"), payload: StartPayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("inspect"), payload: InspectPayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("changevm"), payload: ChangePayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("list"), payload: ListPayloadSchema }),
  z.object({ id: RequestIdSchema, kind: z.literal("cancel"), payload: CancelPayloadSchema }),
])

export type GetPayload = z.infer<typeof GetPayloadSchema>
export type CreatePayload = z.infer<typeof CreatePayloadSchema>
export type ChangePayload = z.infer<typeof ChangePayloadSchema>
export type DeletePayload = z.infer<typeof DeletePayloadSchema>
export type InspectPayload = z.infer<typeof InspectPayloadSchema>
export type StartPayload = z.infer<typeof StartPayloadSchema>
export type ListPayload = z.infer<typeof ListPayloadSchema>
export type CancelPayload = z.infer<typeof CancelPayloadSchema>

export type RpcRequest = z.infer<typeof RequestSchema>
export type ExecutableRequest = Exclude<RpcRequest, { kind: "cancel" }>

export const RpcErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
})

export const RpcErrorResponseSchema = z.object({
  id: z.string().nullable(),
  ok: z.literal(false),
  error: RpcErrorSchema,
})

export const AckAcceptedSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  accepted: z.literal(true),
  opId: z.string().uuid(),
  state: z.literal("queued"),
  queuedAt: z.string(),
})

export const AckCancelledSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  cancelled: z.literal(true),
  opId: z.string().uuid(),
})

export const AckErrorSchema = RpcErrorResponseSchema

export const OpUpdateSchema = z.object({
  event: z.literal("op.update"),
  id: z.string(),
  opId: z.string().uuid(),
  kind: ExecutableRequestKindSchema,
  state: JobStateSchema,
  ts: z.string(),
})

export const OpDoneSchema = z.object({
  event: z.literal("op.done"),
  id: z.string(),
  opId: z.string().uuid(),
  kind: ExecutableRequestKindSchema,
  state: JobStateSchema,
  ts: z.string(),
  ok: z.boolean(),
  result: z
    .object({
      code: z.number(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number(),
    })
    .optional(),
  error: RpcErrorSchema.optional(),
})

export type RpcError = z.infer<typeof RpcErrorSchema>
export type RpcErrorResponse = z.infer<typeof RpcErrorResponseSchema>
export type AckAccepted = z.infer<typeof AckAcceptedSchema>
export type AckCancelled = z.infer<typeof AckCancelledSchema>
export type AckError = z.infer<typeof AckErrorSchema>
export type OpUpdate = z.infer<typeof OpUpdateSchema>
export type OpDone = z.infer<typeof OpDoneSchema>

export type RequestAccepted = AckAccepted
export type RequestCancelled = AckCancelled
export type ServerEvent = AckAccepted | AckCancelled | RpcErrorResponse | OpUpdate | OpDone
