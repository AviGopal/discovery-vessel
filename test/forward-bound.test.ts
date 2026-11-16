/**
 * A call forwarded to a peer, for a shape no producer here serves now, waits as long as a producer of that shape has
 * said a call may take (its resolve_timeout_ms, remembered after it drops the shape), not a fixed 10 s (the USER, 11-15:
 * "Use producer's bound"). Live: node1's llm-resolver went dark, its llm_completion calls were forwarded to the hub,
 * and every one longer than 10 s was cut, though the hub's producer would have answered.
 * The peer is a stub behind an injected globalThis.fetch that answers after 10.5 s unless its signal aborts first.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Hono } from "hono"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetPeerCredentialState } from "../src/peer-credentials"

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_FANOUT_MODE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]
const PEER = "http://peer-slow.test:18100"
const AUTH = { "Content-Type": "application/json", Authorization: "ApiKey reader" }
const realFetch = globalThis.fetch
const original = { log: console.log, warn: console.warn }
let app: Hono

beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  process.env.HUB_API_KEY = "forwarder-node-key"
  process.env.PEER_DISCOVERY_ENDPOINTS = PEER
  setIdentityValidator(async (k) => (k === "reader" ? { orgId: "org-test", userId: "u", keyId: k, scopes: ["read"] } : null))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(PEER)) return Response.json({ error: "Not found" }, { status: 404 })
    // the peer's producer takes 10.5 s; a forward cut earlier sees its signal abort
    return await new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(Response.json({ resolved: true, shape: "slow_shape", content: "late answer" })), 10_500)
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })) })
    })
  }) as unknown as typeof fetch
  app = createServer()
  console.log = () => {}
  console.warn = () => {}
})

afterEach(() => {
  console.log = original.log
  console.warn = original.warn
  globalThis.fetch = realFetch
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n]
    else process.env[n] = savedEnv[n]
  }
  setIdentityValidator(null)
  registry.stop()
  __resetPeerCredentialState()
})

describe("forward bound", () => {
  it("[MUST-FAIL] a forwarded call slower than 10 s answers 200 when a producer of the shape advertised a longer bound", async () => {
    // a local producer of the shape registers its bound, then drops the shape (it went dark)
    const reg = await app.request("/register", { method: "POST", headers: AUTH, body: JSON.stringify({
      vesselId: "local-producer", vesselName: "local-producer", version: "1", endpoint: "http://local.test", shapes: ["slow_shape"],
      systemVessel: true, resolve_timeout_ms: 30_000,
    }) })
    expect(reg.status).toBe(201)
    registry.unregister("local-producer")
    expect(registry.boundFor("slow_shape")).toBe(30_000)
    const res = await app.request("/resolve", { method: "POST", headers: AUTH, body: JSON.stringify({ pointer: { type: "slow_shape" } }) })
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain("late answer")
  }, 20_000)

  it("the longest bound advertised for a shape is kept; one never bounded has none", () => {
    registry.register({ vesselId: "a", vesselName: "a", version: "1", endpoint: "http://a.test", shapes: ["s"], systemVessel: true, resolve_timeout_ms: 5_000 } as never)
    registry.register({ vesselId: "b", vesselName: "b", version: "1", endpoint: "http://b.test", shapes: ["s"], systemVessel: true, resolve_timeout_ms: 2_000 } as never)
    expect(registry.boundFor("s")).toBe(5_000)
    expect(registry.boundFor("never-bounded")).toBeUndefined()
  })
})
