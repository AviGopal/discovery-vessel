/**
 * A write forwarded to peers is sent to one peer only, unless that peer cannot have stored it. With no local producer,
 * discovery forwards a resolve to its peer discoveries in turn. For a read, a peer that answers non-2xx is skipped and the
 * next is asked. For a state-changing (`_write`) shape, an answer other than "no producer" (404) is the write's answer:
 * the owner's refusal, a failure after the owner may have stored, or a 2xx whose body does not parse. Any throw but one
 * that proves the request never left (connection refused, no such host) may have stored it too: a timeout, a reset after
 * send. Sending it on to a peer that reaches the same owner would store it twice.
 *
 * Two peers are recording stubs behind an injected globalThis.fetch (no sockets); the first answers as each case says.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Hono } from "hono"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetPeerCredentialState } from "../src/peer-credentials"

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_FANOUT_MODE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]

const FIRST = "http://peer-first.test:18100"
const SECOND = "http://peer-second.test:18100"
const realFetch = globalThis.fetch
let received: string[] = []
let first: () => Response | Promise<Response> = () => Response.json({ shape: "ok", body: { stored: true } })
let app: Hono

function resolve(shape: string) {
  return app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "ApiKey writer" },
    body: JSON.stringify({ pointer: { type: shape, payload: { note: "x" } } }),
  })
}
const calls = (origin: string) => received.filter((o) => o === origin).length
const timeout = () => { throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }) }
// As Bun's fetch reports them: a connection never opened, and one reset after the request went out.
const unreachable = () => { throw Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" }) }
const resetAfterSend = () => { throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }) }

const original = { log: console.log, warn: console.warn }
beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  process.env.HUB_API_KEY = "forwarder-node-key"
  process.env.PEER_DISCOVERY_ENDPOINTS = `${FIRST},${SECOND}`
  setIdentityValidator(async (k) => (k === "writer" ? { orgId: "org-test", userId: "u", keyId: k, scopes: ["read", "write"] } : null))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  received = []
  first = () => Response.json({ shape: "ok", body: { stored: true } })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin
    received.push(origin)
    if (origin === FIRST) return first()
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

describe("forward - a write goes to one peer unless that peer cannot have stored it", () => {
  it("MUST-FAIL: the first peer fails a write (503): its answer is returned, the second peer receives nothing", async () => {
    first = () => Response.json({ failure: { status: 503, body: "owner failed after write" } }, { status: 503 })
    const res = await resolve("record_write")
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).toContain("owner failed after write")
    expect(calls(SECOND)).toBe(0)
  })

  it("MUST-FAIL: the first peer refuses a write (403): the refusal is returned, not 404, and the second peer receives nothing", async () => {
    first = () => Response.json({ failure: { status: 403, body: "cross-node writes wait for person marking" } }, { status: 403 })
    const res = await resolve("record_write")
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).toContain("person marking")
    expect(calls(SECOND)).toBe(0)
  })

  it("MUST-FAIL: the first peer times out on a write: 504, and the second peer receives nothing", async () => {
    first = timeout
    const res = await resolve("record_write")
    expect(res.status).toBe(504)
    expect(((await res.json()) as { error?: string }).error).toBe("peer_timeout")
    expect(calls(SECOND)).toBe(0)
  })

  it("MUST-FAIL: the first peer stores a write and answers 200 with a body that is not JSON: that is the answer, the second peer receives nothing", async () => {
    first = () => new Response("stored", { status: 200 })
    const res = await resolve("record_write")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { raw?: string }).raw).toBe("stored")
    expect(calls(SECOND)).toBe(0)
  })

  it("MUST-FAIL: the first peer's connection resets after the write went out: 502, and the second peer receives nothing", async () => {
    first = resetAfterSend
    const res = await resolve("record_write")
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error?: string }).error).toBe("peer_failed_after_send")
    expect(calls(SECOND)).toBe(0)
  })

  it("control - the first peer has no producer for a write (404): the second peer is asked", async () => {
    first = () => Response.json({ error: "Not found" }, { status: 404 })
    const res = await resolve("record_write")
    expect(res.status).toBe(200)
    expect(calls(SECOND)).toBe(1)
  })

  it("control - the first peer is unreachable for a write (nothing sent): the second peer is asked", async () => {
    first = unreachable
    const res = await resolve("record_write")
    expect(res.status).toBe(200)
    expect(calls(SECOND)).toBe(1)
  })

  it("control - a read whose first peer fails (503), times out, resets, or answers a body that is not JSON still asks the second peer", async () => {
    first = () => Response.json({ error: "x" }, { status: 503 })
    expect((await resolve("record_read")).status).toBe(200)
    expect(calls(SECOND)).toBe(1)
    first = timeout
    expect((await resolve("record_read")).status).toBe(200)
    expect(calls(SECOND)).toBe(2)
    first = resetAfterSend
    expect((await resolve("record_read")).status).toBe(200)
    expect(calls(SECOND)).toBe(3)
    first = () => new Response("not json", { status: 200 })
    expect((await resolve("record_read")).status).toBe(200)
    expect(calls(SECOND)).toBe(4)
  })

  it("control - a write the first peer stores (200) is answered by it alone", async () => {
    const res = await resolve("record_write")
    expect(res.status).toBe(200)
    expect(calls(FIRST)).toBe(1)
    expect(calls(SECOND)).toBe(0)
  })
})
