/**
 * A CLIENT CONNECTED FROM OUTSIDE (src/client-connected.ts): the first validated request of each key whose socket is not
 * loopback is written to records as a client_connected row, by this discovery, so the fleet's status can read that a
 * client reached it. The row names the key, the path and the node key it was written under, never the client's address. These drive the real middleware with a stub validator and a socket address the server reports, as
 * Bun's server does.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Hono } from "hono"
import { authMiddleware, setClientObserver, setIdentityValidator } from "../src/middleware/auth"
import { type Connected, clientObserver, isLoopback, writeConnectedVia } from "../src/client-connected"

const KEYS: Record<string, string> = { "key-one": "k1", "key-two": "k2" }
beforeAll(() => setIdentityValidator(async (k) => (KEYS[k] ? { orgId: "o", userId: "u", keyId: KEYS[k], scopes: ["write"] } : null)))
afterAll(() => setIdentityValidator(null))

const app = new Hono()
app.use("*", authMiddleware)
app.post("/resolve", (c) => c.json({ ok: true }))
app.get("/health", (c) => c.json({ ok: true }))
app.post("/register", (c) => c.json({ ok: true }))

const from = (address: string | undefined) => ({ requestIP: () => (address === undefined ? null : { address }) })
const call = (key: string | undefined, address: string | undefined, headers: Record<string, string> = {}, path = "/resolve") =>
  app.request(path, { method: path === "/health" ? "GET" : "POST", headers: { ...(key ? { Authorization: `ApiKey ${key}` } : {}), ...headers } }, from(address))

/** An observer over a write the test answers: each call waits until the test settles it. */
function observed() {
  const calls: Connected[] = []
  const settle: Array<(ok: boolean) => void> = []
  setClientObserver(clientObserver((row) => { calls.push(row); return new Promise<boolean>((r) => settle.push(r)) }))
  return { calls, settle }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => setClientObserver(null))

describe("which requests are recorded", () => {
  it("[MUST-FAIL] a keyed request from outside the container writes one row with its key; the same key again writes none", async () => {
    const o = observed()
    expect((await call("key-one", "172.17.0.1")).status).toBe(200)
    expect(o.calls).toEqual([{ key_id: "k1", path: "/resolve" }])
    o.settle[0](true)
    await tick()
    expect((await call("key-one", "198.51.100.7")).status).toBe(200)
    expect(o.calls).toHaveLength(1)
  })

  it("[GUARD] a loopback request writes none, whatever address it forwards", async () => {
    const o = observed()
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect((await call("key-one", a, { "x-forwarded-for": "203.0.113.9" })).status).toBe(200)
    }
    expect(o.calls).toEqual([])
  })

  it("[GUARD] an unkeyed, a refused or an unaddressed request writes none", async () => {
    const o = observed()
    expect((await call(undefined, "203.0.113.9", {}, "/health")).status).toBe(200)
    expect((await call("key-bad", "203.0.113.9")).status).toBe(401)
    expect((await call("key-one", undefined)).status).toBe(200)
    expect(o.calls).toEqual([])
  })

  it("[GUARD] a write records did not take is tried again on the key's next request; the request answers as before", async () => {
    const o = observed()
    expect((await call("key-one", "203.0.113.9")).status).toBe(200)
    o.settle[0](false)
    await tick()
    expect((await call("key-one", "203.0.113.9")).status).toBe(200)
    expect(o.calls).toHaveLength(2)
  })

  it("[GUARD] one write per key is in flight: 50 requests of a key while records has not answered start one", async () => {
    const o = observed()
    const answers = await Promise.all(Array.from({ length: 50 }, () => call("key-one", "203.0.113.9")))
    expect(answers.every((r) => r.status === 200)).toBe(true)
    expect(o.calls).toHaveLength(1)
  })

  it("[GUARD] the row names the path the key's first request asked for, not one path for every request", async () => {
    const o = observed()
    expect((await call("key-two", "203.0.113.9", {}, "/register")).status).toBe(200)
    expect(o.calls).toEqual([{ key_id: "k2", path: "/register" }])
  })

  it("[GUARD] each key writes its own row", async () => {
    const o = observed()
    await call("key-one", "203.0.113.9")
    await call("key-two", "203.0.113.9")
    expect(o.calls.map((c) => c.key_id)).toEqual(["k1", "k2"])
  })
})

