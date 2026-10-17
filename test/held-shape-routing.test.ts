// HELD SHAPES ROUTE TO THEIR HOLDER (src/held-shape-routing.ts; user ruling 2026-10-17T04:47:53Z). Driven through the
// real /register and /resolve; the forward target is a fetch stub that records which row was dialled.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "held-routing-"))
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { setIdentityValidator } = await import("../src/middleware/auth")
const { pickHeldShapeProducer } = await import("../src/held-shape-routing")
import type { Hono } from "hono"

let app: Hono
const dialled: string[] = []
const realFetch = globalThis.fetch
const H = { "Content-Type": "application/json", Authorization: "ApiKey k" }
const PIN = { distribution_policy: "stateful_data_owner_pin" }
const reg = (body: Record<string, unknown>) => app.request("/register", { method: "POST", headers: H, body: JSON.stringify({ vesselName: String(body.vesselId), version: "1", systemVessel: true, ...body }) })
const resolve = (type: string) => app.request("/resolve", { method: "POST", headers: H, body: JSON.stringify({ pointer: { type } }) })
const LOCAL = { vesselId: "dv-local", endpoint: "http://dv-local.test", shapes: ["gapShape", "statelessShape"], shape_policies: { gapShape: { ...PIN, holder: "store:node-a" } } }
const PEER = { vesselId: "dv-local@spoke-x", endpoint: "http://egress.test", protocol: "libp2p", libp2p_multiaddr: ["/ip4/10.0.0.9/tcp/1/p2p/QmPEER"], shapes: ["gapShape", "statelessShape"], shape_policies: { gapShape: { ...PIN, holder: "store:spoke-x" } } }

beforeEach(() => {
  setIdentityValidator(async () => ({ orgId: "o", userId: "u", keyId: "k", scopes: [] }))
  // Record EVERY dial except the registry's own event-publish side traffic (path /v2/events/publish): a gate env points
  // the event bus at a placeholder, and those publishes are not routing decisions. Any other host, including an env-named
  // local endpoint, still lands in `dialled`, so the exact assertions catch an unexpected dial.
  globalThis.fetch = (async (u: unknown) => { const s = String(u); if (!/\/v2\/events\/publish(\?|$)/.test(s)) dialled.push(s); return Response.json({ shape: "ok", body: { from: s } }) }) as typeof fetch
  dialled.length = 0
  app = createServer()
  for (const v of registry.list()) registry.unregister(v.vesselId)
})
afterEach(() => { setIdentityValidator(null); globalThis.fetch = realFetch; registry.stop() })
import { afterAll } from "bun:test"
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe("held shapes route to their holder", () => {
  it("[GUARD] RESTART ORDER (the label-only variant's regression): a pinned PEER row registered FIRST does not win over the local holder", async () => {
    expect((await reg(PEER)).status).toBe(201)
    expect((await reg(LOCAL)).status).toBe(201)
    const r = await resolve("gapShape")
    expect(r.status).toBe(200)
    expect(dialled).toEqual(["http://dv-local.test/v2/impulses/resolve"])
  })
  it("[GUARD] local holder present: a held shape's read and write go to the local row", async () => {
    await reg(LOCAL); await reg(PEER)
    await resolve("gapShape")
    expect(dialled[0]).toBe("http://dv-local.test/v2/impulses/resolve")
  })
  it("[MUST-FAIL] no local producer: a peer that advertises a held shape but does not HOLD it (a forwarder) is REFUSED (never dialled)", async () => {
    await reg({ ...PEER, shape_policies: { gapShape: { ...PIN, holder: "gap-store@designated-holder" } } })
    const r = await resolve("gapShape")
    expect(r.status).toBe(409)
    expect((await r.json() as { error?: string }).error).toBe("held_shape_no_local_holder")
    expect(dialled).toEqual([])
  })
  it("[MUST-FAIL] a node with NO local producer (no dev-vessel profile) reaches the peer row that HOLDS the data, not a forwarder", async () => {
    await reg({ ...PEER, vesselId: "dv-fwd@spoke-y", endpoint: "http://egress-fwd.test", shape_policies: { gapShape: { ...PIN, holder: "gap-store@designated-holder" } } })
    await reg({ ...PEER, vesselId: "development-vessel-local@hub", endpoint: "http://egress-hub.test", shape_policies: { gapShape: { ...PIN, holder: "gap-store@development-vessel-local" } } })
    const r = await resolve("gapShape")
    expect(r.status).toBe(200)
    expect(dialled).toEqual(["http://egress-hub.test/v2/impulses/resolve"])
  })
  it("[CONTROL] two peer rows that each HOLD their own data (separate authorities): refused, not guessed", async () => {
    await reg({ ...PEER, vesselId: "dvA@a", endpoint: "http://a.test", shape_policies: { gapShape: { ...PIN, holder: "gap-store@dvA" } } })
    await reg({ ...PEER, vesselId: "dvB@b", endpoint: "http://b.test", shape_policies: { gapShape: { ...PIN, holder: "gap-store@dvB" } } })
    expect((await resolve("gapShape")).status).toBe(409)
    expect(dialled).toEqual([])
  })
  it("[CONTROL] a genuinely stateless shape may still route to a peer when it is the only producer", async () => {
    await reg(PEER)
    const r = await resolve("statelessShape")
    expect(r.status).toBe(200)
    expect(dialled).toEqual(["http://egress.test/v2/impulses/resolve"])
  })
  it("[HELD-OUT] a spoke reaches its designated holder through its OWN producer (the local row, which forwards): local is chosen", async () => {
    await reg({ ...LOCAL, vesselId: "dv-spoke-local", endpoint: "http://spoke-dv.test", shape_policies: { gapShape: { ...PIN, holder: "store:hub (forwarded)" } } })
    await reg({ ...PEER, vesselId: "dv-local@hub" })
    await resolve("gapShape")
    expect(dialled).toEqual(["http://spoke-dv.test/v2/impulses/resolve"])
  })
  it("[UNIT] the detector: a row serving a held shape as stateless (no per-shape policy) is flagged; a pin-free shape is not_held", () => {
    const p = pickHeldShapeProducer("gapShape", [{ vesselId: "a", ...LOCAL }, { vesselId: "liar", protocol: "libp2p" }] as never)
    expect(p.kind).toBe("held")
    expect((p as { mismatched: string[] }).mismatched).toEqual(["liar"])
    expect(pickHeldShapeProducer("statelessShape", [LOCAL, PEER] as never).kind).toBe("not_held")
  })
  it("[UNIT] malformed shape_policies are dropped at registration (unknown policy, empty shape)", async () => {
    await reg({ ...LOCAL, vesselId: "bad", endpoint: "http://bad.test", shape_policies: { gapShape: { distribution_policy: "whatever" }, "": PIN } })
    expect(registry.get("bad")?.shape_policies).toBeUndefined()
  })
})
