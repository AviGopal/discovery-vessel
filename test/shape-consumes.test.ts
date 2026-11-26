// SPDX-License-Identifier: MIT
// DECLARED SHAPE CONSUMES: a vessel declares, at registration, which rows a call of each shape it serves takes, and which
// of the call's pointer fields each binds from that row, beside the shape its answer is (shape_answers). The
// shapeDescriptions read and the registry endpoint return both, so a reader can chain which call takes what the last one
// made as data, not prose.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "shape-consumes-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { resolve, sanitizeShapeConsumes, CONSUMES_MAX, BINDS_MAX, WRITES_MAX } = await import("../src/resolvers")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"
import type { ShapeConsume } from "../src/types"

const SYS = "organizations:system-fixture"
const realFetch = globalThis.fetch
let app: Hono
const register = (body: Record<string, unknown>) =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify(body) })
const read = async (pointer: Record<string, unknown>) =>
  (await resolve({ type: "shapeDescriptions", ...pointer } as never)) as unknown as { shape_answers: Record<string, string>; shape_consumes: Record<string, ShapeConsume[]> }

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

describe("sanitizeShapeConsumes", () => {
  it("[MUST-FAIL] keeps consumes only for a shape the vessel advertises, each bind field to the row field it names", () => {
    expect(sanitizeShapeConsumes({
      commit: [{ shape: "editResult", binds: { cwd: "cwd" } }, { shape: "worktree", binds: { cwd: "path", repo: "name" } }],
      not_mine: [{ shape: "editResult", binds: { cwd: "cwd" } }],
    }, ["commit"])).toEqual({ commit: [{ shape: "editResult", binds: { cwd: "cwd" } }, { shape: "worktree", binds: { cwd: "path", repo: "name" } }] })
  })
  it("[MUST-FAIL] drops an entry that is not a plain shape with plain field binds; a missing binds is none", () => {
    expect(sanitizeShapeConsumes({
      c: [
        { shape: "a b", binds: {} }, { shape: "http://x" }, "editResult", null, [], { binds: { cwd: "cwd" } },
        { shape: "badKey", binds: { "a.b": "cwd" } }, { shape: "badValue", binds: { cwd: 3 } }, { shape: "dotted", binds: { cwd: "a.b" } },
        { shape: "listBinds", binds: ["cwd"] }, { shape: "nullBinds", binds: null },
        { shape: "bare" }, { shape: "bare", binds: { cwd: "cwd" } },
      ],
      only_bad: [{ shape: "x y" }], not_a_list: { shape: "editResult" },
    }, ["c", "only_bad", "not_a_list"])).toEqual({ c: [{ shape: "bare", binds: {} }] })
  })
  it("[MUST-FAIL] bounds entries per call, binds per entry and calls per registration", () => {
    const many = Array.from({ length: CONSUMES_MAX + 2 }, (_, i) => ({ shape: `s${i}` }))
    expect(sanitizeShapeConsumes({ c: many }, ["c"])?.c).toHaveLength(CONSUMES_MAX)
    const wide = Object.fromEntries(Array.from({ length: BINDS_MAX + 1 }, (_, i) => [`f${i}`, `g${i}`]))
    const edge = Object.fromEntries(Array.from({ length: BINDS_MAX }, (_, i) => [`f${i}`, `g${i}`]))
    expect(sanitizeShapeConsumes({ c: [{ shape: "wide", binds: wide }, { shape: "edge", binds: edge }] }, ["c"])).toEqual({ c: [{ shape: "edge", binds: edge }] })
    const shapes = Array.from({ length: WRITES_MAX + 1 }, (_, i) => `scn_w${i}`)
    expect(Object.keys(sanitizeShapeConsumes(Object.fromEntries(shapes.map((s) => [s, [{ shape: "x" }]])), shapes) ?? {})).toHaveLength(WRITES_MAX)
  })
  it("is undefined for no declaration, or shapes that are not a list", () => {
    expect(sanitizeShapeConsumes(undefined, ["c"])).toBeUndefined()
    expect(sanitizeShapeConsumes([{ shape: "x" }], ["c"])).toBeUndefined()
    expect(sanitizeShapeConsumes({ c: [{ shape: "x" }] }, "c")).toBeUndefined()
  })
})

