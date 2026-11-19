// WHO MAY REPLACE OR REFRESH A REGISTERED ROW. /resolve forwards each caller's key to the row's endpoint, so an existing
// vesselId is re-registered or heartbeated only by a key of the row's own org, or by the system identity (this vessel's
// own key's validated org). A caller with no org, and every caller while the system org is unvalidated, is never the
// system identity. A refusal keeps the row as it was, answers 403 with no key, and logs the org classes only. No call
// here may reach the network: the fetch stub throws on any request.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// The learned store's path is read when the registry is constructed (at import): point it at a temp file FIRST.
const TMP = mkdtempSync(join(tmpdir(), "register-owner-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetSystemOrgForTests } from "../src/learned-description-writers"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const ORG_A = "organizations:tenant-a"
const ORG_B = "organizations:tenant-b"
const OWN = "own-system-key"
const KEYS: Record<string, string> = { [OWN]: SYS, "sys-caller": SYS, "tenant-a": ORG_A, "tenant-a-2": ORG_A, "tenant-b": ORG_B, "no-org": "" }
const realFetch = globalThis.fetch
const realWarn = console.warn
const saved = { k: process.env.METABOB_API_KEY, p: savedPath }
let app: Hono
let warned: string[] = []

const register = (key: string, vesselId: string, endpoint: string, extra: Record<string, unknown> = {}) =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify({ vesselId, endpoint, shapes: ["owner_probe"], ...extra }) })
const heartbeat = (key: string, vesselId: string) =>
  app.request("/heartbeat", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify({ vesselId }) })
const endpointOf = (id: string) => registry.get(id)?.endpoint

