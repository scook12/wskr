import type {
  ChangePayload,
  CreatePayload,
  DeletePayload,
  ExecutableRequest,
  InspectPayload,
  KrunvmBackendCommand,
  KrunvmInvocation,
  ListPayload,
  StartPayload,
} from "@wskr/types"
import { parseKrunvmInvocation } from "@wskr/types"
import type { DaemonConfig } from "./config"
import { ProtocolError } from "./errors"

function buildCreateArgs(payload: CreatePayload): string[] {
  const args = [
    "--name",
    payload.name,
    "--workdir",
    payload.workdir,
    "--cpus",
    String(payload.cpus),
    "--mem",
    String(payload.memoryMiB),
    "--dns",
    payload.dns,
  ]

  for (const volume of payload.volumes) {
    args.push("--volume", volume)
  }

  for (const port of payload.ports) {
    args.push("--port", port)
  }

  args.push(payload.image)
  return args
}

function buildDeleteArgs(payload: DeletePayload): string[] {
  return [payload.name]
}

function buildInspectArgs(payload: InspectPayload): string[] {
  return [payload.name]
}

function buildStartArgs(payload: StartPayload): string[] {
  const args = ["--cpus", String(payload.cpus), "--mem", String(payload.memoryMiB)]

  for (const envPair of payload.env) {
    args.push("--env", envPair)
  }

  args.push(payload.name)

  if (payload.command) {
    args.push(payload.command, ...payload.args)
  }

  return args
}

function buildChangeVmArgs(payload: ChangePayload): string[] {
  const args = [] as string[]

  if (payload.newName !== undefined) {
    args.push("--new-name", payload.newName)
  }

  if (payload.cpus !== undefined) {
    args.push("--cpus", String(payload.cpus))
  }

  if (payload.memoryMiB !== undefined) {
    args.push("--mem", String(payload.memoryMiB))
  }

  if (payload.workdir !== undefined) {
    args.push("--workdir", payload.workdir)
  }

  if (payload.removeVolumes) {
    args.push("--remove-volumes")
  }

  for (const volume of payload.volumes ?? []) {
    args.push("--volume", volume)
  }

  if (payload.removePorts) {
    args.push("--remove-ports")
  }

  for (const port of payload.ports ?? []) {
    args.push("--port", port)
  }

  args.push(payload.name)
  return args
}

function buildListArgs(payload: ListPayload): string[] {
  return payload.debug ? ["-d"] : []
}

export function argsForRequest(
  request: ExecutableRequest,
  _config: DaemonConfig,
): KrunvmInvocation {
  let invocation: { command: KrunvmBackendCommand; args: string[] }

  switch (request.kind) {
    case "get":
      invocation = { command: "list", args: [] }
      break
    case "create":
      invocation = { command: "create", args: buildCreateArgs(request.payload) }
      break
    case "delete":
      invocation = { command: "delete", args: buildDeleteArgs(request.payload) }
      break
    case "inspect":
      invocation = { command: "inspect", args: buildInspectArgs(request.payload) }
      break
    case "start":
      invocation = { command: "start", args: buildStartArgs(request.payload) }
      break
    case "changevm":
      invocation = { command: "changevm", args: buildChangeVmArgs(request.payload) }
      break
    case "list":
      invocation = { command: "list", args: buildListArgs(request.payload) }
      break
    default: {
      const _exhaustive: never = request
      throw new ProtocolError("internal_error", `unsupported request kind '${_exhaustive}'`)
    }
  }

  try {
    return parseKrunvmInvocation(invocation)
  } catch (error) {
    throw new ProtocolError(
      "invalid_message",
      "request produced unsupported backend invocation",
      error,
    )
  }
}
