/**
 * Capability fan-out merge across several peer discoveries.
 *
 * A node of one substrate may peer with its own substrate's first node AND with a foreign
 * hub. Both can serve a vessel under the same bare vesselId (concept-db-local). Measured
 * defects this file pins:
 *   1. a row from one peer must never shadow a row of the same vesselId from ANOTHER peer;
 *   2. a failed peer (non-2xx, unreachable) must leave a journal line naming the peer and
 *      the status, instead of vanishing into an empty catch;
 *   3. a peer row advertising a loopback endpoint names the PEER's loopback, which from here
 *      is our own: it is rewritten onto the peer's host with the row's public port.
 * Controls pin what must not move: local rows, libp2p facade rows, non-loopback peer rows,
 * and the existing local-over-peer precedence on a vesselId collision.
 *
 * Peers are stubbed by injecting globalThis.fetch (no sockets, no network): each stub peer
 * is a handler keyed by its http origin.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Hono } from "hono"
import { createServer, registry, stampPeerRow } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetPeerCredentialState } from "../src/peer-credentials"

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_FANOUT_MODE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]

type Handler = () => Response | Promise<Response>
const realFetch = globalThis.fetch
let handlers: Record<string, Handler> = {}

function injectPeers(byOrigin: Record<string, Handler>): void {
  handlers = byOrigin
  process.env.PEER_DISCOVERY_ENDPOINTS = Object.keys(byOrigin).join(",")
}

const capabilityAnswer = (vessels: Array<Record<string, unknown>>, delayMs = 0): Handler => async () => {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  return Response.json({ content: { shape: "conceptQuery", vessels, found: vessels.length > 0 } })
}

const lines: string[] = []
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info }
function captureConsole() {
  for (const k of Object.keys(original) as Array<keyof typeof original>) {
    console[k] = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")) }
  }
}
function restoreConsole() {
  for (const k of Object.keys(original) as Array<keyof typeof original>) console[k] = original[k]
}

let app: Hono

async function capability(shape = "conceptQuery"): Promise<Array<Record<string, unknown>>> {
  const res = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "ApiKey caller" },
    body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { content: { vessels: Array<Record<string, unknown>> } }
  return body.content.vessels
}

/** The asking side's resolve-URL rule (an absolute resolve_endpoint verbatim, else joined
 *  onto endpoint) — the same rule this discovery's own /resolve forward uses. */
function buildResolveUrl(row: Record<string, unknown>): string {
  const re = String(row.resolve_endpoint ?? "/v2/impulses/resolve")
  return /^https?:\/\//.test(re) ? re : `${String(row.endpoint)}${re}`
}
const isLoopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)

beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  setIdentityValidator(async () => ({ orgId: "org-test", userId: "u", keyId: "k", scopes: ["read", "write"] }))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  handlers = {}
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const h = handlers[new URL(url).origin]
    if (!h) throw new TypeError(`Unable to connect. Is the computer able to access the url? ${url}`)
    return h()
  }) as unknown as typeof fetch
  app = createServer()
  lines.length = 0
  captureConsole()
})

afterEach(() => {
  restoreConsole()
  globalThis.fetch = realFetch
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n]
    else process.env[n] = savedEnv[n]
  }
  setIdentityValidator(null)
  registry.stop()
  __resetPeerCredentialState()
})

