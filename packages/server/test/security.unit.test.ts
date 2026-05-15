import { describe, expect, test } from "bun:test"
import { isAllowedWorkdir } from "../src/security"

describe("isAllowedWorkdir", () => {
  test("allows exact match", () => {
    expect(isAllowedWorkdir("/tmp", ["/tmp"])).toBe(true)
  })

  test("allows nested path", () => {
    expect(isAllowedWorkdir("/tmp/foo/bar", ["/tmp"])).toBe(true)
  })

  test("rejects sibling traversal", () => {
    expect(isAllowedWorkdir("/tmp2", ["/tmp"])).toBe(false)
  })
})