beforeEach(() => {
  process.env.METABOB_API_KEY = OWN
  __resetSystemOrgForTests()
  setIdentityValidator(async (key: string) => (key in KEYS ? { orgId: KEYS[key], userId: "u", keyId: `kid-${key}`, scopes: [] } : null))
  globalThis.fetch = (async (u: unknown) => { throw new TypeError(`unexpected network call in test: ${String(u)}`) }) as typeof fetch
  warned = []
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")) }
  app = createServer()
})
afterEach(() => {
  setIdentityValidator(null); globalThis.fetch = realFetch; console.warn = realWarn; registry.stop(); __resetSystemOrgForTests()
  if (saved.k === undefined) delete process.env.METABOB_API_KEY; else process.env.METABOB_API_KEY = saved.k
})
afterAll(() => { if (saved.p === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH; else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = saved.p; rmSync(TMP, { recursive: true, force: true }) })

describe("who may re-register an existing vesselId", () => {
  it("[MUST-FAIL] another org's key cannot take over a system vessel's id: 403, the row keeps its endpoint, no key in the answer", async () => {
    expect((await register("sys-caller", "ro-system", "http://system.test:8000", { systemVessel: true })).status).toBe(201)
    const r = await register("tenant-b", "ro-system", "http://taker.test:8000", { systemVessel: true })
    expect(r.status).toBe(403)
    expect(endpointOf("ro-system")).toBe("http://system.test:8000")
    const text = await r.text()
    expect(text).not.toContain("tenant-b")
    expect(text).not.toContain("kid-")
  })

  it("[MUST-FAIL] another tenant's key cannot take over a tenant's row", async () => {
    expect((await register("tenant-a", "ro-tenant", "http://a.test:8000")).status).toBe(201)
    expect((await register("tenant-b", "ro-tenant", "http://b.test:8000")).status).toBe(403)
    expect(endpointOf("ro-tenant")).toBe("http://a.test:8000")
  })

  it("the same org re-registers its row, with another key of that org too", async () => {
    expect((await register("tenant-a", "ro-same", "http://a.test:8000")).status).toBe(201)
    expect((await register("tenant-a-2", "ro-same", "http://a2.test:8000")).status).toBe(201)
    expect(endpointOf("ro-same")).toBe("http://a2.test:8000")
  })

  it("the system identity re-registers a tenant's row (a hub mirror row) and a system vessel's", async () => {
    expect((await register("tenant-a", "web@spoke-a", "http://a.test:8000")).status).toBe(201)
    expect((await register("sys-caller", "web@spoke-a", "http://hub-side.test:8000")).status).toBe(201)
    expect(endpointOf("web@spoke-a")).toBe("http://hub-side.test:8000")
    expect((await register("sys-caller", "ro-sys2", "http://s.test:8000", { systemVessel: true })).status).toBe(201)
    expect((await register("sys-caller", "ro-sys2", "http://s2.test:8000", { systemVessel: true })).status).toBe(201)
  })

  it("a new vesselId is registered by any validated key", async () => {
    expect((await register("tenant-b", "ro-new-b", "http://b.test:8000")).status).toBe(201)
    expect(registry.get("ro-new-b")?.orgId).toBe(ORG_B)
  })

  it("[MUST-FAIL] a caller with no org cannot rewrite a row, even one it registered", async () => {
    expect((await register("no-org", "ro-noorg", "http://n.test:8000")).status).toBe(201)
    expect((await register("no-org", "ro-noorg", "http://n2.test:8000")).status).toBe(403)
    expect(endpointOf("ro-noorg")).toBe("http://n.test:8000")
  })

  it("[MUST-FAIL] with the system org unvalidated, nobody is the system identity; a row's own org still re-registers", async () => {
    expect((await register("tenant-a", "ro-unval", "http://a.test:8000")).status).toBe(201)
    process.env.METABOB_API_KEY = "not-a-key"
    __resetSystemOrgForTests()
    expect((await register("sys-caller", "ro-unval", "http://s.test:8000")).status).toBe(403)
    expect(endpointOf("ro-unval")).toBe("http://a.test:8000")
    expect((await register("tenant-a", "ro-unval", "http://a3.test:8000")).status).toBe(201)
  })

  it("a refusal is logged with the vesselId and the org classes only, and recorded as refused_not_owner", async () => {
    await register("sys-caller", "ro-log", "http://system.test:8000", { systemVessel: true })
    await register("tenant-b", "ro-log", "http://taker.test:8000")
    const line = warned.find((w) => w.includes("/register refused for ro-log"))
    expect(line).toBeDefined()
    expect(line).toContain("a tenant caller may not rewrite a system vessel")
    for (const secret of [ORG_B, SYS, "tenant-b", "kid-"]) expect(line).not.toContain(secret)
    expect(registry.recentEvents(500).some((e) => e.vesselId === "ro-log" && e.kind === "refused_not_owner")).toBe(true)
  })
})

describe("who may evict a row through peer dedup", () => {
  it("[MUST-FAIL] another org's new id carrying a row's peer id and base name leaves that row in place", async () => {
    expect((await register("tenant-a", "px", "http://a.test:8000", { libp2p_peer_id: "peer-a" })).status).toBe(201)
    expect((await register("tenant-b", "px@other", "http://b.test:8000", { libp2p_peer_id: "peer-a" })).status).toBe(201)
    expect(endpointOf("px")).toBe("http://a.test:8000")
    expect(warned.some((w) => w.includes("peer_dedup skipped for px") && !w.includes(ORG_B))).toBe(true)
  })

  it("the same org's newer row still evicts its older duplicate, and so does the system identity's", async () => {
    expect((await register("tenant-a", "py", "http://a.test:8000", { libp2p_peer_id: "peer-y" })).status).toBe(201)
    expect((await register("tenant-a-2", "py@sid", "http://a2.test:8000", { libp2p_peer_id: "peer-y" })).status).toBe(201)
    expect(registry.get("py")).toBeUndefined()
    expect((await register("tenant-a", "pz", "http://a.test:8000", { libp2p_peer_id: "peer-z" })).status).toBe(201)
    expect((await register("sys-caller", "pz@sid", "http://s.test:8000", { libp2p_peer_id: "peer-z" })).status).toBe(201)
    expect(registry.get("pz")).toBeUndefined()
  })
})

describe("who may heartbeat an existing vesselId", () => {
  it("[MUST-FAIL] another org's heartbeat is refused (403) and does not refresh the row", async () => {
    expect((await register("tenant-a", "hb-a", "http://a.test:8000")).status).toBe(201)
    const before = registry.get("hb-a")?.lastHeartbeat
    await new Promise((r) => setTimeout(r, 5))
    expect((await heartbeat("tenant-b", "hb-a")).status).toBe(403)
    expect(registry.get("hb-a")?.lastHeartbeat).toBe(before)
    expect(warned.some((w) => w.includes("/heartbeat refused for hb-a") && !w.includes(ORG_B))).toBe(true)
  })

  it("the row's own org and the system identity heartbeat it", async () => {
    expect((await register("tenant-a", "hb-own", "http://a.test:8000")).status).toBe(201)
    expect((await heartbeat("tenant-a-2", "hb-own")).status).toBe(200)
    expect((await heartbeat("sys-caller", "hb-own")).status).toBe(200)
  })

  it("an unknown vesselId still answers 404 (must register first)", async () => {
    expect((await heartbeat("tenant-b", "hb-none")).status).toBe(404)
  })
})