describe("declared consumes through registration, the shapeDescriptions read and the registry endpoint", () => {
  // These shapes are this file's own (one process runs every file), declare no inputs, and every check is scoped to them.
  // Its vessels are unregistered after each leg: another file reads every vessel's declared answers unscoped.
  afterEach(() => { registry.unregister("v-scn-tools"); registry.unregister("v-scn-plain") })
  const MINE = ["scn_edit", "scn_commit"]
  const only = <T,>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([k]) => MINE.includes(k)))
  const COMMIT = [{ shape: "scnEditResult", binds: { cwd: "cwd" } }, { shape: "scnWorktree", binds: { cwd: "dir" } }]
  const EDIT = [{ shape: "scnFileContent", binds: { path: "path" } }]
  it("[MUST-FAIL] a call's consumes come back beside the answers of what makes them, keyed by the call, only for what it serves", async () => {
    await register({
      vesselId: "v-scn-tools", endpoint: "http://v-scn-tools.test", systemVessel: true, shapes: MINE,
      shape_descriptions: { scn_edit: "Edits a file.", scn_commit: "Commits a clone." },
      shape_answers: { scn_edit: "scnEditResult" },
      shape_consumes: { scn_edit: EDIT, scn_commit: COMMIT, stray: COMMIT },
    })
    const mine = await read({ shapes: MINE })
    expect(mine.shape_consumes).toEqual({ scn_edit: EDIT, scn_commit: COMMIT })
    expect(mine.shape_answers).toEqual({ scn_edit: "scnEditResult" })
    expect(only((await read({})).shape_consumes)).toEqual({ scn_edit: EDIT, scn_commit: COMMIT })
    expect((await read({ shapes: ["scn_commit"] })).shape_consumes).toEqual({ scn_commit: COMMIT })
    const http = (await (await app.request("/registry/shape-descriptions", { headers: { Authorization: "ApiKey sys-caller" } })).json()) as { shape_consumes: Record<string, ShapeConsume[]> }
    expect(only(http.shape_consumes)).toEqual({ scn_edit: EDIT, scn_commit: COMMIT })
  })
  it("a vessel that declares none adds none, and the read always carries the key (a guard)", async () => {
    await register({ vesselId: "v-scn-plain", endpoint: "http://v-scn-plain.test", systemVessel: true, shapes: ["scn_plain"], shape_descriptions: { scn_plain: "Reads." } })
    expect((await read({ shapes: ["scn_plain"] })).shape_consumes).toEqual({})
  })
})

describe("which vessels' declared consumes the registry serves", () => {
  const mine: string[] = []
  const reg = (vesselId: string, shape: string, consumed: ShapeConsume[], more: Record<string, unknown> = {}) => {
    mine.push(vesselId)
    return registry.register({ vesselId, vesselName: vesselId, version: "1", endpoint: `http://${vesselId}.test`, shapes: [shape],
      shape_consumes: { [shape]: consumed }, ...more } as never)
  }
  afterEach(() => { for (const id of mine.splice(0)) registry.unregister(id) })
  const X = [{ shape: "scnX", binds: { cwd: "cwd" } }]
  it("[MUST-FAIL] an expired vessel's consumes are not served", () => {
    const v = reg("v-scn-expired", "scn_expired", X, { systemVessel: true })
    expect(registry.getShapeConsumes().scn_expired).toEqual(X)
    v.expiresAt = Date.now() - 1
    expect(registry.getShapeConsumes().scn_expired).toBeUndefined()
  })
  it("[MUST-FAIL] a read scoped to one org is not told another org's vessel's consumes; a system vessel's, any org's", () => {
    reg("v-scn-org-b", "scn_org_b", X, { orgId: "org-scn-b" })
    reg("v-scn-system", "scn_system", X, { systemVessel: true })
    const a = registry.getShapeConsumes({ orgIds: ["org-scn-a"] })
    expect([a.scn_org_b, a.scn_system]).toEqual([undefined, X])
    expect(registry.getShapeConsumes({ orgIds: ["org-scn-b"] }).scn_org_b).toEqual(X)
  })
  it("[MUST-FAIL] when two vessels declare one shape, the first registered is served", () => {
    reg("v-scn-first", "scn_dup", [{ shape: "scnFirst", binds: {} }], { systemVessel: true })
    reg("v-scn-second", "scn_dup", [{ shape: "scnSecond", binds: {} }], { systemVessel: true })
    expect(registry.getShapeConsumes().scn_dup).toEqual([{ shape: "scnFirst", binds: {} }])
  })
  it("[MUST-FAIL] a reader changing what it was served does not change what the registry holds", () => {
    reg("v-scn-copy", "scn_copy", [{ shape: "scnX", binds: { cwd: "cwd" } }], { systemVessel: true })
    const served = registry.getShapeConsumes().scn_copy
    served[0].binds.cwd = "changed"
    expect(registry.getShapeConsumes().scn_copy).toEqual(X)
  })
})
