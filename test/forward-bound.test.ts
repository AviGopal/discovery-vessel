/**
 * A call forwarded to a peer, for a shape no producer here serves now, waits as long as the peers' producers of that shape
 * say a call may take (resolve_timeout_ms on the rows mirrored here from them), not a fixed 10 s (the USER, 11-15:
 * "Use producer's bound"). Nothing is remembered from a local producer. Live: node1's llm-resolver went dark, its llm_completion calls were forwarded to the hub,
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
      const t = setTimeout(() => resolve(Response.json({ resolved: true, shape: "slow_shape", content: "late answer" })), after)
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

// the peer answers after `after` ms unless the forward's signal aborts first
let after = 10_500
const mirror = (bound?: number) => registry.register({ vesselId: "producer@peer", vesselName: "producer@peer", version: "1",
  endpoint: "http://127.0.0.1:1", shapes: ["slow_shape"], systemVessel: true, protocol: "libp2p", ...(bound !== undefined ? { resolve_timeout_ms: bound } : {}) } as never)
const resolve = () => app.request("/resolve", { method: "POST", headers: AUTH, body: JSON.stringify({ pointer: { type: "slow_shape" } }) })

describe("forward bound", () => {
  it("[MUST-FAIL] (a) a peer row bounding the shape at 30 s: a forwarded call answering at 10.5 s returns 200", async () => {
    after = 10_500
    mirror(30_000)
    registry.list().filter((v) => v.vesselId === "producer@peer").forEach((v) => { v.status = "unhealthy" as never }) // listed, not routed to directly
    const res = await resolve()
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain("late answer")
  }, 20_000)

  it("[MUST-FAIL] (b) a peer row bounding it at 5 s cuts a 6 s answer at 5 s, whatever a local producer once advertised", async () => {
    after = 6_000
    registry.register({ vesselId: "local-producer", vesselName: "local-producer", version: "1", endpoint: "http://local.test", shapes: ["slow_shape"], systemVessel: true, resolve_timeout_ms: 30_000 } as never)
    registry.unregister("local-producer")
    mirror(5_000)
    registry.list().filter((v) => v.vesselId === "producer@peer").forEach((v) => { v.status = "unhealthy" as never })
    const t0 = Date.now()
    const res = await resolve()
    expect(res.status).not.toBe(200)
    expect(Date.now() - t0).toBeLessThan(5_900)
  }, 20_000)

  it("(c) no peer row bounds it: the default 10 s, as before", () => {
    mirror()
    expect(registry.peerBoundFor("slow_shape")).toBeUndefined()
    expect(registry.peerBoundFor("never-mirrored")).toBeUndefined()
  })

  it("[MUST-FAIL] another org's peer row bounding the shape at 30 s does not lift the 10 s default (qa)", () => {
    registry.register({ vesselId: "producer@stranger", vesselName: "producer@stranger", version: "1", endpoint: "http://127.0.0.1:2",
      shapes: ["slow_shape"], orgId: "org-stranger", protocol: "libp2p", resolve_timeout_ms: 30_000 } as never)
    expect(registry.peerBoundFor("slow_shape", "org-test")).toBeUndefined()
    expect(registry.peerBoundFor("slow_shape", "org-stranger")).toBe(30_000)
  })
})
