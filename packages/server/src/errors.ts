import { ZodError } from "zod"
import type { ErrorCode, RpcErrorResponse } from "@wskr/types"

export class ProtocolError extends Error {
  code: ErrorCode
  details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "ProtocolError"
    this.code = code
    this.details = details
  }
}

export function toRpcError(error: unknown, id: string | null): RpcErrorResponse {
  if (error instanceof ProtocolError) {
    return {
      id,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    }
  }

  if (error instanceof ZodError) {
    return {
      id,
      ok: false,
      error: {
        code: "validation_failed",
        message: "request payload validation failed",
        details: error.issues,
      },
    }
  }

  return {
    id,
    ok: false,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "unknown internal error",
    },
  }
}
