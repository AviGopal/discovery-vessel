// THE SHAPES A PRODUCER CALLS TO REASON ABOUT THE FLEET: discovery's own row is written as a vessel's and kept fresh,
// it declares vesselList, shapeProducers and shapeDescriptions (so a declared shapeDescriptions read offers them), and
// the answers of vesselList and shapeProducers hold no placement, whoever asks; vesselRegistry and vesselCapability keep
// theirs for the vessels that dial.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "declared-shapes-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { resolve } = await import("../src/resolvers")
const { HEARTBEAT_INTERVAL_MS } = await import("../src/registry")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const SELF = "discovery-test"
const TTL_MS = 5 * 60 * 1000
const realFetch = globalThis.fetch
let app: Hono
let stopSelf: (() => void) | undefined
const ORG_A = "organizations:tenant-a"
const ORG_B = "organizations:tenant-b"
const KEYS: Record<string, string> = { "sys-caller": SYS, "org-a-caller": ORG_A, "org-b-caller": ORG_B }
const register = (body: Record<string, unknown>, key = "sys-caller") =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify(body) })
const ask = async (pointer: Record<string, unknown>, orgIds?: string[]): Promise<any> => resolve(pointer as never, orgIds ? { orgIds } : undefined)
// discovery's own row, as index.ts keeps it (a dynamic import: the parent has no such module, and each leg says so)
const self = async () => {
  const { keepSelfRegistered } = await import("../src/self")
  const kept = keepSelfRegistered(SELF, "http://discovery.test")
  stopSelf = kept.stop
  return kept
}
// a vessel registered with every placement field a row can carry
const PLACED = {
  vesselId: "placed-vessel", endpoint: "http://placed.test:9000", shapes: ["fileContent", "codeSearchResult"],
  protocol: "http", resolve_endpoint: "http://placed.test:9000/v2/impulses/resolve", libp2p_peer_id: "peer-placed",
  libp2p_multiaddr: ["/ip4/10.1.2.3/tcp/4001"], metadata: { zone: "a" }, distribution_policy: "stateless",
  shape_policies: { fileContent: { policy: "held", holder: "placed-vessel" } }, public_endpoint: "http://placed.test:19000",
}

beforeEach(() => {
  setIdentityValidator(async (key: string) => (KEYS[key] ? { orgId: KEYS[key], userId: "u", keyId: `k-${key}`, scopes: [] } : null))
  globalThis.fetch = (async (u: unknown) => { throw new TypeError(`unexpected network call in test: ${String(u)}`) }) as typeof fetch
  app = createServer()
})
afterEach(() => {
  stopSelf?.(); stopSelf = undefined
  for (const v of registry.list()) registry.unregister(v.vesselId)
  setIdentityValidator(null); globalThis.fetch = realFetch; registry.stop()
})
afterAll(() => {
  if (savedPath === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
  else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = savedPath
  rmSync(TMP, { recursive: true, force: true })
})

describe("discovery's own row: the shapes a producer may call", () => {
  it("[MUST-FAIL] a declared shapeDescriptions read offers vesselList, shapeProducers and shapeDescriptions, with their inputs; not vesselRegistry", async () => {
    await self()
    const d = await ask({ type: "shapeDescriptions", declared: true })
    expect(Object.keys(d.shape_descriptions).filter((k) => ["vesselList", "shapeProducers", "shapeDescriptions", "vesselRegistry", "vesselCapability", "vesselEndpoint", "vesselHealth"].includes(k)).sort())
      .toEqual(["shapeDescriptions", "shapeProducers", "vesselList"])
    expect(d.shape_inputs.vesselList).toEqual({ type: "object", additionalProperties: false, properties: {} })
    expect(d.shape_inputs.shapeProducers.required).toEqual(["shape"])
    expect(d.shape_descriptions.vesselList).toContain("totalCount")
  })
  it("[MUST-FAIL] discovery's row is still listed after the TTL and a prune: it is refreshed at the heartbeat interval", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const kept = await self()
      for (let t = HEARTBEAT_INTERVAL_MS; t <= TTL_MS + HEARTBEAT_INTERVAL_MS; t += HEARTBEAT_INTERVAL_MS) { now += HEARTBEAT_INTERVAL_MS; kept.refresh() }
      now += 1000
      registry.pruneExpired()
      expect(registry.get(SELF)?.vesselId).toBe(SELF)
    } finally { clock.mockRestore() }
  })
  it("[MUST-FAIL] a refresh that finds the row pruned writes it again", async () => {
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    try {
      const kept = await self()
      now += TTL_MS + 60_000
      registry.pruneExpired()
      expect(registry.get(SELF)).toBeUndefined()
      kept.refresh()
      expect(registry.get(SELF)?.shapes).toContain("vesselList")
    } finally { clock.mockRestore() }
  })
  it("the refresh runs at the heartbeat interval every vessel is given (a guard)", async () => {
    const timers = spyOn(globalThis, "setInterval")
    try {
      await self()
      expect(timers.mock.calls.some((c) => c[1] === HEARTBEAT_INTERVAL_MS)).toBe(true)
    } finally { timers.mockRestore() }
  })
})

