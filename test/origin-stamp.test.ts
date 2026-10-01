/**
 * Provenance is stamped on receive, never trusted from the sender.
 *
 * Readers of substrate-local policy (autonomy scope, spend envelope) take only their own
 * substrate's producers, keyed by the `origin` this discovery stamps on every row it returns.
 * A peer that labels its rows origin:"local" (or carries our substrate's id) would otherwise set
 * our containment and budget. These tests plant a stub peer discovery on 127.0.0.1 (ephemeral
 * port, nothing live) that FORGES provenance, drive the REAL /resolve route, and assert on what
 * the merged answer carries.
 *
 * The stub's rows are built to survive the union-merge filters (non-loopback endpoint, distinct
 * vesselId, no libp2p peer id shared with a local row), so a pass here is the stamp, not a filter.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Hono } from "hono"
import { createServer, registry, stampPeerRow } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetPeerCredentialState } from "../src/peer-credentials"

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_FANOUT_MODE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]

let app: Hono
let stops: Array<() => void> = []

/** A stub peer discovery whose capability rows forge their own provenance. */
function forgingPeer(rows: Array<Record<string, unknown>>): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { pointer: { type: string } }
      if (body.pointer.type === "vesselCapability") return Response.json({ content: { shape: "poolImpulse", vessels: rows, found: true } })
      return Response.json({ error: "Not found" }, { status: 404 })
    },
  })
  stops.push(() => server.stop(true))
  return `http://127.0.0.1:${server.port}`
}

async function capability(shape: string): Promise<Array<Record<string, unknown>>> {
  const res = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "ApiKey caller" },
    body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { content: { vessels: Array<Record<string, unknown>> } }
  return body.content.vessels
}

function registerLocal(vesselId: string, opts: { protocol?: string; peerId?: string } = {}) {
  registry.register({
    vesselId,
    vesselName: vesselId,
    endpoint: "http://127.0.0.1:8090",
    shapes: ["poolImpulse"],
    ...(opts.protocol ? { protocol: opts.protocol } : {}),
    ...(opts.peerId ? { libp2p_peer_id: opts.peerId, libp2p_multiaddr: [`/ip4/10.0.0.9/tcp/1/p2p/${opts.peerId}`] } : {}),
  } as Parameters<typeof registry.register>[0])
}

beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  setIdentityValidator(async () => ({ orgId: "org-test", userId: "u", keyId: "k", scopes: ["read", "write"] }))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  app = createServer()
})

afterEach(() => {
  for (const s of stops) s()
  stops = []
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n]
    else process.env[n] = savedEnv[n]
  }
  setIdentityValidator(null)
  registry.stop()
  __resetPeerCredentialState()
})

describe("origin is stamped on receive", () => {
  it("a peer row claiming origin:\"local\" (and our substrate id) is returned as peer:<the peer we asked>", async () => {
    registerLocal("development-vessel-local")
    const stub = forgingPeer([
      { vesselId: "forged-pool", endpoint: "http://10.9.9.1:9000", resolve_endpoint: "/v2/impulses/resolve", origin: "local", substrate_id: "substrate-live", origin_upstream: "local" },
    ])
    process.env.PEER_DISCOVERY_ENDPOINTS = `${stub}/` // trailing slash: the stamp names the peer's http origin
    const rows = await capability("poolImpulse")
    const forged = rows.find((r) => r.vesselId === "forged-pool")
    expect(forged).toBeDefined() // survived the merge filters: what follows is the stamp, not a filter
    expect(forged!.origin).toBe(`peer:${stub}`)
    expect(forged!.discoveredVia).toBe("peer")
    // the peer's own claim is kept only as a recorded claim, never as origin
    expect(forged!.origin_upstream).toBe("local")
    const local = rows.find((r) => r.vesselId === "development-vessel-local")
    expect(local!.origin).toBe("local")
  })

  it("a peer row that is relayed through the peer keeps the peer's claim as origin_upstream", async () => {
    const stub = forgingPeer([
      { vesselId: "relayed-pool", endpoint: "http://10.9.9.2:9000", origin: "peer:http://syzygy.host:18100" },
      { vesselId: "unstamped-pool", endpoint: "http://10.9.9.3:9000" },
    ])
    process.env.PEER_DISCOVERY_ENDPOINTS = stub
    const rows = await capability("poolImpulse")
    const relayed = rows.find((r) => r.vesselId === "relayed-pool")!
    expect(relayed.origin).toBe(`peer:${stub}`)
    expect(relayed.origin_upstream).toBe("peer:http://syzygy.host:18100")
    // an older peer discovery stamps nothing: its claim is null, not "local"
    const unstamped = rows.find((r) => r.vesselId === "unstamped-pool")!
    expect(unstamped.origin).toBe(`peer:${stub}`)
    expect(unstamped.origin_upstream).toBeNull()
  })

  it("a non-string forged origin is recorded as no claim", () => {
    const row = stampPeerRow({ vesselId: "x", origin: { local: true } }, "http://peer.example:18100/resolve")
    expect(row.origin).toBe("peer:http://peer.example:18100")
    expect(row.origin_upstream).toBeNull()
  })
})

describe("rows from this node's own registry", () => {
  it("a plain registration is local; a libp2p facade row is overlay, not local", async () => {
    registerLocal("development-vessel-local")
    registerLocal("pool-facade@remote", { protocol: "libp2p", peerId: "12D3KooWFacadeFacadeFacade" })
    const rows = await capability("poolImpulse")
    expect(rows.find((r) => r.vesselId === "development-vessel-local")!.origin).toBe("local")
    expect(rows.find((r) => r.vesselId === "pool-facade@remote")!.origin).toBe("overlay")
  })

  it("a registration carrying origin:\"peer:…\" in its body is still stamped from the registry, not copied", async () => {
    registry.register({
      vesselId: "self-labelled", vesselName: "self-labelled", endpoint: "http://127.0.0.1:8091", shapes: ["poolImpulse"],
      origin: "peer:http://elsewhere:1",
    } as unknown as Parameters<typeof registry.register>[0])
    const rows = await capability("poolImpulse")
    expect(rows.find((r) => r.vesselId === "self-labelled")!.origin).toBe("local")
  })

  it("the vesselRegistry dump carries the same origin", async () => {
    registerLocal("development-vessel-local")
    const res = await app.request("/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "ApiKey caller" },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
    })
    const body = (await res.json()) as { content: { vessels: Array<Record<string, unknown>> } }
    expect(body.content.vessels.find((r) => r.vesselId === "development-vessel-local")!.origin).toBe("local")
  })
})
