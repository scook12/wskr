import { describe, expect, test } from "bun:test"
import type { DaemonConfig } from "../src/config"
import { ProtocolError } from "../src/errors"
import { argsForRequest } from "../src/args"

const baseConfig: DaemonConfig = {
  transport: "unix",
  unixSocketPath: "/tmp/wskr.sock",
  tcpHost: "127.0.0.1",
  tcpPort: 8877,
  krunPath: "/usr/local/bin/krunvm",
  defaultTimeoutMs: 60_000,
  maxConcurrentOps: 4,
  maxPayloadLength: 256 * 1024,
  idleTimeoutSec: 120,
  closeOnBackpressureLimit: true,
  allowedWorkdirs: ["/tmp"],
  maxOutputBytes: 1024 * 1024,
  finishedOpTtlMs: 5000,
}

describe("argsForRequest", () => {
  test("builds create args", () => {
    const request = {
      id: "1",
      kind: "create",
      payload: {
        image: "ghcr.io/example/image",
        name: "vm1",
        workdir: "/tmp/work",
        cpus: 2,
        memoryMiB: 512,
        dns: "1.1.1.1",
        volumes: ["/tmp:/work"],
        ports: ["8080:80/tcp"],
      },
    } as const

    const result = argsForRequest(request, baseConfig)
    expect(result.command).toBe("create")
    expect(result.args).toEqual([
      "--name",
      "vm1",
      "--workdir",
      "/tmp/work",
      "--cpus",
      "2",
      "--mem",
      "512",
      "--dns",
      "1.1.1.1",
      "--volume",
      "/tmp:/work",
      "--port",
      "8080:80/tcp",
      "ghcr.io/example/image",
    ])
  })

  test("rejects forbidden workdir", () => {
    const request = {
      id: "1",
      kind: "create",
      payload: {
        image: "ghcr.io/example/image",
        name: "vm1",
        workdir: "/etc",
        cpus: 2,
        memoryMiB: 512,
        dns: "1.1.1.1",
        volumes: [],
        ports: [],
      },
    } as const

    expect(() => argsForRequest(request, baseConfig)).toThrow(ProtocolError)
  })
})
