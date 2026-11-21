/**
 * The validation cache: what a positive answer buys, what ends it, and how big it can get.
 *
 * Drives the REAL default validator through the middleware, with `fetch` replaced by a router (identity's
 * /v1/auth/resolve answers what the test sets) and the cache's clock injected, so nothing touches the network
 * and nothing sleeps.
 *
 * WHY THE MID-TTL 401 LEG IS TESTED ON THE CALL THAT GOES OUT. Within the TTL a cached key is answered from the
 * cache and identity is not asked at all, so there is no identity answer mid-TTL for a 401 to arrive in. The
 * first identity call for a cached key is the one after the TTL, while the entry is still held for grace: that
 * is where a 401/403 must evict at once, leaving nothing for grace to serve.
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
import { credentialCacheKey, makeCredentialValidator } from "../src/middleware/credential-cache.js"

const ID_A = "http://identity-a.test"
const ID_B = "http://identity-b.test"

type Handler = (apiKey: string) => Response | Promise<Response>
let identity: Record<string, Handler> = {}
let identityCalls: Array<{ base: string; apiKey: string }> = []
let now = 1_000_000

const realFetch = globalThis.fetch
const savedEnv = process.env.IDENTITY_VESSEL_URL

const router = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const base = url.replace(/\/v1\/auth\/resolve$/, "")
  const apiKey = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } }).impulse?.pointer?.apiKey)
  identityCalls.push({ base, apiKey })
  const h = identity[base]
  if (!h) throw new TypeError("fetch failed")
  return h(apiKey)
}) as typeof fetch

const ok = (): Response =>
  Response.json({ success: true, data: { authenticated: true, orgId: "organizations:test", userId: "users:test", keyId: "key_test", scopes: ["read"] } })
const denied = (): Response => Response.json({ success: true, data: { authenticated: false } })
const status = (s: number) => (): Response => new Response("{}", { status: s })
const down = (): Response => { throw new TypeError("fetch failed") }

const app = new Hono()
app.use("*", authMiddleware)
app.post("/register", (c) => c.json({ ok: true }))
const attempt = (key: string): Promise<Response> =>
  app.request("/register", { method: "POST", headers: { Authorization: `ApiKey ${key}` }, body: "{}" })
const reason = async (r: Response): Promise<string> => ((await r.json()) as { error: { reason: string } }).error.reason

let n = 0
const freshKey = (): string => `mb-cache-test-${++n}-${"x".repeat(40)}`
const at = (ms: number): void => { now = 1_000_000 + ms }

beforeEach(() => {
  identity = {}
  identityCalls = []
  at(0)
  setIdentityValidator(null)
  __resetAuthStateForTests()
  __setAuthClockForTests(() => now)
  globalThis.fetch = router
  process.env.IDENTITY_VESSEL_URL = ID_A
})

afterEach(() => {
  globalThis.fetch = realFetch
  __setAuthClockForTests(null)
  __resetAuthStateForTests()
  if (savedEnv === undefined) delete process.env.IDENTITY_VESSEL_URL
  else process.env.IDENTITY_VESSEL_URL = savedEnv
})

describe("a positive answer is reused for the TTL, and only that long", () => {
  it("leg 1: a key revoked within the TTL still passes until the TTL ends, and is refused after", async () => {
    const key = freshKey()
    identity[ID_A] = ok
    expect((await attempt(key)).status).toBe(200)

    identity[ID_A] = status(401) // revoked
    at(59_999)
    expect((await attempt(key)).status).toBe(200)
    expect(identityCalls.length).toBe(1) // answered from the cache: identity not asked

    at(60_000)
    const after = await attempt(key)
    expect(after.status).toBe(401)
    expect(await reason(after)).toBe("rejected")
    expect(identityCalls.length).toBe(2)
  })

  it("leg (a): a key cached for one identity is not accepted for another (the audience is in the key)", async () => {
    const key = freshKey()
    identity[ID_A] = ok
    identity[ID_B] = denied
    expect((await attempt(key)).status).toBe(200)

    process.env.IDENTITY_VESSEL_URL = ID_B
    at(1_000) // well within A's TTL
    const res = await attempt(key)
    expect(res.status).toBe(401)
    expect(identityCalls.map((c) => c.base)).toEqual([ID_A, ID_B])
    expect(credentialCacheKey(ID_A, key)).not.toBe(credentialCacheKey(ID_B, key))
  })

  it("two credentials sharing a long prefix are two entries, never one", async () => {
    const shared = `mb-shared-prefix-${"p".repeat(48)}`
    identity[ID_A] = ok
    expect((await attempt(`${shared}-one`)).status).toBe(200)
    identity[ID_A] = denied
    expect((await attempt(`${shared}-two`)).status).toBe(401)
    expect(identityCalls.length).toBe(2)
  })

  it("a negative answer is never cached: the next request asks identity again", async () => {
    const key = freshKey()
    identity[ID_A] = denied
    expect((await attempt(key)).status).toBe(401)
    identity[ID_A] = ok
    at(1_000)
    expect((await attempt(key)).status).toBe(200)
    expect(identityCalls.length).toBe(2)
  })
})

describe("a refusal evicts at once", () => {
  // Identity's 429 (rate limit) and 408 (timeout) are no verdict on the key, by the "Try again shortly" ruling: a
  // known key is served from grace through them, and its entry is kept.
  for (const s of [429, 408]) {
    it(`[MUST-FAIL] a ${s} for a key cached 61 s ago is served from grace, and the entry is kept`, async () => {
      const key = freshKey()
      identity[ID_A] = ok
      expect((await attempt(key)).status).toBe(200)
      expect(__credentialCacheSizeForTests()).toBe(1)

      at(61_000) // past the TTL, inside grace
      identity[ID_A] = status(s)
      expect((await attempt(key)).status).toBe(200)
      expect(__credentialCacheSizeForTests()).toBe(1)
    })
  }

  it("leg 2: a 401 on the first identity call after the TTL evicts; grace serves nothing after it", async () => {
    const key = freshKey()
    identity[ID_A] = ok
    expect((await attempt(key)).status).toBe(200)

    at(61_000) // past the TTL, deep inside the 10-minute grace
    identity[ID_A] = status(401)
    expect((await attempt(key)).status).toBe(401)

    identity[ID_A] = status(500) // identity now faulting: grace would serve a still-held entry
    at(62_000)
    const res = await attempt(key)
    expect(res.status).not.toBe(200)
    expect(await reason(res)).toBe("identity_http_error")
    expect(__credentialCacheSizeForTests()).toBe(0)
  })

  it("leg 4: a 403 evicts too; identity unreachable after it serves no grace", async () => {
    const key = freshKey()
    identity[ID_A] = ok
    expect((await attempt(key)).status).toBe(200)

    at(61_000)
    identity[ID_A] = status(403)
    const refused = await attempt(key)
    expect(refused.status).toBe(401)
    expect(await reason(refused)).toBe("rejected")

    identity[ID_A] = down
    at(62_000)
    const res = await attempt(key)
    expect(res.status).not.toBe(200)
    expect(await reason(res)).toBe("identity_unreachable")
  })
})

describe("the cache is bounded", () => {
  const principal = () => ({ ok: true })

  it("past maxEntries the oldest validation is evicted first", async () => {
    globalThis.fetch = (async () => ok()) as typeof fetch
    const v = makeCredentialValidator({ identityUrl: () => ID_A, principal, maxEntries: 3, clock: () => now })
    for (let i = 0; i < 5; i++) expect((await v.validate(`k${i}`)).ctx).not.toBeNull()
    expect(v.size()).toBe(3)
  })

  it("an insert sweeps every entry past the grace window", async () => {
    globalThis.fetch = (async () => ok()) as typeof fetch
    const v = makeCredentialValidator({ identityUrl: () => ID_A, principal, graceMs: 600_000, clock: () => now })
    await v.validate("k-old-1")
    await v.validate("k-old-2")
    at(600_000)
    await v.validate("k-new")
    expect(v.size()).toBe(1)
  })

  it("(d) an entry past grace is swept when it is consulted, with no insert to sweep it", async () => {
    globalThis.fetch = (async () => ok()) as typeof fetch
    const v = makeCredentialValidator({ identityUrl: () => ID_A, principal, graceMs: 600_000, clock: () => now })
    await v.validate("k-quiet")
    expect(v.size()).toBe(1)
    at(600_000)
    globalThis.fetch = (async () => { throw new TypeError("fetch failed") }) as typeof fetch
    const out = await v.validate("k-quiet")
    expect(out.ctx).toBeNull()
    expect(v.size()).toBe(0)
  })

  it("through the middleware: 300 distinct keys hold at most 256 entries", async () => {
    identity[ID_A] = ok
    for (let i = 0; i < 300; i++) await attempt(`mb-bound-${i}`)
    expect(__credentialCacheSizeForTests()).toBe(256)
  })
})