describe("each tenant is shown only the vessels it may reach", () => {
  it("[MUST-FAIL] a tenant's declared read still offers the three, with exactly these inputs (what the drafter fills)", async () => {
    await self()
    const d = await ask({ type: "shapeDescriptions", declared: true }, [ORG_A])
    // written out here, not read from the module: a declaration keyword changed there must show as a difference
    expect({ vesselList: d.shape_inputs.vesselList, shapeProducers: d.shape_inputs.shapeProducers, shapeDescriptions: d.shape_inputs.shapeDescriptions }).toEqual({
      vesselList: { type: "object", additionalProperties: false, properties: {} },
      shapeProducers: { type: "object", required: ["shape"], additionalProperties: false, properties: { shape: { type: "string", minLength: 1, description: "The shape to find producers for." } } },
      shapeDescriptions: { type: "object", additionalProperties: false, properties: {
        shapes: { type: "array", items: { type: "string" }, description: "Only these shapes." },
        declared: { type: "boolean", description: "Only shapes whose inputs are declared." },
      } },
    })
  })
  it("[MUST-FAIL] vesselList and shapeProducers show a tenant its own vessels and the system's, never another tenant's", async () => {
    await self()
    expect((await register({ ...PLACED, vesselId: "a-vessel", endpoint: "http://a.test:9001", libp2p_peer_id: "peer-a" }, "org-a-caller")).status).toBe(201)
    expect((await register({ ...PLACED, vesselId: "b-vessel", endpoint: "http://b.test:9002", libp2p_peer_id: "peer-b" }, "org-b-caller")).status).toBe(201)
    const a = await ask({ type: "vesselList" }, [ORG_A])
    const p = await ask({ type: "shapeProducers", shape: "fileContent" }, [ORG_A])
    expect([a.vessels.map((v: any) => v.vesselId).sort(), a.totalCount, p.vesselIds]).toEqual([["a-vessel", "discovery-test"], 2, ["a-vessel"]])
  })
  it("[MUST-FAIL] a caller of two orgs is shown each vessel once: the system's are not counted per org", async () => {
    await self()
    await register({ ...PLACED, vesselId: "a-vessel", endpoint: "http://a.test:9001", libp2p_peer_id: "peer-a" }, "org-a-caller")
    const both = await ask({ type: "vesselList" }, [ORG_A, ORG_B])
    expect([both.vessels.map((v: any) => v.vesselId).sort(), both.totalCount]).toEqual([["a-vessel", "discovery-test"], 2])
  })
  it("with spokes' mirrored rows registered, as on a hub, totalCount is still vesselRegistry's count (a guard)", async () => {
    await self()
    for (const spoke of ["spoke-1", "spoke-2", "spoke-3"]) {
      expect((await register({ vesselId: `records-vessel@${spoke}`, endpoint: `http://relay.test/${spoke}`, shapes: ["record_read"], protocol: "libp2p", libp2p_peer_id: `peer-${spoke}` })).status).toBe(201)
    }
    const [list, reg] = [await ask({ type: "vesselList" }), await ask({ type: "vesselRegistry" })]
    expect([list.totalCount, reg.vessels.length]).toEqual([4, 4])
  })
  it("totalCount is the count vesselRegistry lists under the same scope; with no org named, every vessel, as before (a guard)", async () => {
    await self()
    await register({ ...PLACED, vesselId: "a-vessel", endpoint: "http://a.test:9001", libp2p_peer_id: "peer-a" }, "org-a-caller")
    await register({ ...PLACED, vesselId: "b-vessel", endpoint: "http://b.test:9002", libp2p_peer_id: "peer-b" }, "org-b-caller")
    const scoped = [(await ask({ type: "vesselList" }, [ORG_A])).totalCount, (await ask({ type: "vesselRegistry", filters: { orgId: ORG_A } })).vessels.length]
    const all = [(await ask({ type: "vesselList" })).totalCount, (await ask({ type: "vesselRegistry" })).vessels.length]
    expect([scoped, all]).toEqual([[2, 2], [3, 3]])
  })
})

