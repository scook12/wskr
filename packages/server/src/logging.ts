export type LogLevel = "info" | "warn" | "error"

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    }),
  )
}
