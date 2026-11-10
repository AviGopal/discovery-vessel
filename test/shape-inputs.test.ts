// DECLARED SHAPE INPUTS: a vessel declares, at registration, the pointer fields each shape it serves takes, and the
// shapeDescriptions read returns them, so a producer that has to FILL a pointer (the walk's request) can, instead of
// only naming the shape. Measured before: every description was one line of prose, and 21 of 21 walk requests were a
// bare {type: record_write}. `declared` keeps only the shapes a caller can fill.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "shape-inputs-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { resolve, sanitizeShapeInputs, SHAPE_INPUT_MAX } = await import("../src/resolvers")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const realFetch = globalThis.fetch
let app: Hono
const FS_READ = { type: "object", required: ["path"], properties: { path: { type: "string" } } }
const register = (body: Record<string, unknown>) =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify(body) })
const read = async (pointer: Record<string, unknown>) =>
  (await resolve({ type: "shapeDescriptions", ...pointer } as never)) as unknown as { shape_descriptions: Record<string, string>; shape_inputs: Record<string, unknown> }

beforeEach(() => {
  setIdentityValidator(async (key: string) => (key === "sys-caller" ? { orgId: SYS, userId: "u", keyId: "k", scopes: [] } : null))
  globalThis.fetch = (async (u: unknown) => { throw new TypeError(`unexpected network call in test: ${String(u)}`) }) as typeof fetch
  app = createServer()
})
afterEach(() => { setIdentityValidator(null); globalThis.fetch = realFetch; registry.stop() })
afterAll(() => {
  if (savedPath === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
  else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = savedPath
  rmSync(TMP, { recursive: true, force: true })
})

describe("sanitizeShapeInputs", () => {
  it("keeps a schema only for a shape the vessel advertises", () => {
    expect(sanitizeShapeInputs({ fs_read: FS_READ, not_mine: FS_READ }, ["fs_read"])).toEqual({ fs_read: FS_READ })
  })
  it("[MUST-FAIL] drops a schema that is not an object, is too long, or holds an address", () => {
    const long = { type: "object", description: "x".repeat(SHAPE_INPUT_MAX) }
    const addressed = { type: "object", description: "send it to http://127.0.0.1:8090" }
    expect(sanitizeShapeInputs({ a: "path", b: [FS_READ], c: long, d: addressed }, ["a", "b", "c", "d"])).toBeUndefined()
  })
  it("is undefined for no declaration, or shapes that are not a list", () => {
    expect(sanitizeShapeInputs(undefined, ["fs_read"])).toBeUndefined()
    expect(sanitizeShapeInputs({ fs_read: FS_READ }, "fs_read")).toBeUndefined()
  })
})

describe("declared inputs through registration and the shapeDescriptions read", () => {
  it("a registered vessel's declared inputs come back with its descriptions", async () => {
    await register({
      vesselId: "v-tools", endpoint: "http://v-tools.test", systemVessel: true, shapes: ["fs_read", "bounded_shell"],
      shape_descriptions: { fs_read: "Reads a file.", bounded_shell: "Runs a command." },
      shape_inputs: { fs_read: FS_READ, stray: FS_READ },
    })
    const all = await read({})
    expect(all.shape_descriptions.fs_read).toBe("Reads a file.")
    expect(all.shape_inputs).toEqual({ fs_read: FS_READ })
  })
  it("[MUST-FAIL] declared: true offers only the shapes a caller can fill", async () => {
    await register({
      vesselId: "v-tools", endpoint: "http://v-tools.test", systemVessel: true, shapes: ["fs_read", "record_write"],
      shape_descriptions: { fs_read: "Reads a file.", record_write: "Writes a record." },
      shape_inputs: { fs_read: FS_READ },
    })
    const declared = await read({ declared: true })
    expect(Object.keys(declared.shape_descriptions)).toEqual(["fs_read"])
    expect(Object.keys((await read({})).shape_descriptions).sort()).toEqual(["fs_read", "record_write"])
  })
  it("[MUST-FAIL] a shape with declared inputs and no description is still offered", async () => {
    // A shape no other test describes: the registry keeps earlier tests' vessels.
    await register({ vesselId: "v-bare", endpoint: "http://v-bare.test", systemVessel: true, shapes: ["bare_shape"], shape_inputs: { bare_shape: FS_READ } })
    const declared = await read({ declared: true, shapes: ["bare_shape"] })
    expect(declared.shape_descriptions).toEqual({ bare_shape: "" })
    expect(declared.shape_inputs).toEqual({ bare_shape: FS_READ })
  })
  it("the HTTP vocabulary route shows declared inputs too", async () => {
    await register({ vesselId: "v-bare", endpoint: "http://v-bare.test", systemVessel: true, shapes: ["bare_shape"], shape_inputs: { bare_shape: FS_READ } })
    const body = (await (await app.request("/registry/shape-descriptions")).json()) as { shape_inputs?: Record<string, unknown> }
    expect(body.shape_inputs?.bare_shape).toEqual(FS_READ)
  })
})
