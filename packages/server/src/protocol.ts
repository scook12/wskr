import {
  KNOWN_KINDS,
  RequestSchema,
  type RequestKind,
  type RpcRequest,
  type ServerEvent,
} from "@wskr/types"
import { ProtocolError } from "./errors"

export function parseIncomingMessage(raw: string | Buffer): RpcRequest {
  const text = typeof raw === "string" ? raw : raw.toString("utf8")
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    throw new ProtocolError("invalid_json", "message is not valid JSON")
  }

  const parsed = RequestSchema.safeParse(value)
  if (!parsed.success) {
    const maybeKind =
      typeof value === "object" && value !== null && "kind" in value
        ? (value as { kind?: unknown }).kind
        : undefined
    const errorCode =
      typeof maybeKind === "string" && !KNOWN_KINDS.has(maybeKind as RequestKind)
        ? "unknown_kind"
        : "invalid_message"

    throw new ProtocolError(
      errorCode,
      "message does not match protocol schema",
      parsed.error.issues,
    )
  }

  return parsed.data
}

export function send(ws: Bun.ServerWebSocket<unknown>, message: ServerEvent): void {
  ws.send(JSON.stringify(message))
}
