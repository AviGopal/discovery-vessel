// WHO MAY WRITE A LEARNED SHAPE DESCRIPTION (qa security ruling 2026-10-17). concept-db serves these as the system org's
// trusted vocabulary to every org, so: set and retire only by the SYSTEM identity (this vessel's own key's validated org,
// fail closed), and a produced_by must name an existing template that declares the shape.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// The learned store's path is read when the registry is constructed (at import): point it at a temp file FIRST, so this
// file never writes a live state file whatever environment runs it.
const TMP = mkdtempSync(join(tmpdir(), "learned-writers-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
import { setIdentityValidator } from "../src/middleware/auth"
import { __resetSystemOrgForTests } from "../src/learned-description-writers"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const OWN = "own-system-key"
const realFetch = globalThis.fetch
const saved = { k: process.env.METABOB_API_KEY, a: process.env.ACTIVITY_API_ENDPOINT, p: savedPath }
let app: Hono
let templates: Record<string, string[]>
const post = (key: string, body: unknown) => app.request("/registry/shape-descriptions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify(body) })

beforeEach(() => {
  process.env.METABOB_API_KEY = OWN
  process.env.ACTIVITY_API_ENDPOINT = "http://activity-api.test"
  __resetSystemOrgForTests()
  templates = { "tpl-parcels": ["s_parcel_totals", "other_out", "s_set_refused", "s_no_template", "s_control"] }
  setIdentityValidator(async (key: string) => (key === OWN || key === "sys-caller" ? { orgId: SYS, userId: "u", keyId: "k", scopes: [] } : key === "tenant-b" ? { orgId: "organizations:tenant-b", userId: "u", keyId: "k", scopes: [] } : key === "dflt" ? { orgId: "default", userId: "u", keyId: "k", scopes: [] } : null))
  globalThis.fetch = (async (u: unknown) => {
    const m = /\/v2\/activities\/templates\/([^/?]+)$/.exec(String(u))
    if (!m) throw new TypeError(`unexpected network call in test: ${String(u)}`)
    const id = decodeURIComponent(m[1]!)
    return templates[id] ? Response.json({ id, output_shapes: templates[id] }) : new Response("{}", { status: 404 })
  }) as typeof fetch
  app = createServer()
})
afterEach(() => {
  setIdentityValidator(null); globalThis.fetch = realFetch; registry.stop(); __resetSystemOrgForTests()
  for (const [k, v] of [["METABOB_API_KEY", saved.k], ["ACTIVITY_API_ENDPOINT", saved.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})
import { afterAll } from "bun:test"
afterAll(() => { if (saved.p === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH; else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = saved.p; rmSync(TMP, { recursive: true, force: true }) })

describe("learned description writers", () => {
  it("[MUST-FAIL] another org's validated key is refused (403) for SET, and nothing is stored", async () => {
    const r = await post("tenant-b", { shape: "s_set_refused", description: "injected", produced_by: "tpl-parcels" })
    expect(r.status).toBe(403)
    expect(registry.getShapeDescriptions()["s_set_refused"]).toBeUndefined()
  })
  it("[MUST-FAIL] another org's validated key is refused (403) for RETIRE, and the system's entry stays served", async () => {
    expect((await post("sys-caller", { shape: "s_parcel_totals", description: "Totals parcels per region.", produced_by: "tpl-parcels" })).status).toBe(201)
    expect((await post("tenant-b", { shape: "s_parcel_totals", retire: true })).status).toBe(403)
    expect(registry.getShapeDescriptions()["s_parcel_totals"]).toBeDefined()
  })
  it("[MUST-FAIL] an org 'default' key (what an unauthenticated caller is handled as elsewhere) is never the system org", async () => {
    expect((await post("dflt", { shape: "s_parcel_totals", description: "x", produced_by: "tpl-parcels" })).status).toBe(403)
  })
  it("[MUST-FAIL] FAIL CLOSED: with no validated system org (own key unknown to identity) even the 'system' caller is refused", async () => {
    process.env.METABOB_API_KEY = "unknown-own-key"; __resetSystemOrgForTests()
    expect((await post("sys-caller", { shape: "s_parcel_totals", description: "x", produced_by: "tpl-parcels" })).status).toBe(403)
  })
  it("[MUST-FAIL] produced_by naming no template is refused (400)", async () => {
    const r = await post("sys-caller", { shape: "s_no_template", description: "x", produced_by: "tpl-nope" })
    expect(r.status).toBe(400)
    expect(registry.getShapeDescriptions()["s_no_template"]).toBeUndefined()
  })
  it("[MUST-FAIL] produced_by naming a template that does not declare the shape is refused (400)", async () => {
    expect((await post("sys-caller", { shape: "s_unrelated", description: "x", produced_by: "tpl-parcels" })).status).toBe(400)
  })
  it("[CONTROL] the system org with a real producing template: 201, and the minted shape is served", async () => {
    expect((await post("sys-caller", { shape: "s_control", description: "Totals parcels per region.", produced_by: "tpl-parcels" })).status).toBe(201)
    expect(registry.getShapeDescriptions()["s_control"]).toBe("Totals parcels per region.")
    expect((await post("sys-caller", { shape: "s_control", retire: true })).status).toBe(200)
    expect(registry.getShapeDescriptions()["s_control"]).toBeUndefined()
  })
  it("[HELD-OUT] a vessel-ADVERTISED description still wins over a learned one", async () => {
    await app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify({ vesselId: "v-adv", endpoint: "http://v-adv.test", shapes: ["other_out"], shape_descriptions: { other_out: "ADVERTISED wording." } }) })
    expect((await post("sys-caller", { shape: "other_out", description: "learned wording", produced_by: "tpl-parcels" })).status).toBe(201)
    expect(registry.getShapeDescriptions()["other_out"]).toBe("ADVERTISED wording.")
  })
})
