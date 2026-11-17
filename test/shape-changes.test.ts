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
const { resolve, sanitizeShapeChanges, CHANGES_MAX } = await import("../src/resolvers")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const realFetch = globalThis.fetch
let app: Hono
const INPUT = { type: "object", properties: { cwd: { type: "string" } } }
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
  it("is undefined for no declaration, or shapes that are not a list", () => {
    expect(sanitizeShapeChanges(undefined, ["view_write"])).toBeUndefined()
    expect(sanitizeShapeChanges({ view_write: ["viewState"] }, "view_write")).toBeUndefined()
  })
})

describe("declared changes through registration, the shapeDescriptions read and the registry endpoint", () => {
  it("[MUST-FAIL] a call that changes a shape and one that reads it are told apart: changes beside answers, only for what it serves", async () => {
    await register({
      vesselId: "v-view", endpoint: "http://v-view.test", systemVessel: true, shapes: ["view_write", "view_read"],
      shape_descriptions: { view_write: "Writes a view.", view_read: "Reads the view in force." },
      shape_inputs: { view_write: INPUT, view_read: INPUT },
      shape_answers: { view_read: "viewState" },
      shape_changes: { view_write: ["viewState"], stray: ["viewState"] },
    })
    const all = await read({})
    expect(all.shape_changes).toEqual({ view_write: ["viewState"] })
    expect(all.shape_answers).toEqual({ view_read: "viewState" })
    expect((await read({ shapes: ["view_read"] })).shape_changes).toEqual({})
    const http = (await (await app.request("/registry/shape-descriptions", { headers: { Authorization: "ApiKey sys-caller" } })).json()) as { shape_changes: Record<string, string[]> }
    expect(http.shape_changes).toEqual({ view_write: ["viewState"] })
  })
  it("a vessel that declares none adds none, and the read always carries the key (a guard)", async () => {
    await register({ vesselId: "v-plain", endpoint: "http://v-plain.test", systemVessel: true, shapes: ["fs_read"], shape_descriptions: { fs_read: "Reads." } })
    expect((await read({ shapes: ["fs_read"] })).shape_changes).toEqual({})
  })
})
