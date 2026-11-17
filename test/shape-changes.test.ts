// SPDX-License-Identifier: MIT
// DECLARED SHAPE CHANGES: a vessel declares, at registration, which shapes a call of each shape it serves alters, beside
// the shape its answer is (shape_answers). The shapeDescriptions read and the registry endpoint return both, so a reader
// can tell a call that makes a change from one that reads its effect, and hold reach to a read made after the change.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "shape-changes-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { resolve, sanitizeShapeChanges, CHANGES_MAX, WRITES_MAX } = await import("../src/resolvers")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const realFetch = globalThis.fetch
let app: Hono
const register = (body: Record<string, unknown>) =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify(body) })
const read = async (pointer: Record<string, unknown>) =>
  (await resolve({ type: "shapeDescriptions", ...pointer } as never)) as unknown as { shape_answers: Record<string, string>; shape_changes: Record<string, string[]> }

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

describe("sanitizeShapeChanges", () => {
  it("[MUST-FAIL] keeps changes only for a shape the vessel advertises, and only plain shape names, deduplicated and bounded", () => {
    const many = Array.from({ length: CHANGES_MAX + 3 }, (_, i) => `s${i}`)
    expect(sanitizeShapeChanges({
      view_write: ["viewState", "viewState", "a b", 3, "http://x"], not_mine: ["x"], empty: [], one: "viewState", wide: many,
    }, ["view_write", "empty", "one", "wide"])).toEqual({ view_write: ["viewState"], wide: many.slice(0, CHANGES_MAX) })
  })
  it("[MUST-FAIL] keeps at most WRITES_MAX shapes from one registration", () => {
    const shapes = Array.from({ length: WRITES_MAX + 1 }, (_, i) => `sc_w${i}`)
    const kept = sanitizeShapeChanges(Object.fromEntries(shapes.map((s) => [s, ["scX"]])), shapes)
    expect(Object.keys(kept ?? {})).toHaveLength(WRITES_MAX)
  })
  it("is undefined for no declaration, or shapes that are not a list", () => {
    expect(sanitizeShapeChanges(undefined, ["view_write"])).toBeUndefined()
    expect(sanitizeShapeChanges({ view_write: ["viewState"] }, "view_write")).toBeUndefined()
  })
})

describe("declared changes through registration, the shapeDescriptions read and the registry endpoint", () => {
  // The registry keeps earlier tests' vessels (one process runs every file): these shapes are this file's own, declare no
  // inputs (so a declared-only read elsewhere never sees them), and every read and check is scoped to them.
  const MINE = ["sc_view_write", "sc_view_read"]
  const only = <T,>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([k]) => MINE.includes(k)))
  it("[MUST-FAIL] a call that changes a shape and one that reads it are told apart: changes beside answers, only for what it serves", async () => {
    await register({
      vesselId: "v-sc-view", endpoint: "http://v-sc-view.test", systemVessel: true, shapes: MINE,
      shape_descriptions: { sc_view_write: "Writes a view.", sc_view_read: "Reads the view in force." },
      shape_answers: { sc_view_read: "scViewState" },
      shape_changes: { sc_view_write: ["scViewState"], stray: ["scViewState"] },
    })
    const mine = await read({ shapes: MINE })
    expect(mine.shape_changes).toEqual({ sc_view_write: ["scViewState"] })
    expect(mine.shape_answers).toEqual({ sc_view_read: "scViewState" })
    expect(only((await read({})).shape_changes)).toEqual({ sc_view_write: ["scViewState"] })
    expect((await read({ shapes: ["sc_view_read"] })).shape_changes).toEqual({})
    const http = (await (await app.request("/registry/shape-descriptions", { headers: { Authorization: "ApiKey sys-caller" } })).json()) as { shape_changes: Record<string, string[]> }
    expect(only(http.shape_changes)).toEqual({ sc_view_write: ["scViewState"] })
  })
  it("a vessel that declares none adds none, and the read always carries the key (a guard)", async () => {
    await register({ vesselId: "v-sc-plain", endpoint: "http://v-sc-plain.test", systemVessel: true, shapes: ["sc_plain_read"], shape_descriptions: { sc_plain_read: "Reads." } })
    expect((await read({ shapes: ["sc_plain_read"] })).shape_changes).toEqual({})
  })
})

describe("which vessels' declared changes the registry serves", () => {
  // Registered straight into the registry, as its own tests do, with this file's own vessels and shapes, and unregistered
  // after each leg: the registry is one for every file, and another file counts what it holds (load: pruneExpired).
  const mine: string[] = []
  const reg = (vesselId: string, shape: string, changed: string[], more: Record<string, unknown> = {}) => {
    mine.push(vesselId)
    return registry.register({ vesselId, vesselName: vesselId, version: "1", endpoint: `http://${vesselId}.test`, shapes: [shape],
      shape_changes: { [shape]: changed }, ...more } as never)
  }
  afterEach(() => { for (const id of mine.splice(0)) registry.unregister(id) })
  it("[MUST-FAIL] an expired vessel's changes are not served", () => {
    const v = reg("v-sc-expired", "sc_expired_write", ["scX"], { systemVessel: true })
    expect(registry.getShapeChanges().sc_expired_write).toEqual(["scX"])
    v.expiresAt = Date.now() - 1
    expect(registry.getShapeChanges().sc_expired_write).toBeUndefined()
  })
  it("[MUST-FAIL] a read scoped to one org is not told another org's vessel's changes; a system vessel's, any org's", () => {
    reg("v-sc-org-b", "sc_org_b_write", ["scX"], { orgId: "org-sc-b" })
    reg("v-sc-system", "sc_system_write", ["scX"], { systemVessel: true })
    const a = registry.getShapeChanges({ orgIds: ["org-sc-a"] })
    expect([a.sc_org_b_write, a.sc_system_write]).toEqual([undefined, ["scX"]])
    expect(registry.getShapeChanges({ orgIds: ["org-sc-b"] }).sc_org_b_write).toEqual(["scX"])
  })
  it("[MUST-FAIL] when two vessels declare one shape, the first registered is served", () => {
    reg("v-sc-first", "sc_dup_write", ["scFirst"], { systemVessel: true })
    reg("v-sc-second", "sc_dup_write", ["scSecond"], { systemVessel: true })
    expect(registry.getShapeChanges().sc_dup_write).toEqual(["scFirst"])
  })
})
