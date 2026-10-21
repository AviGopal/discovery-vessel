/**
 * A forward must not escalate (confused deputy). With no local producer, discovery forwards a resolve to a peer
 * discovery with the credential postToPeer chooses (the mapped peer key or HUB_API_KEY when set), so the receiver
 * judges the FORWARDER. A state-changing (`_write`) shape is therefore refused before any peer is contacted unless the
 * caller's own validated scopes include write or admin.
 *
 * Identity is stubbed per key; the peer is a recording stub behind an injected globalThis.fetch (no sockets).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Hono } from "hono"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetPeerCredentialState } from "../src/peer-credentials"

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_FANOUT_MODE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]

const PEER = "http://peer-hub.test:18100"
const LOCAL_WRITER = "http://local-writer.test:8300"
const SCOPES: Record<string, string[]> = { reader: ["read"], writer: ["read", "write"], admin: ["admin"] }
const realFetch = globalThis.fetch
let received: Array<{ origin: string; authorization: string | null; body: string }> = []
let app: Hono

function resolveAs(key: string | null, shape: string) {
  return app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
    body: JSON.stringify({ pointer: { type: shape, payload: { note: "x" } } }),
  })
}
const peerCalls = () => received.filter((r) => r.origin === PEER)

const original = { log: console.log, warn: console.warn }
beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  // The forwarder's own key: what the peer judges when discovery forwards today.
  process.env.HUB_API_KEY = "forwarder-node-key"
  process.env.PEER_DISCOVERY_ENDPOINTS = PEER
  setIdentityValidator(async (k) => (SCOPES[k] ? { orgId: "org-test", userId: "u", keyId: k, scopes: SCOPES[k]! } : null))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  received = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    received.push({ origin: new URL(url).origin, authorization: headers.get("Authorization"), body: String(init?.body ?? "") })
    return Response.json({ shape: "ok", body: { stored: true } })
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

describe("forward scope - a write with no local producer", () => {
  it("MUST-FAIL: a read-scoped caller's _write shape is refused 403 and the peer receives nothing", async () => {
    const res = await resolveAs("reader", "conceptLink_write")
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe("caller_lacks_write_scope")
    expect(peerCalls().length).toBe(0)
  })

  it("control - a read,write caller's _write shape is forwarded as today", async () => {
    const res = await resolveAs("writer", "conceptLink_write")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(1)
    expect(peerCalls()[0]!.body).toContain("conceptLink_write")
  })

  it("control - an admin caller's _write shape is forwarded", async () => {
    const res = await resolveAs("admin", "conceptLink_write")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(1)
  })

  it("control - a read-scoped caller's READ shape still forwards", async () => {
    const res = await resolveAs("reader", "conceptQuery")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(1)
  })

  it("control - a key identity cannot validate (unknown or identity unreachable) is refused before any forward", async () => {
    const res = await resolveAs("unknown-key", "conceptLink_write")
    expect(res.status).toBe(401)
    expect(received.length).toBe(0)
  })
})

describe("forward scope - a local producer is unchanged", () => {
  it("control - a read-scoped caller's _write shape goes to the LOCAL producer with the caller's own header", async () => {
    registry.register({ vesselId: "concept-db-local", vesselName: "concept-db", endpoint: LOCAL_WRITER, shapes: ["conceptLink_write"], systemVessel: true } as Parameters<typeof registry.register>[0])
    const res = await resolveAs("reader", "conceptLink_write")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(0)
    const local = received.filter((r) => r.origin === LOCAL_WRITER)
    expect(local.length).toBe(1)
    expect(local[0]!.authorization).toBe("ApiKey reader")
  })
})
