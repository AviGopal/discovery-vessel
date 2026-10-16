/**
 * REACHABILITY (a): a libp2p row is dialled through THIS node's federation egress, so when that egress is not live the
 * capability answer stamps the row egress_unreachable (never drops it) and a caller prefers a local producer.
 *
 * Measured 2026-10-16 on a node whose transport is masked by a deliberate containment hold: discovery offered the hub's
 * libp2p peer rows for gapDecomposition, the walk picked one after a missed local probe, and every call was refused at
 * the dead egress ("Unable to connect"). Liveness is read at use time from what already exists: the transport's own
 * self-row in this registry (its heartbeat keeps it fresh) and its /health not REFUSING a connection (the 400 ms
 * dead-row pattern; fail-open on anything but a refusal). Recomputed per answer, so a transport that comes back clears
 * the stamp on the next call.
 *
 * Peers and the egress are stubbed by injecting globalThis.fetch by origin (no sockets, no network).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { Hono } from "hono"
import { createServer, localEgressLiveness, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetPeerCredentialState } from "../src/peer-credentials"

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_FANOUT_MODE"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]
const realFetch = globalThis.fetch
const quiet = { log: console.log, warn: console.warn }
let handlers: Record<string, () => Response | Promise<Response>> = {}
let app: Hono

const HUB = "http://hub-egress.test:18100"
const EGRESS = "http://127.0.0.1:8401"
const peerLibp2pRow = { vesselId: "development-vessel-local@hub", endpoint: "http://127.0.0.1:8401", protocol: "libp2p", libp2p_multiaddr: ["/dns4/relay.test/tcp/1/p2p/12D3KooWTestRelay/p2p-circuit/p2p/12D3KooWTestPeer"], libp2p_peer_id: "12D3KooWTestPeer" }
const transportSelfRow = { vesselId: "federation-transport-local", vesselName: "federation-transport-local", endpoint: EGRESS, protocol: "libp2p", shapes: ["federation_probe", "federation_verification_report", "substrateBootstrap"] }

async function capability(shape = "gapDecomposition"): Promise<Array<Record<string, unknown>>> {
  const res = await app.request("/resolve", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey caller" }, body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }) })
  expect(res.status).toBe(200)
  return ((await res.json()) as { content: { vessels: Array<Record<string, unknown>> } }).content.vessels
}

beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  setIdentityValidator(async () => ({ orgId: "org-test", userId: "u", keyId: "k", scopes: ["read", "write"] }))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  handlers = { [HUB]: () => Response.json({ content: { shape: "gapDecomposition", vessels: [peerLibp2pRow], found: true } }) }
  process.env.PEER_DISCOVERY_ENDPOINTS = HUB
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const h = handlers[new URL(url).origin]
    if (!h) throw new TypeError(`Unable to connect. Is the computer able to access the url? ${url}`)
    return h()
  }) as unknown as typeof fetch
  app = createServer()
  console.log = () => {}; console.warn = () => {}
})
afterEach(() => {
  console.log = quiet.log; console.warn = quiet.warn
  globalThis.fetch = realFetch
  for (const n of ENV_NAMES) { if (savedEnv[n] === undefined) delete process.env[n]; else process.env[n] = savedEnv[n] }
  setIdentityValidator(null)
  registry.stop()
  __resetPeerCredentialState()
})

const reg = (r: Record<string, unknown>) => registry.register(r as Parameters<typeof registry.register>[0])

describe("a libp2p row is stamped when this node's egress is not live", () => {
  it("[MUST-FAIL] no local transport registered (masked): the peer libp2p row is stamped egress_unreachable", async () => {
    const row = (await capability()).find((r) => r.vesselId === peerLibp2pRow.vesselId)
    expect(row).toBeDefined()
    expect(row!.egress_unreachable).toBe(true)
    expect(String(row!.egress_unreachable_reason)).toContain("no local federation transport")
  })

  it("[MUST-FAIL] the transport is registered but its egress refuses the connection: stamped", async () => {
    reg(transportSelfRow) // no handler for the egress origin: the stub refuses ("Unable to connect")
    const row = (await capability()).find((r) => r.vesselId === peerLibp2pRow.vesselId)
    expect(row!.egress_unreachable).toBe(true)
    expect(String(row!.egress_unreachable_reason)).toContain("refused")
  })

  it("[CONTROL] the transport is registered and answering: no stamp, the row is offered as before", async () => {
    reg(transportSelfRow)
    handlers[EGRESS] = () => Response.json({ ok: true })
    const row = (await capability()).find((r) => r.vesselId === peerLibp2pRow.vesselId)
    expect(row).toBeDefined()
    expect(row!.egress_unreachable).toBeUndefined()
  })

  it("[CONTROL] the stamp is recomputed per answer: a transport that comes back clears it on the next call", async () => {
    expect((await capability()).find((r) => r.vesselId === peerLibp2pRow.vesselId)!.egress_unreachable).toBe(true)
    reg(transportSelfRow); handlers[EGRESS] = () => Response.json({ ok: true })
    expect((await capability()).find((r) => r.vesselId === peerLibp2pRow.vesselId)!.egress_unreachable).toBeUndefined()
  })

  it("[HELD-OUT] a local plain http row is never stamped, and the libp2p row is kept (never dropped)", async () => {
    reg({ vesselId: "development-vessel-local", vesselName: "development-vessel", endpoint: "http://127.0.0.1:8090", shapes: ["gapDecomposition"] })
    const rows = await capability()
    const local = rows.find((r) => r.vesselId === "development-vessel-local")
    expect(local).toBeDefined()
    expect(local!.egress_unreachable).toBeUndefined()
    expect(rows.some((r) => r.vesselId === peerLibp2pRow.vesselId && r.egress_unreachable === true)).toBe(true)
  })
})

describe("localEgressLiveness", () => {
  const self = { ...transportSelfRow, expiresAt: Date.now() + 60_000 }
  it("[UNIT] an expired registration is not live; a slow (non-refused) probe fails open; a mirror row is not the transport", async () => {
    expect((await localEgressLiveness([{ ...self, expiresAt: Date.now() - 1 }], async () => {})).live).toBe(false)
    expect((await localEgressLiveness([self], async () => { throw new Error("The operation timed out.") })).live).toBe(true)
    expect((await localEgressLiveness([{ ...self, vesselId: "federation-transport-local@other" }], async () => {})).live).toBe(false)
    expect((await localEgressLiveness([self], async () => { throw new TypeError("Unable to connect") })).live).toBe(false)
  })
})
