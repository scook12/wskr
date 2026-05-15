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

  if (payload.networkMode === "deny") {
    args.push("--network", "none")
  }

  if (payload.networkMode === "allowlist") {
    args.push("--network", "allowlist")
    for (const host of payload.networkAllowHosts) {
      args.push("--allow-host", host)
    }
  }

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
): { command: KrunCommand; args: string[] } {
  switch (request.kind) {
    case "get":
      return { command: "get", args: [] }
    case "create":
      return { command: "create", args: buildCreateArgs(request.payload) }
    case "delete":
      return { command: "delete", args: buildDeleteArgs(request.payload) }
    case "inspect":
      return { command: "inspect", args: buildInspectArgs(request.payload) }
    case "start":
      return { command: "start", args: buildStartArgs(request.payload) }
    case "changevm":
      return { command: "changevm", args: buildChangeVmArgs(request.payload) }
    case "list":
      return { command: "list", args: buildListArgs(request.payload) }
  }
}
