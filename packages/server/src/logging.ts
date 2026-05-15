export type LogLevel = "info" | "warn" | "error"

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

function isQuietLoggingEnabled(env: Record<string, string | undefined> = Bun.env): boolean {
  const raw = env.KRUN_LOG_QUIET ?? env.WSKR_SERVER_QUIET
  if (!raw) return false
  return TRUE_VALUES.has(raw.toLowerCase())
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (isQuietLoggingEnabled()) {
    return
  }

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    }),
  )
}
