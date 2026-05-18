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

function parsePortPair(raw) {
  const parts = raw.split(':')
  if (parts.length !== 2) {
    throw new Error("Too many ':' separators")
  }
  const hostPort = Number.parseInt(parts[0], 10)
  const guestPort = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(hostPort) || hostPort < 0 || hostPort > 65535) {
    throw new Error('Invalid host port')
  }
  if (!Number.isFinite(guestPort) || guestPort < 0 || guestPort > 65535) {
    throw new Error('Invalid guest port')
  }
}

function parseVolumePair(raw) {
  const parts = raw.split(':')
  if (parts.length !== 2) {
    throw new Error("Too many ':' separators")
  }
  const hostPath = parts[0]
  const guestPath = parts[1]
  if (!hostPath.startsWith('/')) {
    throw new Error('Invalid volume, host_path is not an absolute path')
  }
  if (!guestPath.startsWith('/')) {
    throw new Error('Invalid volume, guest_path is not an absolute path')
  }
  if (!/^\/[^/:]+$/.test(guestPath)) {
    throw new Error('Invalid volume, only single direct root children are supported as guest_path')
  }
}

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
  if (command === 'create' || command === 'changevm') {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]
      const value = args[i + 1]
      if (token === '--port' && value) {
        parsePortPair(value)
      }
      if (token === '--volume' && value) {
        parseVolumePair(value)
      }
    }

    if (command === 'create') {
      const image = args[args.length - 1]
      if (!image || image.startsWith('-')) {
        throw new Error('Invalid create image argument')
      }
    }
  }

  console.log(JSON.stringify({ command, args }))
  process.exit(0)
}

if (command === 'start') {
  const barrierIndex = args.indexOf('--')
  if (barrierIndex < 0) {
    console.error('missing start command separator')
    process.exit(2)
  }

  const preArgs = args.slice(0, barrierIndex)
  const postArgs = args.slice(barrierIndex + 1)
  if (postArgs.length === 0) {
    console.error('missing start command payload')
    process.exit(2)
  }

  for (let i = 0; i < preArgs.length; i += 1) {
    if (preArgs[i] === '--env' && !preArgs[i + 1]) {
      console.error('missing --env value')
      process.exit(2)
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