describe("peer merge - cross-peer shadowing", () => {
  it("two peers serving the same vesselId both appear, each stamped with its own origin", async () => {
    const node1 = "http://node1-shadow.test:18100"
    const hub = "http://hub-shadow.test:18100"
    injectPeers({
      // node 1 answers AFTER the hub: the hub's row must not swallow node 1's
      [node1]: capabilityAnswer([{ vesselId: "concept-db-local", endpoint: "http://10.0.0.1:8260", origin: "local" }], 30),
      [hub]: capabilityAnswer([{ vesselId: "concept-db-local", endpoint: "http://10.0.0.2:8260", origin: "local" }]),
    })
    const rows = (await capability()).filter((r) => r.vesselId === "concept-db-local")
    expect(rows.map((r) => r.origin).sort()).toEqual([`peer:${hub}`, `peer:${node1}`])
    expect(rows.find((r) => r.origin === `peer:${node1}`)!.endpoint).toBe("http://10.0.0.1:8260")
    expect(rows.find((r) => r.origin === `peer:${hub}`)!.endpoint).toBe("http://10.0.0.2:8260")
  })

  it("control - a vesselId repeated inside ONE peer answer is still collapsed to one row", async () => {
    const node1 = "http://node1-dup.test:18100"
    injectPeers({
      [node1]: capabilityAnswer([
        { vesselId: "concept-db-local", endpoint: "http://10.0.0.1:8260" },
        { vesselId: "concept-db-local", endpoint: "http://10.0.0.1:8261" },
      ]),
    })
    const rows = (await capability()).filter((r) => r.vesselId === "concept-db-local")
    expect(rows.length).toBe(1)
    expect(rows[0]!.endpoint).toBe("http://10.0.0.1:8260")
  })

  it("control - a LOCAL row still wins over a peer row of the same vesselId", async () => {
    registry.register({ vesselId: "concept-db-local", vesselName: "concept-db", endpoint: "http://127.0.0.1:8260", shapes: ["conceptQuery"] } as Parameters<typeof registry.register>[0])
    const node1 = "http://node1-prec.test:18100"
    const hub = "http://hub-prec.test:18100"
    injectPeers({
      [node1]: capabilityAnswer([{ vesselId: "concept-db-local", endpoint: "http://10.0.0.1:8260" }]),
      [hub]: capabilityAnswer([{ vesselId: "concept-db-local", endpoint: "http://10.0.0.2:8260" }, { vesselId: "other-on-hub", endpoint: "http://10.0.0.2:8300" }]),
    })
    const rows = await capability()
    const same = rows.filter((r) => r.vesselId === "concept-db-local")
    expect(same.length).toBe(1)
    expect(same[0]!.origin).toBe("local")
    expect(same[0]!.endpoint).toBe("http://127.0.0.1:8260")
    expect(rows.find((r) => r.vesselId === "other-on-hub")!.origin).toBe(`peer:${hub}`)
  })
})

describe("peer merge - failed peers are logged", () => {
  it("a peer answering 401 leaves a line naming the peer and status while the other peer still answers", async () => {
    const node1 = "http://node1-401.test:18100"
    const hub = "http://hub-401.test:18100"
    injectPeers({
      [node1]: () => Response.json({ error: "unauthorized" }, { status: 401 }),
      [hub]: capabilityAnswer([{ vesselId: "concept-db-local", endpoint: "http://10.0.0.2:8260" }]),
    })
    const rows = await capability()
    expect(rows.map((r) => r.origin)).toEqual([`peer:${hub}`])
    const named = lines.filter((l) => l.includes(node1) && l.includes("401"))
    expect(named.length).toBeGreaterThanOrEqual(1)
    expect(lines.join("\n")).not.toContain("ApiKey")
  })

  it("a peer answering 503 leaves a fanout line naming the peer and status", async () => {
    const node1 = "http://node1-503.test:18100"
    injectPeers({ [node1]: () => Response.json({ error: "busy" }, { status: 503 }) })
    await capability()
    expect(lines.filter((l) => l.includes(node1) && l.includes("503")).length).toBe(1)
  })

  it("an unreachable peer leaves a fanout line naming the peer", async () => {
    const node1 = "http://node1-down.test:18100"
    injectPeers({ [node1]: () => { throw new TypeError("Unable to connect") } })
    await capability()
    expect(lines.filter((l) => l.includes(node1) && /unreachable/i.test(l)).length).toBe(1)
  })

  it("a repeated failure of the same class logs once and a change of class logs again", async () => {
    const node1 = "http://node1-repeat.test:18100"
    let status = 503
    injectPeers({ [node1]: () => (status === 200 ? capabilityAnswer([])() : Response.json({}, { status })) })
    await capability()
    status = 500
    await capability()
    expect(lines.filter((l) => l.includes(node1)).length).toBe(1)
    status = 404
    await capability()
    expect(lines.filter((l) => l.includes(node1)).length).toBe(2)
    status = 200
    await capability()
    status = 404
    await capability()
    expect(lines.filter((l) => l.includes(node1) && l.includes("404")).length).toBe(2)
  })
})

