import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function makeTempDir(prefix = "wskr-server-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanupDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function createShimBinary(dir: string): string {
  const shimPath = join(dir, "krunvm-shim.ts")
  const source = String.raw`#!/usr/bin/env bun
const [, , command, ...args] = Bun.argv

const failCommand = Bun.env.WSKR_SHIM_FAIL_COMMAND
if (failCommand && failCommand === command) {
  console.error('forced failure')
  process.exit(7)
}

const delayMsRaw = Bun.env.WSKR_SHIM_DELAY_MS ?? '0'
const delayMs = Number.parseInt(delayMsRaw, 10)
if (Number.isFinite(delayMs) && delayMs > 0) {
  await Bun.sleep(delayMs)
}

if (command === 'list') {
  const debug = args.includes('-d')
  const payload = debug ? [{ name: 'debug-vm' }] : []
  console.log(JSON.stringify(payload))
  process.exit(0)
}

if (command === 'get') {
  console.log(JSON.stringify([{ name: 'vm-a' }, { name: 'vm-b' }]))
  process.exit(0)
}

if (command === 'create' || command === 'inspect' || command === 'start' || command === 'changevm' || command === 'delete') {
  if (command === 'create') {
    const networkModeIndex = args.findIndex((arg) => arg === '--network')
    if (networkModeIndex >= 0) {
      const mode = args[networkModeIndex + 1]
      if (mode === 'none') {
        process.env.WSKR_SHIM_NETWORK_MODE = 'none'
      }

      if (mode === 'allowlist') {
        process.env.WSKR_SHIM_NETWORK_MODE = 'allowlist'
        const hosts = []
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--allow-host' && args[i + 1]) {
            hosts.push(args[i + 1])
          }
        }
        process.env.WSKR_SHIM_NETWORK_ALLOW_HOSTS = hosts.join(',')
      }
    }
  }

  if (command === 'start') {
    const cmdIndex = args.findIndex((arg) => arg === 'sh')
    const shellCommand = cmdIndex >= 0 ? args.slice(cmdIndex + 2).join(' ') : ''
    const mode = process.env.WSKR_SHIM_NETWORK_MODE
    const hosts = (process.env.WSKR_SHIM_NETWORK_ALLOW_HOSTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)

    if (mode === 'none' && /(curl|wget|ping|nc|ssh|scp|ftp|telnet)\b/.test(shellCommand)) {
      console.error('network denied by shim policy')
      process.exit(13)
    }

    if (mode === 'allowlist') {
      const urlMatch = shellCommand.match(/https?:\/\/([^\s/:?#]+)(?::\d+)?(?:[/?#]|$)/i)
      if (urlMatch?.[1]) {
        const host = urlMatch[1].toLowerCase()
        const allowed = hosts.some((pattern) => {
          if (pattern.startsWith('*.')) {
            return host === pattern.slice(2) || host.endsWith(pattern.slice(1))
          }
          return host === pattern.toLowerCase()
        })
        if (!allowed) {
          console.error('network host denied by shim policy')
          process.exit(14)
        }
      }
    }
  }

  console.log(JSON.stringify({ command, args }))
  process.exit(0)
}

console.error('unknown command')
process.exit(2)
`

  writeFileSync(shimPath, source)
  chmodSync(shimPath, 0o755)
  return shimPath
}

export async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to acquire free TCP port")))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}
