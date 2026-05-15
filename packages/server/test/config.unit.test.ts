import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config"
import { ProtocolError } from "../src/errors"

describe("loadConfig", () => {
  test("loads defaults", () => {
    const config = loadConfig({})
    expect(config.transport).toBe("unix")
    expect(config.unixSocketPath).toBe("/run/krunvmd.sock")
    expect(config.tcpHost).toBe("127.0.0.1")
    expect(config.tcpPort).toBe(8877)
  })

  test("loads tcp transport", () => {
    const config = loadConfig({
      KRUN_SERVER_TRANSPORT: "tcp",
      KRUN_TCP_HOST: "0.0.0.0",
      KRUN_TCP_PORT: "9911",
    })
    expect(config.transport).toBe("tcp")
    expect(config.tcpHost).toBe("0.0.0.0")
    expect(config.tcpPort).toBe(9911)
  })

  test("rejects invalid integers", () => {
    expect(() => loadConfig({ KRUN_MAX_CONCURRENT_OPS: "0" })).toThrow(ProtocolError)
  })

  test("rejects invalid booleans", () => {
    expect(() => loadConfig({ KRUN_WS_CLOSE_ON_BACKPRESSURE: "yes" })).toThrow(ProtocolError)
  })

  test("rejects invalid transport", () => {
    expect(() => loadConfig({ KRUN_SERVER_TRANSPORT: "http" })).toThrow(ProtocolError)
  })

  test("parses allowed workdirs csv", () => {
    const config = loadConfig({ KRUN_ALLOWED_WORKDIRS: " /tmp , /var/tmp ,," })
    expect(config.allowedWorkdirs).toEqual(["/tmp", "/var/tmp"])
  })
})
