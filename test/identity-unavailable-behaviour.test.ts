/**
 * Identity unable to decide is a 503; no identity configured is a 500; identity refusing is a 401.
 *
 * Seen only through the middleware's HTTP answer, importing nothing but the middleware, so these legs run on the
 * parent too and fail there BY ASSERTION. `fetch` is replaced by a router: no network.
 *
 * MUST-FAIL on the parent (which answered all of these 401):
 *   - a 5xx from identity on an unknown key: 503 IDENTITY_UNAVAILABLE, with identity's Retry-After passed on;
 *   - identity unreachable on an unknown key: 503 IDENTITY_UNAVAILABLE;
 *   - identity URL unset: 500 IDENTITY_UNCONFIGURED, with no request made.
 * MUST-FAIL on the parent (which answered them 401): a 429 or 408 from identity on an unknown key is 503
 * IDENTITY_UNAVAILABLE, with identity's Retry-After passed on: a rate limit or a timeout is no verdict on the key, by
 * the "Try again shortly" ruling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import * as auth from "../src/middleware/auth.js"

const ID = "http://identity-unavailable-behaviour.test"

let handler: (() => Response) | null = null
let calls = 0
const realFetch = globalThis.fetch
const savedEnv = process.env.IDENTITY_VESSEL_URL

const router = (async (): Promise<Response> => {
  calls++
  if (!handler) throw new TypeError("fetch failed")
  return handler()
}) as typeof fetch

const app = new Hono()
app.use("*", auth.authMiddleware)
app.post("/register", (c) => c.json({ ok: true }))
let n = 0
const attempt = (): Promise<Response> =>
  app.request("/register", { method: "POST", headers: { Authorization: `ApiKey mb-unavailable-${Date.now()}-${++n}-${"u".repeat(40)}` }, body: "{}" })
const errorOf = async (r: Response): Promise<{ code: string; reason: string }> =>
  ((await r.json()) as { error: { code: string; reason: string } }).error

beforeEach(() => {
  handler = null
  calls = 0
  auth.setIdentityValidator(null)
  globalThis.fetch = router
  process.env.IDENTITY_VESSEL_URL = ID
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedEnv === undefined) delete process.env.IDENTITY_VESSEL_URL
  else process.env.IDENTITY_VESSEL_URL = savedEnv
})

describe("through the middleware: refused is 401, unavailable is 503, unconfigured is 500", () => {
  it("MUST-FAIL: a 5xx on an unknown key is 503 IDENTITY_UNAVAILABLE, with identity's Retry-After", async () => {
    handler = () => new Response("{}", { status: 503, headers: { "Retry-After": "23" } })
    const res = await attempt()
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("23")
    const e = await errorOf(res)
    expect(e.code).toBe("IDENTITY_UNAVAILABLE")
    expect(e.reason).toBe("identity_http_error")
  })

  it("MUST-FAIL: identity unreachable on an unknown key is 503 IDENTITY_UNAVAILABLE", async () => {
    handler = null
    const res = await attempt()
    expect(res.status).toBe(503)
    const e = await errorOf(res)
    expect(e.code).toBe("IDENTITY_UNAVAILABLE")
    expect(e.reason).toBe("identity_unreachable")
  })

  it("MUST-FAIL: identity URL unset is 500 IDENTITY_UNCONFIGURED, and nothing is asked", async () => {
    delete process.env.IDENTITY_VESSEL_URL
    handler = () => Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k", scopes: [] } })
    const res = await attempt()
    expect(res.status).toBe(500)
    const e = await errorOf(res)
    expect(e.code).toBe("IDENTITY_UNCONFIGURED")
    expect(e.reason).toBe("identity_unconfigured")
    expect(calls).toBe(0)
  })

  for (const s of [429, 408]) {
    it(`[MUST-FAIL] a ${s} on an unknown key is 503 IDENTITY_UNAVAILABLE, with identity's Retry-After`, async () => {
      handler = () => new Response("{}", { status: s, headers: { "Retry-After": "23" } })
      const res = await attempt()
      expect(res.status).toBe(503)
      expect(res.headers.get("Retry-After")).toBe("23")
      const e = await errorOf(res)
      expect(e.code).toBe("IDENTITY_UNAVAILABLE")
      expect(e.reason).toBe("identity_http_error")
    })
  }
})
