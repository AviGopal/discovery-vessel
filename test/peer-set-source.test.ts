/**
 * ACTIVITY discovery-vessel:peer-set-source — the variant-selected, traced peer-set selection.
 *
 * CREC (red-on-control, green-on-variant): the SAME assertion — the peer set is sourced from
 * substrateNodes, with self + aliases dropped, and `source` recorded — is GREEN under a v1 mask and RED
 * under v0 / no mask (where the set is the env seed and source=env). The "red-on-control" case runs the
 * variant expectation against the v0 path and asserts it does NOT hold (documents the discrimination).
 *
 * The pool is a recording stub behind an injected globalThis.fetch (no sockets); mask and substrateNodes
 * rows are returned per request-body shape. endpointIsThisHost is injected so a .test host never resolves
 * to this node by interface — self-drop here is carried by the env/identity forms, as in deployment.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { registry } from "../src/index"
import { selectPeerSet, recordPeerSetConsumption, __resetPeerSetSourceStateForTests, __setPeerSetSourceClockForTests, type HostDeps } from "../src/peer-set-source"

const ENV_NAMES = [
  "METABOB_API_KEY",
  "DISCOVERY_SELF_ENDPOINT",
  "DISCOVERY_PUBLIC_URL",
  "SUBSTRATE_NAME",
  "DISCOVERY_VESSEL_ID",
  "ACTIVITY_API_ENDPOINT",
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]

const POOL = "http://pool.test:8300"
const SELF = "http://self.test:8100"
const SEED = ["http://seed-peer.test:18100"]
const PEER_A = "http://peer-a.test:18100"
const PEER_B = "http://peer-b.test:18100"
const API = "http://activity-api.test:8080"
// Register activity-api so its endpoint resolves through discovery's OWN registry (the routing fixed point).
const registerActivityApi = () =>
  registry.register({ vesselId: "activity-api", vesselName: "activity-api", endpoint: API, shapes: ["executionTraces"], systemVessel: true } as Parameters<typeof registry.register>[0])
const ownTraces = () => traces.filter((t) => t["template_id"] === "discovery-vessel:peer-set-source" || t["template_id"] === "discovery-vessel:peer-set-source-v1")
const creditTraces = () => traces.filter((t) => t["template_id"] === "discovery-vessel:peer-set-source-credit")
const tick = () => new Promise((r) => setTimeout(r, 0))
// A past/future window around "now" so the mask is in force.
const FROM = new Date(Date.now() - 3_600_000).toISOString()
const UNTIL = new Date(Date.now() + 3_600_000).toISOString()

const realFetch = globalThis.fetch
// endpointIsThisHost deps that never classify a .test host as this node (resolve throws) — so only the
// env/identity self-forms drop self, exactly as the fixture intends.
const neverThisHost: HostDeps = { resolve: async () => { throw new Error("no dns in test") }, interfaces: () => [] }

type Row = { id: string; shape: string; updated_at: string; body: unknown }
let maskRows: Row[] = []
let nodeRows: Row[] = []
let logs: string[] = []
let traces: Array<Record<string, unknown>> = [] // every trace POSTed to activity-api
const origLog = console.log
const origWarn = console.warn

function row(shape: string, body: unknown, id = shape, updated_at = new Date().toISOString()): Row {
  return { id, shape, updated_at, body }
}

beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  process.env.METABOB_API_KEY = "test-key"
  process.env.DISCOVERY_SELF_ENDPOINT = SELF
  process.env.SUBSTRATE_NAME = "substrate"
  __resetPeerSetSourceStateForTests()
  for (const v of registry.list()) registry.unregister(v.vesselId)
  // One LOCAL-origin poolImpulse producer in this node's registry.
  registry.register({ vesselId: "dev-local", vesselName: "development-vessel", endpoint: POOL, shapes: ["poolImpulse"], systemVessel: true } as Parameters<typeof registry.register>[0])
  maskRows = []
  nodeRows = []
  logs = []
  traces = []
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")) }
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")) }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const bodyStr = String(init?.body ?? "")
    if (url.includes("/v2/activities/execution-traces")) {
      try { traces.push(JSON.parse(bodyStr) as Record<string, unknown>) } catch { /* ignore */ }
      return Response.json({ success: true, stored: true })
    }
    if (bodyStr.includes('"activityVariantMask"')) return Response.json({ body: { impulses: maskRows } })
    if (bodyStr.includes('"substrateNodes"')) return Response.json({ body: { impulses: nodeRows } })
    return Response.json({ ok: true })
  }) as unknown as typeof fetch
})

afterEach(() => {
  console.log = origLog
  console.warn = origWarn
  globalThis.fetch = realFetch
  for (const v of registry.list()) registry.unregister(v.vesselId)
  registry.stop()
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n]
    else process.env[n] = savedEnv[n]!
  }
})