describe("the observer itself", () => {
  it("[GUARD] a validated principal with no key id, from outside, writes none", () => {
    const calls: Connected[] = []
    const seen = clientObserver(async (row) => { calls.push(row); return true })
    seen(undefined, "10.0.0.5", "/resolve")
    seen("", "10.0.0.5", "/resolve")
    expect(calls).toEqual([])
  })
})

describe("what loopback is", () => {
  it("[GUARD] the container's own addresses only", () => {
    for (const a of ["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1", "::FFFF:127.1.2.3"]) expect(isLoopback(a)).toBe(true)
    for (const a of ["172.17.0.1", "10.0.0.1", "128.0.0.1", "::ffff:10.0.0.1", "fe80::1", "0.0.0.0", "", "localhost"]) expect(isLoopback(a)).toBe(false)
  })
})

describe("the row records is sent", () => {
  const serve = (handler: (req: Request) => Response | Promise<Response>) => Bun.serve({ port: 0, fetch: handler })

  it("[MUST-FAIL] exactly a record_write of client_connected {key_id, path, node_key_id}, as this discovery (writer its id, role detector), under the node key", async () => {
    let got: { url: string; auth: string | null; body: unknown } | undefined
    const s = serve(async (req) => { got = { url: new URL(req.url).pathname, auth: req.headers.get("Authorization"), body: await req.json() }; return Response.json({ id: "r1", seq: 9 }) })
    try {
      const write = writeConnectedVia(`http://127.0.0.1:${s.port}`, () => "node-key", () => "discovery-vessel", async (k) => (k === "node-key" ? "nk1" : null))
      expect(await write({ key_id: "k1", path: "/resolve" })).toBe(true)
      expect(got).toEqual({
        url: "/resolve",
        auth: "ApiKey node-key",
        body: { pointer: { type: "record_write", row: { shape: "client_connected", key_id: "k1", path: "/resolve", node_key_id: "nk1", input_refs: [] }, writer: "discovery-vessel", role: "detector" } },
      })
    } finally { s.stop(true) }
  })

  it("[GUARD] not taken unless records answers 2xx with the row's id; no node key sends nothing", async () => {
    let n = 0
    for (const answer of [() => Response.json({ id: "r1" }, { status: 503 }), () => Response.json({ failure: {} }), () => Response.json({ id: 7 })]) {
      const s = serve(() => { n++; return answer() })
      try { expect(await writeConnectedVia(`http://127.0.0.1:${s.port}`, () => "node-key", () => "d", async () => "nk")({ key_id: "k", path: "/" })).toBe(false) }
      finally { s.stop(true) }
    }
    expect(n).toBe(3)
    const s = serve(() => { n++; return Response.json({ id: "r1" }) })
    try { expect(await writeConnectedVia(`http://127.0.0.1:${s.port}`, () => "", () => "d", async () => "nk")({ key_id: "k", path: "/" })).toBe(false) }
    finally { s.stop(true) }
    expect(n).toBe(3)
    expect(await writeConnectedVia("http://127.0.0.1:9", () => "node-key", () => "d", async () => "nk")({ key_id: "k", path: "/" })).toBe(false)
  })

  it("[GUARD] why a write was not taken is said once per cause, however often it recurs", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let key = ""
      const write = writeConnectedVia("http://127.0.0.1:9", () => key, () => "d", async () => null)
      expect(await write({ key_id: "k1", path: "/" })).toBe(false)
      expect(await write({ key_id: "k2", path: "/" })).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain("no node key")
      expect(String(warn.mock.calls[0][0])).not.toContain("k1")
      key = "node-key"
      expect(await write({ key_id: "k1", path: "/" })).toBe(false)
      expect(await write({ key_id: "k2", path: "/" })).toBe(false)
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[1][0])).toContain("not known")
    } finally { warn.mockRestore() }
  })

  it("[GUARD] when the node key's id is not known, nothing is sent", async () => {
    let n = 0
    const s = serve(() => { n++; return Response.json({ id: "r1" }) })
    try { expect(await writeConnectedVia(`http://127.0.0.1:${s.port}`, () => "node-key", () => "d", async () => null)({ key_id: "k", path: "/" })).toBe(false) }
    finally { s.stop(true) }
    expect(n).toBe(0)
  })
})