describe("peer merge - loopback endpoints are rewritten onto the peer host", () => {
  it("a peer row with loopback endpoint and public_endpoint is rewritten to the peer host and public port", async () => {
    const node1 = "http://node1-loop.test:18100"
    injectPeers({
      [node1]: capabilityAnswer([{
        vesselId: "concept-db-local", endpoint: "http://127.0.0.1:8260", public_endpoint: "http://127.0.0.1:18260",
        resolve_endpoint: "/v2/impulses/resolve",
      }]),
    })
    const row = (await capability()).find((r) => r.vesselId === "concept-db-local")
    expect(row).toBeDefined()
    expect(row!.endpoint).toBe("http://node1-loop.test:18260")
    expect(row!.public_endpoint).toBe("http://node1-loop.test:18260")
    expect(isLoopback(buildResolveUrl(row!))).toBe(false)
    expect(buildResolveUrl(row!)).toBe("http://node1-loop.test:18260/v2/impulses/resolve")
  })

  it("an absolute loopback resolve_endpoint is rewritten onto the peer host and public port", () => {
    const row = stampPeerRow({
      vesselId: "concept-db-local", endpoint: "http://localhost:8260", public_endpoint: "http://localhost:18260",
      resolve_endpoint: "http://127.0.0.1:8260/v2/impulses/resolve",
    }, "http://node1-abs.test:18100")
    expect(row.endpoint).toBe("http://node1-abs.test:18260")
    expect(row.resolve_endpoint).toBe("http://node1-abs.test:18260/v2/impulses/resolve")
    expect(isLoopback(buildResolveUrl(row))).toBe(false)
  })

  it("a loopback peer row with no public port is left as is and marked endpoint_unreachable", () => {
    const row = stampPeerRow({ vesselId: "x", endpoint: "http://[::1]:8260" }, "http://node1-nopub.test:18100")
    expect(row.endpoint).toBe("http://[::1]:8260")
    expect(row.endpoint_unreachable).toBe(true)
  })

  it("control - a libp2p facade peer row is not rewritten", () => {
    const facade = {
      vesselId: "concept-db-local@remote", protocol: "libp2p", endpoint: "http://127.0.0.1:8260",
      public_endpoint: "http://127.0.0.1:18260", libp2p_multiaddr: ["/ip4/10.0.0.9/tcp/1/p2p/12D3KooWFacade"],
    }
    const row = stampPeerRow(facade, "http://node1-facade.test:18100")
    expect(row.endpoint).toBe("http://127.0.0.1:8260")
    expect(row.public_endpoint).toBe("http://127.0.0.1:18260")
    expect(row.endpoint_unreachable).toBeUndefined()
  })

  it("control - a peer row with a non-loopback endpoint is unchanged", () => {
    const row = stampPeerRow({
      vesselId: "x", endpoint: "http://10.0.0.1:8260", public_endpoint: "http://10.0.0.1:18260",
      resolve_endpoint: "http://10.0.0.1:8260/v2/impulses/resolve",
    }, "http://node1-real.test:18100")
    expect(row.endpoint).toBe("http://10.0.0.1:8260")
    expect(row.public_endpoint).toBe("http://10.0.0.1:18260")
    expect(row.resolve_endpoint).toBe("http://10.0.0.1:8260/v2/impulses/resolve")
    expect(row.endpoint_unreachable).toBeUndefined()
  })

  it("control - a local loopback row is returned unchanged alongside a rewritten peer row", async () => {
    registry.register({ vesselId: "local-concepts", vesselName: "c", endpoint: "http://127.0.0.1:8261", shapes: ["conceptQuery"] } as Parameters<typeof registry.register>[0])
    const node1 = "http://node1-mixed.test:18100"
    injectPeers({ [node1]: capabilityAnswer([{ vesselId: "concept-db-local", endpoint: "http://127.0.0.1:8260", public_endpoint: "http://127.0.0.1:18260" }]) })
    const rows = await capability()
    const local = rows.find((r) => r.vesselId === "local-concepts")!
    expect(local.endpoint).toBe("http://127.0.0.1:8261")
    expect(local.origin).toBe("local")
    expect(rows.find((r) => r.vesselId === "concept-db-local")!.endpoint).toBe("http://node1-mixed.test:18260")
  })
})
