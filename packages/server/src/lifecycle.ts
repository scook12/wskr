import type { CommandExecutor, RuntimeServer } from "./server"
import { loadConfig, type ConfigEnv, type DaemonConfig } from "./config"
import { assertPreflight, type PreflightReport } from "./preflight"
import { createServer } from "./server"

export type StartServerResult = {
  config: DaemonConfig
  report: PreflightReport
  runtime: RuntimeServer
}

export function startServer(options?: {
  env?: ConfigEnv
  config?: DaemonConfig
  executor?: CommandExecutor
}): StartServerResult {
  const loadedConfig = options?.config ?? loadConfig(options?.env)
  const { config, report } = assertPreflight(loadedConfig)
  const runtime = createServer(config, options?.executor)

  return {
    config,
    report,
    runtime,
  }
}