// A v1 mask in force for THIS activity.
const v1Mask = () => [row("activityVariantMask", { activity_id: "discovery-vessel:peer-set-source", active_variant: 1, from: FROM, until: UNTIL, reason: "test v1", by: "operator" })]
// substrateNodes record listing self (under two forms) + two real peers.
const nodesRecord = () => [row("substrateNodes", { discovery_endpoints: [SELF, "http://substrate-live:8100", PEER_A, PEER_B], reason: "nodes" })]

describe("CREC: v1 sources the peer set from substrateNodes (self + aliases dropped); v0 reads env", () => {
  it("GREEN under v1: source=substrateNodes, self + in-container alias dropped, source recorded", async () => {
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    // The variant assertion that is GREEN under v1 and RED under v0:
    expect(sel.source).toBe("substrateNodes")
    expect(sel.variant).toBe(1)
    expect(sel.peers).toEqual([PEER_A, PEER_B]) // SELF and substrate-live:8100 (node identity alias) dropped
    expect(sel.peers).not.toContain(SELF)
    expect(logs.some((l) => l.includes("source=substrateNodes") && l.includes(PEER_A))).toBe(true)
  })

  it("control (v0 / no mask): source=env, set is the seed — the GREEN variant assertion would FAIL here", async () => {
    maskRows = [] // no mask in force → variant 0
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    // The GREEN case's `source === "substrateNodes"` is RED on this path (it resolves to "env"); see the
    // report for the behavioural-red transcript. Here we pin the control's own contract:
    expect(sel.source).not.toBe("substrateNodes")
    expect(sel.source).toBe("env")
    expect(sel.variant).toBe(0)
    expect(sel.peers).toEqual(SEED)
    expect(logs.some((l) => l.includes("source=env"))).toBe(true)
  })
})

describe("variant selection (activityVariantMask, numeric active_variant)", () => {
  it("an unknown active_variant (string \"v1\") → variant 0 + 'names unknown variant' log", async () => {
    maskRows = [row("activityVariantMask", { activity_id: "discovery-vessel:peer-set-source", active_variant: "v1", from: FROM, until: UNTIL, reason: "bad" })]
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(0)
    expect(sel.source).toBe("env")
    expect(logs.some((l) => l.includes("names unknown variant"))).toBe(true)
  })

  it("an out-of-window mask (until in the past) is not in force → variant 0", async () => {
    const past = new Date(Date.now() - 1_000).toISOString()
    maskRows = [row("activityVariantMask", { activity_id: "discovery-vessel:peer-set-source", active_variant: 1, from: FROM, until: past, reason: "expired" })]
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(0)
    expect(sel.source).toBe("env")
  })

  it("a mask for a DIFFERENT activity_id is ignored → variant 0", async () => {
    maskRows = [row("activityVariantMask", { activity_id: "some-other:activity", active_variant: 1, from: FROM, until: UNTIL })]
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(0)
    expect(sel.source).toBe("env")
  })
})

describe("fail-open and unreadable", () => {
  it("mask pool unreadable (producer 500s) → variant 0 + mask_unread log", async () => {
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      const bodyStr = String(init?.body ?? "")
      if (bodyStr.includes('"activityVariantMask"')) return new Response("err", { status: 500 })
      return Response.json({ body: { impulses: [] } })
    }) as unknown as typeof fetch
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(0)
    expect(sel.source).toBe("env")
    expect(logs.some((l) => l.includes("mask_unread") && l.includes("variant-0"))).toBe(true)
  })

  it("v1 but substrateNodes pool unreadable → FAIL OPEN to the env seed, source=seed_fallback", async () => {
    maskRows = v1Mask()
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      const bodyStr = String(init?.body ?? "")
      if (bodyStr.includes('"activityVariantMask"')) return Response.json({ body: { impulses: maskRows } })
      if (bodyStr.includes('"substrateNodes"')) return new Response("err", { status: 503 })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(1)
    expect(sel.source).toBe("seed_fallback")
    expect(sel.peers).toEqual(SEED)
    expect(logs.some((l) => l.includes("source=seed_fallback"))).toBe(true)
  })

  it("v1, substrateNodes readable but NO record (ABSENT) → FAIL OPEN to seed, source=seed_fallback, why names absent", async () => {
    maskRows = v1Mask()
    nodeRows = [] // readable, no substrateNodes record → absent (unknown, not "no peers")
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(1)
    expect(sel.source).toBe("seed_fallback")
    expect(sel.peers).toEqual(SEED)
    expect(sel.why).toBe("substrateNodes record absent")
    expect(logs.some((l) => l.includes("source=seed_fallback") && l.includes("substrateNodes record absent"))).toBe(true)
  })

  it("v1, record PRESENT but every entry is self/alias → source=substrateNodes, empty set (NOT fail-open)", async () => {
    maskRows = v1Mask()
    // Only self forms listed: host:port self + the <name>-live node-identity alias.
    nodeRows = [row("substrateNodes", { discovery_endpoints: [SELF, "http://substrate-live:8100"], reason: "self only" })]
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(1)
    expect(sel.source).toBe("substrateNodes") // a record WAS read — not fail-open
    expect(sel.peers).toEqual([])
  })

  it("no local poolImpulse producer → mask unreadable → variant 0 (env)", async () => {
    for (const v of registry.list()) registry.unregister(v.vesselId)
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(sel.variant).toBe(0)
    expect(sel.source).toBe("env")
    expect(logs.some((l) => l.includes("mask_unread"))).toBe(true)
  })
})

