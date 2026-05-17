import { describe, expect, test } from "bun:test"
import { safeParseKrunvmInvocation } from "@wskr/types"
import type { DaemonConfig } from "../src/config"
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
        ports: ["8080:80"],
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
      "8080:80",
      "ghcr.io/example/image",
    ])
  })

  test("builds create args without runtime network flags", () => {
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
        volumes: [],
        ports: [],
      },
    } as const

    const result = argsForRequest(request, baseConfig)
    expect(result.command).toBe("create")
    expect(result.args).not.toContain("--network")
    expect(result.args).not.toContain("--allow-host")
  })

  test("emits only backend-contract-approved invocation", () => {
    const create = argsForRequest(
      {
        id: "c1",
        kind: "create",
        payload: {
          image: "ghcr.io/example/image",
          name: "vm1",
          workdir: "/tmp/work",
          cpus: 2,
          memoryMiB: 512,
          dns: "1.1.1.1",
          volumes: ["/tmp:/work"],
          ports: ["8080:80"],
        },
      },
      baseConfig,
    )

    const changevm = argsForRequest(
      {
        id: "v1",
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
          ports: ["8080:80"],
        },
      },
      baseConfig,
    )

    const start = argsForRequest(
      {
        id: "s1",
        kind: "start",
        payload: {
          name: "vm-start",
          command: "echo",
          args: ["hello"],
          env: ["FOO=bar"],
          cpus: 1,
          memoryMiB: 256,
        },
      },
      baseConfig,
    )

    const list = argsForRequest(
      {
        id: "l1",
        kind: "list",
        payload: {
          debug: true,
        },
      },
      baseConfig,
    )

    expect(safeParseKrunvmInvocation(create).success).toBe(true)
    expect(safeParseKrunvmInvocation(changevm).success).toBe(true)
    expect(safeParseKrunvmInvocation(start).success).toBe(true)
    expect(safeParseKrunvmInvocation(list).success).toBe(true)
  })

  test("rejects invocation with unsupported backend flag", () => {
    const invalid = safeParseKrunvmInvocation({
      command: "create",
      args: ["--name", "vm1", "--network", "deny", "alpine:3.20"],
    })
    expect(invalid.success).toBe(false)
  })

  test("builds get args", () => {
    const request = {
      id: "1",
      kind: "get",
      payload: null,
    } as const

    expect(argsForRequest(request, baseConfig)).toEqual({ command: "list", args: [] })
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
        "--",
        "echo",
        "hello",
      ],
    })
  })

  test("allows start command args that look like backend flags", () => {
    const request = {
      id: "1",
      kind: "start",
      payload: {
        name: "vm-start",
        command: "sandbox-agent",
        args: ["server", "--host", "0.0.0.0", "--port", "3000", "--no-token"],
        env: [],
        cpus: 1,
        memoryMiB: 512,
      },
    } as const

    const result = argsForRequest(request, baseConfig)
    expect(result.command).toBe("start")
    expect(result.args).toEqual([
      "--cpus",
      "1",
      "--mem",
      "512",
      "vm-start",
      "--",
      "sandbox-agent",
      "server",
      "--host",
      "0.0.0.0",
      "--port",
      "3000",
      "--no-token",
    ])
    expect(safeParseKrunvmInvocation(result).success).toBe(true)
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
        ports: ["8080:80"],
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
        "8080:80",
        "vm-old",
      ],
    })
  })
})
