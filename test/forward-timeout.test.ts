// A forwarded call is bounded by the producer's advertised resolve_timeout_ms and nothing else. Measured before: Bun's
// default fetch timeout cut every forward at about 300 s, so records' long waits (advertised as unbounded) failed as
// forward_failed "The operation timed out" between 300 and 360 s.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const AUTH = { "Content-Type": "application/json", Authorization: "ApiKey test" }
const realFetch = globalThis.fetch
let app: Hono
let forwarded: RequestInit | undefined

beforeEach(() => {
  setIdentityValidator(async () => ({ orgId: "test-org", userId: "u", keyId: "k", scopes: [] }))
  forwarded = undefined
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).startsWith("http://slow.test")) forwarded = init
    return Response.json({ ok: true })
  }) as typeof fetch
  app = createServer()
  registry.list().forEach((v) => registry.unregister(v.vesselId))
})
afterEach(() => {
  setIdentityValidator(null)
  globalThis.fetch = realFetch
  registry.list().forEach((v) => registry.unregister(v.vesselId))
})

describe("forward timeout", () => {
  it("[MUST-FAIL] the forward disables the fetch's own timeout and keeps the advertised bound as its signal", async () => {
    const reg = await app.request("/register", { method: "POST", headers: AUTH, body: JSON.stringify({
      vesselId: "slow", vesselName: "slow", version: "1", endpoint: "http://slow.test", shapes: ["slowShape"],
      systemVessel: true, resolve_timeout_ms: 2_147_483_647,
    }) })
    expect(reg.status).toBe(201)
    const res = await app.request("/resolve", { method: "POST", headers: AUTH, body: JSON.stringify({ pointer: { type: "slowShape" } }) })
    expect(res.status).toBe(200)
    expect(forwarded).toBeDefined()
    expect((forwarded as { timeout?: unknown }).timeout).toBe(false)
    expect(forwarded?.signal).toBeDefined()
  })
})
