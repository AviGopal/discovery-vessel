// SHAPES WRITTEN BUT NOT SERVED: a vessel may describe the rows it writes (the walk's hop, for instance) without
// serving them. Readers get the description as data_shapes in the shapeDescriptions read; nothing that offers calls
// sees them (capability lookup, routing, the callable descriptions and inputs); and a shape anyone serves keeps its
// server's description.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "data-shapes-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { resolve } = await import("../src/resolvers")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const realFetch = globalThis.fetch
let app: Hono
const HOP = "The record of one call the walk made; pointer_type is the shape it called. Not a shape to call."
const register = (body: Record<string, unknown>) =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys" }, body: JSON.stringify(body) })
const read = async (pointer: Record<string, unknown>) =>
  (await resolve({ type: "shapeDescriptions", ...pointer } as never)) as unknown as {
    shape_descriptions: Record<string, string>; shape_inputs: Record<string, unknown>; data_shapes: Record<string, string>
  }

beforeEach(() => {
  setIdentityValidator(async () => ({ orgId: "organizations:sys", userId: "u", keyId: "k", scopes: [] }))
  globalThis.fetch = (async (u: unknown) => { throw new TypeError(`unexpected network call in test: ${String(u)}`) }) as typeof fetch
  app = createServer()
  registry.list().forEach((v) => registry.unregister(v.vesselId))
})
afterEach(() => { setIdentityValidator(null); globalThis.fetch = realFetch; registry.list().forEach((v) => registry.unregister(v.vesselId)) })
afterAll(() => {
  if (savedPath === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
  else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = savedPath
  rmSync(TMP, { recursive: true, force: true })
})

describe("shapes written but not served", () => {
  it("[MUST-FAIL] a written shape is described as data, and nothing that offers calls sees it", async () => {
    await register({ vesselId: "walk", endpoint: "http://walk.test", systemVessel: true, shapes: ["walk_heartbeat"], writes: ["hop"],
      shape_descriptions: { hop: HOP } })
    for (const p of [{}, { declared: true }]) {
      const r = await read(p)
      expect(r.data_shapes.hop).toBe(HOP)
      expect(r.shape_descriptions.hop).toBeUndefined()
      expect(r.shape_inputs.hop).toBeUndefined()
    }
    const cap = (await resolve({ type: "vesselCapability", shape: "hop" } as never)) as unknown as { found: boolean; vessels: unknown[] }
    expect(cap.found).toBe(false)
    expect(cap.vessels).toHaveLength(0)
    const routed = await app.request("/resolve", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys" },
      body: JSON.stringify({ pointer: { type: "hop" } }) })
    expect(routed.status).toBe(404)
  })

  it("[MUST-FAIL] a shape some vessel serves keeps the server's description; a writer cannot override it", async () => {
    await register({ vesselId: "server", endpoint: "http://server.test", systemVessel: true, shapes: ["thing"], shape_descriptions: { thing: "Served thing." } })
    await register({ vesselId: "writer", endpoint: "http://writer.test", systemVessel: true, shapes: ["walk_heartbeat"], writes: ["thing"],
      shape_descriptions: { thing: "Written wording." } })
    const r = await read({})
    expect(r.shape_descriptions.thing).toBe("Served thing.")
    expect(r.data_shapes.thing).toBeUndefined()
  })

  it("a vessel cannot list a shape it serves as written", async () => {
    await register({ vesselId: "both", endpoint: "http://both.test", systemVessel: true, shapes: ["thing"], writes: ["thing"], shape_descriptions: { thing: "x" } })
    expect(registry.list().find((v) => v.vesselId === "both")?.writes).toBeUndefined()
  })
  it("[MUST-FAIL] a written-shape description over the cap is dropped, not cut and not served", async () => {
    await register({ vesselId: "walk", endpoint: "http://walk.test", systemVessel: true, shapes: ["walk_heartbeat"], writes: ["hop", "big"],
      shape_descriptions: { hop: HOP, big: "x".repeat(5_000) } })
    const r = await read({})
    expect(r.data_shapes.hop).toBe(HOP)
    expect(r.data_shapes.big).toBeUndefined()
  })
})
