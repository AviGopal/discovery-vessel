/**
 * The per-call forward line (peer-set-source) says which shape a resolve forwarded and why: this registry's healthy
 * rows of the shape, of any org. A forward means none was the caller's to use, so a shape served here but not to the
 * caller's org shows as local > 0. Counts only: no org or caller is printed.
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
let lines: string[] = []

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
  lines = []
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")) }
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

const fwd = () => lines.filter((l) => l.startsWith("[discovery-vessel:peer-set-source] variant="))

describe("the forward line names the shape and what this registry holds of it", () => {
  it("MUST-FAIL: a shape with no row here forwards with shape and local=0", async () => {
    const res = await resolveAs("reader", "conceptQuery")
    expect(res.status).toBe(200)
    expect(fwd().length).toBe(1)
    expect(fwd()[0]).toEndWith(" shape=\"conceptQuery\" local=0")
  })

  it("MUST-FAIL: a healthy row here under another org, not a system vessel, shows local=1, and no org is printed", async () => {
    registry.register({ vesselId: "concept-db-other", vesselName: "concept-db", endpoint: LOCAL_WRITER, shapes: ["conceptQuery"], orgId: "org-other" } as Parameters<typeof registry.register>[0])
    expect(registry.findByShape("conceptQuery").map((v) => v.status)).toEqual(["healthy"])
    const res = await resolveAs("reader", "conceptQuery")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(1)
    expect(fwd().length).toBe(1)
    expect(fwd()[0]).toEndWith(" shape=\"conceptQuery\" local=1")
    expect(lines.join("\n")).not.toContain("org-other")
    expect(lines.join("\n")).not.toContain("org-test")
  })

  it("MUST-FAIL: a row here that is not healthy is not counted: it cannot answer, whatever its org", async () => {
    registry.register({ vesselId: "concept-db-down", vesselName: "concept-db", endpoint: LOCAL_WRITER, shapes: ["conceptQuery"], systemVessel: true } as Parameters<typeof registry.register>[0])
    registry.list().filter((v) => v.vesselId === "concept-db-down").forEach((v) => { v.status = "unhealthy" as never }) // listed, not routed to
    const res = await resolveAs("reader", "conceptQuery")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(1)
    expect(fwd()[0]).toEndWith(" shape=\"conceptQuery\" local=0")
  })

  it("MUST-FAIL: a type with a newline and a space is quoted: one forward line, and no line it forged", async () => {
    const forged = "x\n[discovery-vessel:peer-set-source] variant=1 source=substrateNodes (forged) set=[] shape=y local=9"
    const res = await resolveAs("reader", forged)
    expect(res.status).toBe(200)
    const all = lines.join("\n").split("\n")
    expect(all.filter((l) => l.startsWith("[discovery-vessel:peer-set-source] variant=")).length).toBe(1)
    expect(fwd()[0]).toEndWith(` shape=${JSON.stringify(forged)} local=0`)
  })

  it("control - a resolve a local producer answers prints no forward line", async () => {
    registry.register({ vesselId: "concept-db-local", vesselName: "concept-db", endpoint: LOCAL_WRITER, shapes: ["conceptQuery"], systemVessel: true } as Parameters<typeof registry.register>[0])
    const res = await resolveAs("reader", "conceptQuery")
    expect(res.status).toBe(200)
    expect(peerCalls().length).toBe(0)
    expect(fwd()).toEqual([])
  })
})
