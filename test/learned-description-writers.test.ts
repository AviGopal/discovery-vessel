// WHO MAY WRITE A LEARNED SHAPE DESCRIPTION (qa security ruling 2026-10-17). concept-db serves these as the system org's
// trusted vocabulary to every org, so: set and retire only by the SYSTEM identity (this vessel's own key's validated org,
// fail closed). produced_by is refused: it named an activity-api template, and those left with activity-api. No call here
// may reach the network: the fetch stub throws on any request.
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
const saved = { k: process.env.METABOB_API_KEY, p: savedPath }
let app: Hono
const post = (key: string, body: unknown) => app.request("/registry/shape-descriptions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify(body) })
// A learned entry is served while a live vessel lists its shape.
const live = (shape: string) => app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify({ vesselId: `v-${shape}`, endpoint: `http://v-${shape}.test`, shapes: [shape] }) })

beforeEach(() => {
  process.env.METABOB_API_KEY = OWN
  __resetSystemOrgForTests()
  setIdentityValidator(async (key: string) => (key === OWN || key === "sys-caller" ? { orgId: SYS, userId: "u", keyId: "k", scopes: [] } : key === "tenant-b" ? { orgId: "organizations:tenant-b", userId: "u", keyId: "k", scopes: [] } : key === "dflt" ? { orgId: "default", userId: "u", keyId: "k", scopes: [] } : null))
  globalThis.fetch = (async (u: unknown) => { throw new TypeError(`unexpected network call in test: ${String(u)}`) }) as typeof fetch
  app = createServer()
})
afterEach(() => {
  setIdentityValidator(null); globalThis.fetch = realFetch; registry.stop(); __resetSystemOrgForTests()
  if (saved.k === undefined) delete process.env.METABOB_API_KEY; else process.env.METABOB_API_KEY = saved.k
})
import { afterAll } from "bun:test"
afterAll(() => { if (saved.p === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH; else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = saved.p; rmSync(TMP, { recursive: true, force: true }) })

describe("learned description writers", () => {
  it("[MUST-FAIL] another org's validated key is refused (403) for SET, and nothing is stored", async () => {
    const r = await post("tenant-b", { shape: "s_set_refused", description: "injected" })
    expect(r.status).toBe(403)
    expect(registry.getShapeDescriptions()["s_set_refused"]).toBeUndefined()
  })
  it("[MUST-FAIL] another org's validated key is refused (403) for RETIRE, and the system's entry stays served", async () => {
    await live("s_parcel_totals")
    expect((await post("sys-caller", { shape: "s_parcel_totals", description: "Totals parcels per region." })).status).toBe(201)
    expect((await post("tenant-b", { shape: "s_parcel_totals", retire: true })).status).toBe(403)
    expect(registry.getShapeDescriptions()["s_parcel_totals"]).toBeDefined()
  })
  it("[MUST-FAIL] an org 'default' key (what an unauthenticated caller is handled as elsewhere) is never the system org", async () => {
    expect((await post("dflt", { shape: "s_parcel_totals", description: "x" })).status).toBe(403)
  })
  it("[MUST-FAIL] FAIL CLOSED: with no validated system org (own key unknown to identity) even the 'system' caller is refused", async () => {
    process.env.METABOB_API_KEY = "unknown-own-key"; __resetSystemOrgForTests()
    expect((await post("sys-caller", { shape: "s_parcel_totals", description: "x" })).status).toBe(403)
  })
  it("[MUST-FAIL] produced_by is refused (400), even from the system org, and nothing is stored", async () => {
    await live("s_no_template")
    const r = await post("sys-caller", { shape: "s_no_template", description: "x", produced_by: "tpl-parcels" })
    expect(r.status).toBe(400)
    expect(registry.getShapeDescriptions()["s_no_template"]).toBeUndefined()
  })
  it("[CONTROL] the system org describing a shape a live vessel lists: 201, served, and retired", async () => {
    await live("s_control")
    expect((await post("sys-caller", { shape: "s_control", description: "Totals parcels per region." })).status).toBe(201)
    expect(registry.getShapeDescriptions()["s_control"]).toBe("Totals parcels per region.")
    expect((await post("sys-caller", { shape: "s_control", retire: true })).status).toBe(200)
    expect(registry.getShapeDescriptions()["s_control"]).toBeUndefined()
  })
  it("[HELD-OUT] a vessel-ADVERTISED description still wins over a learned one", async () => {
    await app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify({ vesselId: "v-adv", endpoint: "http://v-adv.test", shapes: ["other_out"], shape_descriptions: { other_out: "ADVERTISED wording." } }) })
    expect((await post("sys-caller", { shape: "other_out", description: "learned wording" })).status).toBe(201)
    expect(registry.getShapeDescriptions()["other_out"]).toBe("ADVERTISED wording.")
  })
})
