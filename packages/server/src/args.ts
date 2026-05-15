import type {
  ChangePayload,
  CreatePayload,
  DeletePayload,
  ExecutableRequest,
  InspectPayload,
  KrunCommand,
  ListPayload,
  StartPayload,
} from "@wskr/types"
import type { DaemonConfig } from "./config"
import { ProtocolError } from "./errors"
import { isAllowedWorkdir } from "./security"

function buildCreateArgs(payload: CreatePayload, config: DaemonConfig): string[] {
  if (!isAllowedWorkdir(payload.workdir, config.allowedWorkdirs)) {
    throw new ProtocolError("forbidden", "workdir is not allowed", { workdir: payload.workdir })
  }

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

function buildChangeVmArgs(payload: ChangePayload, config: DaemonConfig): string[] {
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
    if (!isAllowedWorkdir(payload.workdir, config.allowedWorkdirs)) {
      throw new ProtocolError("forbidden", "workdir is not allowed", { workdir: payload.workdir })
    }
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
  config: DaemonConfig,
): { command: KrunCommand; args: string[] } {
  switch (request.kind) {
    case "get":
      return { command: "get", args: [] }
    case "create":
      return { command: "create", args: buildCreateArgs(request.payload, config) }
    case "delete":
      return { command: "delete", args: buildDeleteArgs(request.payload) }
    case "inspect":
      return { command: "inspect", args: buildInspectArgs(request.payload) }
    case "start":
      return { command: "start", args: buildStartArgs(request.payload) }
    case "changevm":
      return { command: "changevm", args: buildChangeVmArgs(request.payload, config) }
    case "list":
      return { command: "list", args: buildListArgs(request.payload) }
  }
}