describe("execution traces (own trace on selection change; credit by consumption)", () => {
  it("OWN trace on a v1 selection: per-variant id -v1, output peerSetSelection, deterministic task, metadata, variant_role:treatment", async () => {
    registerActivityApi()
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    await tick()
    expect(ownTraces().length).toBe(1)
    const t = ownTraces()[0]!
    expect(t["template_id"]).toBe("discovery-vessel:peer-set-source-v1")
    expect(t["activity_id"]).toBe("discovery-vessel:peer-set-source-v1")
    expect(t["activity_variant_id"]).toBe("discovery-vessel:peer-set-source-v1")
    expect(t["execution_id"]).toBe(sel.traceId)
    expect(t["output_shapes"]).toEqual(["peerSetSelection"])
    expect(t["status"]).toBe("completed")
    const tasks = t["tasks"] as Array<Record<string, unknown>>
    expect(tasks.length).toBe(1)
    expect(tasks[0]!["resolver_id"]).toBe("deterministic")
    const md = t["metadata"] as Record<string, unknown>
    expect(md["variant"]).toBe(1)
    expect(md["source"]).toBe("substrateNodes")
    expect(md["peers"]).toEqual([PEER_A, PEER_B])
    expect(md["dropped_self"]).toBe(2) // SELF + substrate-live:8100 alias
    expect(t["tags"]).toContain("variant_role:treatment")
  })

  it("OWN trace on a v0 selection: base id, variant_role:control, source=env", async () => {
    registerActivityApi()
    maskRows = [] // v0
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    await tick()
    expect(ownTraces().length).toBe(1)
    const t = ownTraces()[0]!
    expect(t["template_id"]).toBe("discovery-vessel:peer-set-source")
    expect(t["execution_id"]).toBe(sel.traceId)
    expect((t["metadata"] as Record<string, unknown>)["source"]).toBe("env")
    expect(t["tags"]).toContain("variant_role:control")
  })

  it("UNCHANGED selection posts no second own trace (law 5: only on change)", async () => {
    registerActivityApi()
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    await selectPeerSet(SEED, Date.now(), neverThisHost)
    await tick()
    expect(ownTraces().length).toBe(1)
    await selectPeerSet(SEED, Date.now(), neverThisHost) // same (variant, peer set)
    await tick()
    expect(ownTraces().length).toBe(1) // no new trace
  })

  it("CREDIT trace on first consumption: reached=true, composition_chain + consumed_provenance → the own trace", async () => {
    registerActivityApi()
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    await recordPeerSetConsumption(sel, true)
    expect(creditTraces().length).toBe(1)
    const c = creditTraces()[0]!
    expect(c["template_id"]).toBe("discovery-vessel:peer-set-source-credit")
    expect(c["reached"]).toBe(true)
    expect(c["failure_mode"]).toBeNull()
    expect(c["composition_chain"]).toEqual([sel.traceId])
    const prov = (c["tasks"] as Array<Record<string, unknown>>)[0]!["consumed_provenance"] as Array<Record<string, unknown>>
    expect(prov[0]!["producer_execution_id"]).toBe(sel.traceId)
    expect(c["tags"]).toContain("reach_decided_by:consumer")
  })

  it("CREDIT trace reached=false → failure_mode verifier_negative", async () => {
    registerActivityApi()
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    await recordPeerSetConsumption(sel, false)
    const c = creditTraces()[0]!
    expect(c["reached"]).toBe(false)
    expect((c["failure_mode"] as Record<string, unknown>)["type"]).toBe("verifier_negative")
  })

  it("CREDIT is idempotent per selection (first fan-out only)", async () => {
    registerActivityApi()
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    await recordPeerSetConsumption(sel, true)
    await recordPeerSetConsumption(sel, true)
    expect(creditTraces().length).toBe(1)
  })

  it("FAIL-OPEN: no activity-api producer and no env → no trace posted, logged skipped, selection still returned", async () => {
    // activity-api NOT registered; ACTIVITY_API_ENDPOINT unset.
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const sel = await selectPeerSet(SEED, Date.now(), neverThisHost)
    await tick()
    expect(sel.source).toBe("substrateNodes") // fan-out decision unaffected
    expect(ownTraces().length).toBe(0)
    expect(logs.some((l) => l.includes("trace POST skipped"))).toBe(true)
  })

  it("endpoint resolves via ACTIVITY_API_ENDPOINT when no registry producer (bootstrap fallback)", async () => {
    process.env.ACTIVITY_API_ENDPOINT = API // no executionTraces producer registered
    maskRows = [] // v0
    await selectPeerSet(SEED, Date.now(), neverThisHost)
    await tick()
    expect(ownTraces().length).toBe(1)
  })
})

