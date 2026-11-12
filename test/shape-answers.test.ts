// DECLARED SHAPE ANSWERS: a vessel declares, at registration, the shape of the row a call of each shape it serves answers
// with, and the shapeDescriptions read returns them, so what makes a row of a needed shape is data a reader can follow
// (the walk's skip names the call that makes what a step still needs), not prose it has to act on.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "shape-answers-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
const { resolve, sanitizeShapeAnswers } = await import("../src/resolvers")
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

const SYS = "organizations:system-fixture"
const realFetch = globalThis.fetch
let app: Hono
const INPUT = { type: "object", properties: { cwd: { type: "string" } } }
const register = (body: Record<string, unknown>) =>
  app.request("/register", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys-caller" }, body: JSON.stringify(body) })
const read = async (pointer: Record<string, unknown>) =>
  (await resolve({ type: "shapeDescriptions", ...pointer } as never)) as unknown as { shape_answers: Record<string, string> }

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

describe("sanitizeShapeAnswers", () => {
  it("keeps an answer only for a shape the vessel advertises, and only a plain shape name", () => {
    expect(sanitizeShapeAnswers({ git_diff: "gitDiff", not_mine: "gitDiff", bad: "a b", addr: "http://x", n: 3 }, ["git_diff", "bad", "addr", "n"]))
      .toEqual({ git_diff: "gitDiff" })
  })
  it("is undefined for no declaration, or shapes that are not a list", () => {
    expect(sanitizeShapeAnswers(undefined, ["git_diff"])).toBeUndefined()
    expect(sanitizeShapeAnswers({ git_diff: "gitDiff" }, "git_diff")).toBeUndefined()
  })
})

describe("declared answers through registration and the shapeDescriptions read", () => {
  it("[MUST-FAIL] a registered vessel's declared answers come back with its descriptions, and only for what it serves", async () => {
    await register({
      vesselId: "v-tools", endpoint: "http://v-tools.test", systemVessel: true, shapes: ["git_diff", "git_commit"],
      shape_descriptions: { git_diff: "Shows a change.", git_commit: "Commits a change." },
      shape_inputs: { git_diff: INPUT, git_commit: INPUT },
      shape_answers: { git_diff: "gitDiff", git_commit: "gitCommit", stray: "x" },
    })
    expect((await read({})).shape_answers).toEqual({ git_diff: "gitDiff", git_commit: "gitCommit" })
    expect((await read({ declared: true, shapes: ["git_diff"] })).shape_answers).toEqual({ git_diff: "gitDiff" })
  })
  it("a vessel that declares none adds none (a guard)", async () => {
    await register({ vesselId: "v-plain", endpoint: "http://v-plain.test", systemVessel: true, shapes: ["fs_read"], shape_descriptions: { fs_read: "Reads." } })
    expect((await read({ shapes: ["fs_read"] })).shape_answers).toEqual({})
  })
})
