/**
 * Identity unable to decide (a 5xx, no answer) is a 503 for an unknown key and grace for a known one; anything
 * identity decides stays a 401. `fetch` is replaced by a router and the cache's clock is injected: no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import {
  authMiddleware,
  setIdentityValidator,
  __credentialCacheSizeForTests,
  __resetAuthStateForTests,
  __setAuthClockForTests
} from "../src/middleware/auth.js"

const ID = "http://identity-unavailable.test"
let handler: (() => Response) | null = null
let now = 3_000_000
const realFetch = globalThis.fetch
const savedEnv = process.env.IDENTITY_VESSEL_URL

const ok = (): Response =>
  Response.json({ success: true, data: { authenticated: true, orgId: "organizations:test", userId: "users:test", keyId: "key_test", scopes: ["read"] } })
const status = (s: number, headers?: Record<string, string>) => (): Response => new Response("{}", { status: s, headers })

const app = new Hono()
app.use("*", authMiddleware)
app.post("/register", (c) => c.json({ ok: true }))
let n = 0
const freshKey = (): string => `mb-unavailable-test-${++n}-${"v".repeat(40)}`
const attempt = (key: string): Promise<Response> =>
  app.request("/register", { method: "POST", headers: { Authorization: `ApiKey ${key}` }, body: "{}" })
const errorOf = async (r: Response): Promise<{ code: string; reason: string }> =>
  ((await r.json()) as { error: { code: string; reason: string } }).error
const at = (ms: number): void => { now = 3_000_000 + ms }

beforeEach(() => {
  handler = null
  at(0)
  setIdentityValidator(null)
  __resetAuthStateForTests()
  __setAuthClockForTests(() => now)
  globalThis.fetch = (async () => {
    if (!handler) throw new TypeError("fetch failed")
    return handler()
  }) as typeof fetch
  process.env.IDENTITY_VESSEL_URL = ID
})

afterEach(() => {
  globalThis.fetch = realFetch
  __setAuthClockForTests(null)
  __resetAuthStateForTests()
  if (savedEnv === undefined) delete process.env.IDENTITY_VESSEL_URL
  else process.env.IDENTITY_VESSEL_URL = savedEnv
})

describe("identity unable to decide, with no grace, is 503: refused is 401, unavailable is 503", () => {
  it("a 5xx on an unknown key: 503, reason identity_http_error, identity's Retry-After passed on", async () => {
    handler = status(502, { "Retry-After": "7" })
    const res = await attempt(freshKey())
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("7")
    expect((await errorOf(res)).reason).toBe("identity_http_error")
  })

  it("a Retry-After that is not a number of seconds is not passed on", async () => {
    handler = status(503, { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" })
    const res = await attempt(freshKey())
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBeNull()
  })

  it("identity unreachable on an unknown key: 503, reason identity_unreachable", async () => {
    const res = await attempt(freshKey())
    expect(res.status).toBe(503)
    expect((await errorOf(res)).reason).toBe("identity_unreachable")
  })

  it("a 5xx, and no answer, for a key in grace: served 200, and the entry stays", async () => {
    const key = freshKey()
    handler = ok
    expect((await attempt(key)).status).toBe(200)
    at(61_000)
    handler = status(500)
    expect((await attempt(key)).status).toBe(200)
    handler = null
    at(62_000)
    expect((await attempt(key)).status).toBe(200)
    expect(__credentialCacheSizeForTests()).toBe(1)
  })

  it("any other 4xx is still identity deciding: 401", async () => {
    handler = status(400)
    const res = await attempt(freshKey())
    expect(res.status).toBe(401)
    expect((await errorOf(res)).reason).toBe("identity_http_error")
  })

  for (const s of [429, 408]) {
    it(`PIN (green on the parent by design): a ${s} on an unknown key is a 401, not a 503`, async () => {
      handler = status(s, { "Retry-After": "9" })
      const res = await attempt(freshKey())
      expect(res.status).toBe(401)
      expect(res.headers.get("Retry-After")).toBeNull()
      expect((await errorOf(res)).reason).toBe("identity_http_error")
    })
  }

  it("a 200 saying not authenticated is a refusal: 401", async () => {
    handler = () => Response.json({ success: true, data: { authenticated: false } })
    expect((await attempt(freshKey())).status).toBe(401)
  })
})
