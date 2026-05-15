import { describe, expect, test } from "bun:test"
import { parseIncomingMessage } from "../src/protocol"
import { ProtocolError } from "../src/errors"

describe("parseIncomingMessage", () => {
  test("parses valid message", () => {
    const parsed = parseIncomingMessage(
      JSON.stringify({
        id: "req-1",
        kind: "list",
        payload: {
          debug: true,
        },
      }),
    )

    expect(parsed.kind).toBe("list")
    if (parsed.kind === "list") {
      expect(parsed.payload.debug).toBe(true)
    }
  })

  test("parses buffer input", () => {
    const parsed = parseIncomingMessage(
      Buffer.from(
        JSON.stringify({
          id: "req-1",
          kind: "get",
          payload: null,
        }),
      ),
    )

    expect(parsed.kind).toBe("get")
  })

  test("throws invalid_json", () => {
    expect(() => parseIncomingMessage("{ bad json")).toThrow(ProtocolError)
    try {
      parseIncomingMessage("{ bad json")
    } catch (error) {
      expect((error as ProtocolError).code).toBe("invalid_json")
    }
  })

  test("throws unknown_kind", () => {
    expect(() =>
      parseIncomingMessage(
        JSON.stringify({
          id: "req-1",
          kind: "launch",
          payload: {},
        }),
      ),
    ).toThrow(ProtocolError)

    try {
      parseIncomingMessage(
        JSON.stringify({
          id: "req-1",
          kind: "launch",
          payload: {},
        }),
      )
    } catch (error) {
      expect((error as ProtocolError).code).toBe("unknown_kind")
    }
  })

  test("throws invalid_message for malformed known-kind payload", () => {
    expect(() =>
      parseIncomingMessage(
        JSON.stringify({
          id: "req-1",
          kind: "list",
          payload: 123,
        }),
      ),
    ).toThrow(ProtocolError)

    try {
      parseIncomingMessage(
        JSON.stringify({
          id: "req-1",
          kind: "list",
          payload: 123,
        }),
      )
    } catch (error) {
      expect((error as ProtocolError).code).toBe("invalid_message")
    }
  })
})
