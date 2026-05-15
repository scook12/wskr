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
        networkMode: "open",
        networkAllowHosts: [],
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
        networkMode: "open",
        networkAllowHosts: [],
        volumes: [],
        ports: [],
      },
    } as const

    expect(() => argsForRequest(request, baseConfig)).toThrow(ProtocolError)
  })

  test("builds create args with network deny", () => {
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
        networkMode: "deny",
        networkAllowHosts: [],
        volumes: [],
        ports: [],
      },
    } as const

    const result = argsForRequest(request, baseConfig)
    expect(result.command).toBe("create")
    expect(result.args).toContain("--network")
    expect(result.args).toContain("none")
  })

  test("builds create args with network allowlist", () => {
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
        networkMode: "allowlist",
        networkAllowHosts: ["api.github.com", "*.githubusercontent.com"],
        volumes: [],
        ports: [],
      },
    } as const

    const result = argsForRequest(request, baseConfig)
    expect(result.command).toBe("create")
    expect(result.args).toContain("--network")
    expect(result.args).toContain("allowlist")
    expect(result.args).toContain("--allow-host")
    expect(result.args).toContain("api.github.com")
    expect(result.args).toContain("*.githubusercontent.com")
  })

  test("builds get args", () => {
    const request = {
      id: "1",
      kind: "get",
      payload: null,
    } as const

    expect(argsForRequest(request, baseConfig)).toEqual({ command: "get", args: [] })
  })

  test("builds delete and inspect args", () => {
    const del = {
      id: "1",
      kind: "delete",
      payload: {
        name: "vm-delete",
      },
    } as const
    const inspect = {
      id: "2",
      kind: "inspect",
      payload: {
        name: "vm-inspect",
      },
    } as const

    expect(argsForRequest(del, baseConfig)).toEqual({ command: "delete", args: ["vm-delete"] })
    expect(argsForRequest(inspect, baseConfig)).toEqual({
      command: "inspect",
      args: ["vm-inspect"],
    })
  })

  test("builds start args with command and env", () => {
    const request = {
      id: "1",
      kind: "start",
      payload: {
        name: "vm-start",
        command: "echo",
        args: ["hello"],
        env: ["FOO=bar", "BAR=baz"],
        cpus: 4,
        memoryMiB: 2048,
      },
    } as const

    expect(argsForRequest(request, baseConfig)).toEqual({
      command: "start",
      args: [
        "--cpus",
        "4",
        "--mem",
        "2048",
        "--env",
        "FOO=bar",
        "--env",
        "BAR=baz",
        "vm-start",
        "echo",
        "hello",
      ],
    })
  })

  test("builds start args without command", () => {
    const request = {
      id: "1",
      kind: "start",
      payload: {
        name: "vm-start",
        args: [],
        env: [],
        cpus: 1,
        memoryMiB: 256,
      },
    } as const

    expect(argsForRequest(request, baseConfig)).toEqual({
      command: "start",
      args: ["--cpus", "1", "--mem", "256", "vm-start"],
    })
  })

  test("builds list args", () => {
    const debug = {
      id: "1",
      kind: "list",
      payload: {
        debug: true,
      },
    } as const
    const basic = {
      id: "2",
      kind: "list",
      payload: {},
    } as const

    expect(argsForRequest(debug, baseConfig)).toEqual({ command: "list", args: ["-d"] })
    expect(argsForRequest(basic, baseConfig)).toEqual({ command: "list", args: [] })
  })

  test("builds changevm args with all optional flags", () => {
    const request = {
      id: "1",
      kind: "changevm",
      payload: {
        name: "vm-old",
        newName: "vm-new",
        cpus: 8,
        memoryMiB: 8192,
        workdir: "/tmp/work",
        removeVolumes: true,
        volumes: ["/tmp:/work"],
        removePorts: true,
        ports: ["8080:80/tcp"],
      },
    } as const

    expect(argsForRequest(request, baseConfig)).toEqual({
      command: "changevm",
      args: [
        "--new-name",
        "vm-new",
        "--cpus",
        "8",
        "--mem",
        "8192",
        "--workdir",
        "/tmp/work",
        "--remove-volumes",
        "--volume",
        "/tmp:/work",
        "--remove-ports",
        "--port",
        "8080:80/tcp",
        "vm-old",
      ],
    })
  })

  test("rejects forbidden changevm workdir", () => {
    const request = {
      id: "1",
      kind: "changevm",
      payload: {
        name: "vm-old",
        workdir: "/root",
      },
    } as const

    expect(() => argsForRequest(request, baseConfig)).toThrow(ProtocolError)
  })
})
