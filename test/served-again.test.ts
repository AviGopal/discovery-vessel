// A SHAPE SERVED AGAIN: a shape this discovery answered unserved is recorded when a vessel registers it again, and
// only such a shape, so a restart's registers record nothing (src/served-again.ts).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const TMP = mkdtempSync(join(tmpdir(), "served-again-"))
const savedPath = process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(TMP, "learned.json")
const { createServer, registry } = await import("../src/index")
import { setIdentityValidator } from "../src/middleware/auth"
import { type Served, servedAgain, setServedAgain } from "../src/served-again"
import { writeObservedVia } from "../src/client-connected"
import type { Hono } from "hono"

const realFetch = globalThis.fetch
let app: Hono
const post = (path: string, body: Record<string, unknown>) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey sys" }, body: JSON.stringify(body) })
const register = (vesselId: string, shapes: string[]) => post("/register", { vesselId, endpoint: `http://${vesselId}.test`, systemVessel: true, shapes })
const ask = (type: string) => post("/resolve", { pointer: { type } })
// each write the observer makes, settled by the test (true: records took it)
let calls: Served[] = []
let settle: Array<(ok: boolean) => void> = []
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  setIdentityValidator(async () => ({ orgId: "organizations:sys", userId: "u", keyId: "k", scopes: [] }))
  globalThis.fetch = (async (u: unknown) => { throw new TypeError(`unexpected network call in test: ${String(u)}`) }) as typeof fetch
  app = createServer()
  registry.list().forEach((v) => registry.unregister(v.vesselId))
  calls = []; settle = []
  setServedAgain(servedAgain((row) => { calls.push(row); return new Promise<boolean>((r) => settle.push(r)) }))
})
afterEach(() => { setServedAgain(null); setIdentityValidator(null); globalThis.fetch = realFetch; registry.list().forEach((v) => registry.unregister(v.vesselId)) })
afterAll(() => {
  if (savedPath === undefined) delete process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH
  else process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = savedPath
  rmSync(TMP, { recursive: true, force: true })
})

describe("a shape served again", () => {
  it("[MUST-FAIL] a shape discovery answered unserved is recorded when a vessel registers it, once", async () => {
    expect((await ask("tool_a")).status).toBe(404)
    expect((await register("v1", ["tool_a", "tool_b"])).status).toBeLessThan(300)
    expect(calls).toEqual([{ served: "tool_a", vessel_id: "v1" }])
    settle[0]!(true); await flush()
    await register("v1", ["tool_a"])
    await register("v2", ["tool_a"])
    expect(calls).toHaveLength(1)
  })

  it("[GUARD] a register of shapes no one was told are unserved records nothing: a restart writes no row", async () => {
    await register("v1", ["tool_a", "tool_b", "tool_c"])
    await register("v2", ["tool_a"])
    expect(calls).toEqual([])
  })

  it("[GUARD] a shape answered by a producer is not said unserved", async () => {
    await register("v1", ["tool_a"])
    await ask("tool_a").catch(() => undefined) // the producer is not reachable; it was found, so this is no unserved answer
    registry.unregister("v1")
    await register("v1", ["tool_a"])
    expect(calls).toEqual([])
  })

  it("[GUARD] a row records did not take stays said and is written at the shape's next register; one write per shape in flight", async () => {
    await ask("tool_a")
    await register("v1", ["tool_a"])
    await register("v2", ["tool_a"]) // the first write is still in flight
    expect(calls).toHaveLength(1)
    settle[0]!(false); await flush()
    await register("v2", ["tool_a"])
    expect(calls).toEqual([{ served: "tool_a", vessel_id: "v1" }, { served: "tool_a", vessel_id: "v2" }])
    settle[1]!(true); await flush()
    await register("v3", ["tool_a"])
    expect(calls).toHaveLength(2)
  })

  it("[GUARD] said unserved again after it was recorded, it is recorded again at its next recovery", async () => {
    await ask("tool_a")
    await register("v1", ["tool_a"])
    settle[0]!(true); await flush()
    registry.unregister("v1")
    await ask("tool_a")
    await register("v1", ["tool_a"])
    expect(calls).toHaveLength(2)
  })
})

describe("the row records is sent", () => {
  it("[MUST-FAIL] a record_write of shape_served {served, vessel_id, node_key_id}, as this discovery (role detector), under the node key", async () => {
    let got: { url: string; auth: string | null; body: unknown } | undefined
    const s = Bun.serve({ port: 0, fetch: async (req) => { got = { url: new URL(req.url).pathname, auth: req.headers.get("Authorization"), body: await req.json() }; return Response.json({ id: "r1", seq: 9 }) } })
    globalThis.fetch = realFetch
    try {
      const write = writeObservedVia<Served>("shape_served", "the shape's next register", `http://127.0.0.1:${s.port}`, () => "node-key", () => "discovery-vessel",
        async (k) => (k === "node-key" ? "nk1" : null))
      expect(await write({ served: "tool_a", vessel_id: "v1" })).toBe(true)
      expect(got).toEqual({
        url: "/resolve",
        auth: "ApiKey node-key",
        body: { pointer: { type: "record_write", row: { shape: "shape_served", served: "tool_a", vessel_id: "v1", node_key_id: "nk1", input_refs: [] }, writer: "discovery-vessel", role: "detector" } },
      })
    } finally { s.stop(true) }
  })
})