describe("vesselList and shapeProducers hold no placement, whoever asks", () => {
  it("[MUST-FAIL] vesselList is each vessel's id, shapes and status, and totalCount, the count vesselRegistry lists", async () => {
    await self()
    expect((await register(PLACED)).status).toBe(201)
    const list = await ask({ type: "vesselList" })
    expect(list.vessels.map((v: object) => Object.keys(v).sort())).toEqual(list.vessels.map(() => ["shapes", "status", "vesselId"]))
    expect(list.vessels.find((v: any) => v.vesselId === "placed-vessel")).toEqual({ vesselId: "placed-vessel", shapes: ["fileContent", "codeSearchResult"], status: "healthy" })
    expect(list.vessels.map((v: any) => v.vesselId).sort()).toEqual(["discovery-test", "placed-vessel"])
    const reg = await ask({ type: "vesselRegistry" })
    expect(list.totalCount).toBe(reg.vessels.length)
    expect(JSON.stringify(list)).not.toMatch(/placed\.test|10\.1\.2\.3|peer-placed|zone|held/)
  })
  it("[MUST-FAIL] shapeProducers is the shape and the ids serving it, healthy ones first", async () => {
    await self()
    await register({ ...PLACED, vesselId: "slow-vessel" })
    await register(PLACED)
    const slow = registry.get("slow-vessel")!
    slow.status = "degraded"
    const p = await ask({ type: "shapeProducers", shape: "fileContent" })
    expect(p).toEqual({ shape: "fileContent", vesselIds: ["placed-vessel", "slow-vessel"] })
  })
  it("vesselRegistry and vesselCapability still answer placements, for the vessels that dial (a guard)", async () => {
    await register(PLACED)
    const reg = (await ask({ type: "vesselRegistry" })).vessels.find((v: any) => v.vesselId === "placed-vessel")
    const cap = (await ask({ type: "vesselCapability", shape: "fileContent" })).vessels.find((v: any) => v.vesselId === "placed-vessel")
    expect([reg.endpoint, reg.libp2p_peer_id, cap.endpoint, cap.libp2p_peer_id]).toEqual(["http://placed.test:9000", "peer-placed", "http://placed.test:9000", "peer-placed"])
  })
  it("/resolve answers vesselList itself, as one of discovery's own shapes (a guard)", async () => {
    await self()
    const r = await app.request("/resolve", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify({ pointer: { type: "vesselList" } }) })
    const body = (await r.json()) as any
    expect([r.status, (body.content ?? body).totalCount]).toEqual([200, 1])
  })
})

describe("the entry point keeps discovery's own row", () => {
  it("[MUST-FAIL] index.ts, started as the unit starts it, registers discovery with the shapes it declares", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const proc = Bun.spawn([process.execPath, "index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DISCOVERY_PORT: String(port), DISCOVERY_VESSEL_ID: "discovery-boot-test",
        DISCOVERY_LEARNED_DESCRIPTIONS_PATH: join(TMP, "boot-learned.json") },
      stdout: "pipe", stderr: "pipe",
    })
    try {
      let row: any
      for (let i = 0; i < 100 && row === undefined; i++) {
        const r = await realFetch(`http://127.0.0.1:${port}/vessels/discovery-boot-test`).catch(() => undefined)
        if (r?.ok) row = await r.json()
        else await Bun.sleep(100)
      }
      expect(row?.shapes).toEqual(expect.arrayContaining(["vesselList", "shapeProducers", "shapeDescriptions"]))
    } finally { proc.kill() }
  }, 20_000)

})
