/**
 * One identity call in flight per key: a burst of requests that each must ask identity about the same credential sends
 * one call, and every request gets its answer.
 *
 * Imports only the middleware, so these legs run on the parent tree too and fail there by assertion. `fetch` is a
 * router whose identity answers when the test releases it, so every request of a burst is waiting at once; time is
 * moved with setSystemTime (the cache ages by Date.now()).
 *
 * MUST-FAIL on the parent (one identity call per request there): a burst on an unknown key; a burst on a key past
 * its TTL; a burst answered 429, which is no verdict on the key: every request of it is a retryable 503.
 * GUARDS (green on the parent): two keys at once are two calls, each with its own answer; a request identity never
 * answers is a 503, and the next request after it settles asks again.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { Hono } from "hono"
import { __resetAuthStateForTests, authMiddleware, setIdentityValidator } from "../src/middleware/auth.js"

const ID = "http://identity-sf.test"
type Answer = () => Response
let answer: Record<string, Answer> = {}
let calls: string[] = []
let held: Array<() => void> = []

const realFetch = globalThis.fetch
const savedEnv = process.env.IDENTITY_VESSEL_URL

// Identity answers only when the test releases the calls it holds, so a burst overlaps.
const router = (async (_input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const apiKey = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } }).impulse?.pointer?.apiKey)
  calls.push(apiKey)
  await new Promise<void>((r) => held.push(r))
  const a = answer[apiKey]
  if (!a) throw new TypeError("fetch failed")
  return a()
}) as typeof fetch

const ok = (): Response =>
  Response.json({ success: true, data: { authenticated: true, orgId: "organizations:test", userId: "users:test", keyId: "key_test", scopes: ["read"] } })
const denied = (): Response => Response.json({ success: true, data: { authenticated: false } })
const status = (s: number) => (): Response => new Response("{}", { status: s })

const app = new Hono()
app.use("*", authMiddleware)
app.post("/register", (c) => c.json({ ok: true }))
const attempt = (key: string): Promise<Response> =>
  app.request("/register", { method: "POST", headers: { Authorization: `ApiKey ${key}` }, body: "{}" })

let n = 0
const freshKey = (): string => `mb-flight-test-${++n}-${"x".repeat(40)}`
const T0 = new Date("2030-01-01T00:00:00Z").getTime()

// Sends the requests, lets every one reach the validator, then releases identity until all are answered.
const burst = async (keys: string[]): Promise<number[]> => {
  const out = keys.map(attempt)
  const done = Promise.all(out)
  let settled = false
  void done.then(() => { settled = true })
  for (let i = 0; i < 200 && !settled; i++) {
    await Bun.sleep(5)
    for (const r of held.splice(0)) r()
  }
  return (await done).map((r) => r.status)
}

beforeEach(() => {
  answer = {}
  calls = []
  held = []
  setSystemTime(new Date(T0))
  setIdentityValidator(null)
  __resetAuthStateForTests()
  globalThis.fetch = router
  process.env.IDENTITY_VESSEL_URL = ID
})

afterEach(() => {
  for (const r of held.splice(0)) r()
  globalThis.fetch = realFetch
  setSystemTime()
  __resetAuthStateForTests()
  if (savedEnv === undefined) delete process.env.IDENTITY_VESSEL_URL
  else process.env.IDENTITY_VESSEL_URL = savedEnv
})

describe("one identity call in flight per key", () => {
  it("[MUST-FAIL] 50 requests at once on one unknown key ask identity once, and all are served", async () => {
    const k = freshKey()
    answer[k] = ok
    const got = await burst(Array(50).fill(k))
    expect(calls.length).toBe(1)
    expect(new Set(got)).toEqual(new Set([200]))
  })

  it("[MUST-FAIL] 50 requests at once on a key past its TTL ask identity once", async () => {
    const k = freshKey()
    answer[k] = ok
    expect(await burst([k])).toEqual([200])
    setSystemTime(new Date(T0 + 61_000))
    calls = []
    const got = await burst(Array(50).fill(k))
    expect(calls.length).toBe(1)
    expect(new Set(got)).toEqual(new Set([200]))
  })

  it("[MUST-FAIL] a burst identity answers 429 is one call, and every request of it is a retryable 503", async () => {
    const k = freshKey()
    answer[k] = status(429)
    const got = await burst(Array(50).fill(k))
    expect(calls.length).toBe(1)
    expect(new Set(got)).toEqual(new Set([503]))
  })

  it("[GUARD] two keys at once are two calls, each answered for itself", async () => {
    const a = freshKey()
    const b = freshKey()
    answer[a] = ok
    answer[b] = denied
    const got = await burst([a, b])
    expect(calls.sort()).toEqual([a, b].sort())
    expect(got).toEqual([200, 401])
  })

  it("[GUARD] a request identity never answers is refused 503, and the next request after it settles asks again", async () => {
    const k = freshKey()
    expect(await burst([k])).toEqual([503])
    expect(calls.length).toBe(1)
    expect(await burst([k])).toEqual([503])
    expect(calls.length).toBe(2)
  })
})
