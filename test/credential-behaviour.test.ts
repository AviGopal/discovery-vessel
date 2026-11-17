/**
 * The validation cache, seen only through the middleware's HTTP answer.
 *
 * Imports nothing but the middleware, which exists before and after the cache moved into credential-cache.ts, so
 * these legs run against either tree and fail there BY ASSERTION, never by a missing export. Time is moved with
 * bun:test's setSystemTime (the cache ages by Date.now()), and `fetch` is replaced by a router that answers for the
 * fake identities: no network, no sleeps.
 *
 * MUST-FAIL on the parent:
 *   - (iii) audience: identity's URL is read on every check, so switching it between two requests reaches a second
 *     identity through the middleware itself. A key cached for one identity must be asked again of another.
 *   - (vi) bound: a key validated first, then 300 other keys. Past 256 entries the oldest is evicted, so with
 *     identity unreachable inside the grace window that first key is NOT served from grace. On an unbounded cache it
 *     still is (200).
 * PINS (green on the parent by design; they hold the parent's behaviour in place):
 *   - (iv) a 401/403 from identity, on the first call after the TTL, is a 401 and leaves nothing for grace.
 *   - a 429 or 408 from identity, for a key cached 61 s ago, is a 401 and leaves nothing for grace: identity's
 *     rate limit and timeout still refuse the key, by the owner's ruling.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { Hono } from "hono"
import * as auth from "../src/middleware/auth.js"

const ID_A = "http://identity-behaviour-a.test"
const ID_B = "http://identity-behaviour-b.test"

type Handler = () => Response
let identity: Record<string, Handler> = {}
let identityCalls: string[] = []

const realFetch = globalThis.fetch
const savedEnv = process.env.IDENTITY_VESSEL_URL
const T0 = new Date("2030-01-01T00:00:00Z").getTime()
const at = (ms: number): void => { setSystemTime(new Date(T0 + ms)) }

const router = (async (input: Request | URL | string): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const base = url.replace(/\/v1\/auth\/resolve$/, "")
  identityCalls.push(base)
  const h = identity[base]
  if (!h) throw new TypeError("fetch failed")
  return h()
}) as typeof fetch

const ok = (): Response =>
  Response.json({ success: true, data: { authenticated: true, orgId: "organizations:test", userId: "users:test", keyId: "key_test", scopes: ["read"] } })
const denied = (): Response => Response.json({ success: true, data: { authenticated: false } })
const status = (s: number) => (): Response => new Response("{}", { status: s })

const app = new Hono()
app.use("*", auth.authMiddleware)
app.post("/register", (c) => c.json({ ok: true }))
const attempt = (key: string): Promise<Response> =>
  app.request("/register", { method: "POST", headers: { Authorization: `ApiKey ${key}` }, body: "{}" })
const reason = async (r: Response): Promise<string> => ((await r.json()) as { error: { reason: string } }).error.reason

let n = 0
const freshKey = (): string => `mb-behaviour-cache-${Date.now()}-${++n}-${"z".repeat(40)}`

/** Tests only, and only where the tree has it: a fresh cache. Absent before this change. */
const resetIfAvailable = (): void => {
  const reset = (auth as Record<string, unknown>).__resetAuthStateForTests
  if (typeof reset === "function") (reset as () => void)()
}

beforeEach(() => {
  identity = {}
  identityCalls = []
  at(0)
  auth.setIdentityValidator(null)
  resetIfAvailable()
  globalThis.fetch = router
  process.env.IDENTITY_VESSEL_URL = ID_A
})

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
  resetIfAvailable()
  if (savedEnv === undefined) delete process.env.IDENTITY_VESSEL_URL
  else process.env.IDENTITY_VESSEL_URL = savedEnv
})

afterAll(() => {
  setSystemTime()
  resetIfAvailable()
})

describe("through the middleware: the cache", () => {
  it("(iii) MUST-FAIL: a key cached for one identity is not served for another: the second identity is asked, and refuses", async () => {
    const key = freshKey()
    identity[ID_A] = ok
    identity[ID_B] = denied
    expect((await attempt(key)).status).toBe(200)

    process.env.IDENTITY_VESSEL_URL = ID_B
    at(1_000) // well inside the TTL of A's answer
    const res = await attempt(key)
    expect(identityCalls).toEqual([ID_A, ID_B])
    expect(res.status).toBe(401)
  })

  it("(vi) MUST-FAIL: the cache is bounded: the oldest key, pushed out by 300 newer ones, gets no grace", async () => {
    const first = freshKey()
    identity[ID_A] = ok
    expect((await attempt(first)).status).toBe(200)
    at(1_000)
    for (let i = 0; i < 300; i++) expect((await attempt(`${freshKey()}-bound-${i}`)).status).toBe(200)

    delete identity[ID_A] // identity unreachable
    at(61_000) // past the first key's TTL, deep inside its grace
    const res = await attempt(first)
    expect(res.status).not.toBe(200) // evicted by the bound: nothing for grace to serve
    expect(await reason(res)).toBe("identity_unreachable")
  })

  for (const s of [401, 403]) {
    it(`(iv) PIN: a ${s} on the first identity call after the TTL is a 401, and leaves nothing for grace`, async () => {
      const key = freshKey()
      identity[ID_A] = ok
      expect((await attempt(key)).status).toBe(200)

      at(61_000) // past the TTL, deep inside the 10-minute grace
      identity[ID_A] = status(s)
      const refused = await attempt(key)
      expect(refused.status).toBe(401)
      expect(await reason(refused)).toBe("rejected")

      identity[ID_A] = status(500) // faulting: grace would serve an entry still held
      at(62_000)
      const after = await attempt(key)
      expect(after.status).not.toBe(200)
      expect(await reason(after)).toBe("identity_http_error")
    })
  }

  for (const s of [429, 408]) {
    it(`PIN (green on the parent by design): a ${s} for a key cached 61 s ago is a 401, and leaves nothing for grace`, async () => {
      const key = freshKey()
      identity[ID_A] = ok
      expect((await attempt(key)).status).toBe(200)

      at(61_000)
      identity[ID_A] = status(s)
      const refused = await attempt(key)
      expect(refused.status).toBe(401)
      expect(await reason(refused)).toBe("identity_http_error")

      identity[ID_A] = status(500) // the entry is gone: grace serves nothing
      at(62_000)
      const after = await attempt(key)
      expect(after.status).not.toBe(200)
      expect(await reason(after)).toBe("identity_http_error")
    })
  }
})