describe("READ CACHE: ≤30 s TTL + single-flight per shape; one pool_read line per actual read", () => {
  // A SLOW (hanging-until-released) pool: counts reads per shape and holds every answer until release().
  function slowPool(): { reads: Record<string, number>; release: () => void } {
    const reads: Record<string, number> = { activityVariantMask: 0, substrateNodes: 0 }
    let gate!: () => void
    let held = new Promise<void>((r) => { gate = r })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const bodyStr = String(init?.body ?? "")
      if (url.includes("/v2/activities/execution-traces")) return Response.json({ success: true })
      const shape = bodyStr.includes('"activityVariantMask"') ? "activityVariantMask" : bodyStr.includes('"substrateNodes"') ? "substrateNodes" : ""
      if (shape) reads[shape]!++
      await held
      if (shape === "activityVariantMask") return Response.json({ body: { impulses: maskRows } })
      if (shape === "substrateNodes") return Response.json({ body: { impulses: nodeRows } })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch
    return { reads, release: () => gate() }
  }
  const poolReadLines = (shape: string) => logs.filter((l) => l.includes(`pool_read shape=${shape} `))

  it("N concurrent + sequential forwards within one TTL → ONE read and ONE pool_read line per shape; past the TTL → one more", async () => {
    let t = 1_000_000
    __setPeerSetSourceClockForTests(() => t)
    maskRows = v1Mask()
    nodeRows = nodesRecord()
    const pool = slowPool()
    const N = 8
    const concurrent = Array.from({ length: N }, () => selectPeerSet(SEED, Date.now(), neverThisHost))
    await tick()
    expect(pool.reads.activityVariantMask).toBe(1) // all N wait on the ONE in-flight mask read
    pool.release()
    const sels = await Promise.all(concurrent)
    for (const s of sels) expect(s.source).toBe("substrateNodes")
    for (let i = 0; i < N; i++) await selectPeerSet(SEED, Date.now(), neverThisHost) // sequential, same TTL
    expect(pool.reads).toEqual({ activityVariantMask: 1, substrateNodes: 1 })
    expect(poolReadLines("activityVariantMask")).toEqual(["[discovery-vessel:peer-set-source] pool_read shape=activityVariantMask ok=true"])
    expect(poolReadLines("substrateNodes")).toEqual(["[discovery-vessel:peer-set-source] pool_read shape=substrateNodes ok=true"])
    // Every forward still journals its selection line (the per-call count source).
    expect(logs.filter((l) => l.includes("source=substrateNodes") && l.includes("set=")).length).toBe(2 * N)

    t += 30_001 // TTL expired
    await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(pool.reads).toEqual({ activityVariantMask: 2, substrateNodes: 2 })
    expect(poolReadLines("activityVariantMask").length).toBe(2)
    expect(poolReadLines("substrateNodes").length).toBe(2)
  })

  it("a SILENT pool (unreadable) is cached too: one read, one pool_read ok=false, ONE mask_unread line; still variant 0", async () => {
    let t = 5_000_000
    __setPeerSetSourceClockForTests(() => t)
    let maskReads = 0
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      if (String(init?.body ?? "").includes('"activityVariantMask"')) maskReads++
      return new Response("err", { status: 500 })
    }) as unknown as typeof fetch
    const sels = await Promise.all(Array.from({ length: 5 }, () => selectPeerSet(SEED, Date.now(), neverThisHost)))
    for (let i = 0; i < 5; i++) sels.push(await selectPeerSet(SEED, Date.now(), neverThisHost))
    for (const s of sels) { expect(s.variant).toBe(0); expect(s.source).toBe("env"); expect(s.peers).toEqual(SEED) }
    expect(maskReads).toBe(1)
    expect(poolReadLines("activityVariantMask")).toEqual(["[discovery-vessel:peer-set-source] pool_read shape=activityVariantMask ok=false"])
    expect(logs.filter((l) => l.includes("mask_unread")).length).toBe(1)

    t += 30_001
    await selectPeerSet(SEED, Date.now(), neverThisHost)
    expect(maskReads).toBe(2)
    expect(poolReadLines("activityVariantMask").length).toBe(2)
  })
})
