/**
 * A vessel's DECLARED resolver tier reaches the dispatcher on the capability row.
 *
 * Registration has always carried `resolvers: Array<{ id, tier, operations? }>` and discovery stored it, but no
 * capability answer echoed it, so a dispatcher (light-dispatch) could not know what kind of resolver it ran and
 * stamped every task "deterministic" (gap resolvers-do-not-declare-their-tier-in-registration-so-tier-is-inferred-
 * from-a-name-list; 213 of 12,527 light-dispatched tasks in 24 h were an LLM resolver stamped deterministic).
 * Driven through the real /register -> /resolve routes, the consumer's own call.
 * MUST-FAIL on the parent (4205bce): no row carries resolver_tier.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Hono } from "hono"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import type { VesselCapabilityResult } from "../src/types"

const H = { "Content-Type": "application/json", Authorization: "ApiKey test-key" }
let app: Hono

async function register(body: Record<string, unknown>): Promise<void> {
  const r = await app.request("/register", { method: "POST", headers: H, body: JSON.stringify({ version: "1.0.0", ...body }) })
  expect(r.status).toBe(201)
}
async function rows(shape: string): Promise<VesselCapabilityResult["vessels"]> {
  const r = await app.request("/resolve", { method: "POST", headers: H, body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }) })
  expect(r.status).toBe(200)
  return ((await r.json()) as { content: VesselCapabilityResult }).content.vessels
}

describe("the capability row carries the tier the vessel declared for that shape", () => {
  beforeEach(() => {
    setIdentityValidator(async () => ({ orgId: "test-org", userId: "u", keyId: "k", scopes: ["read", "write"] }))
    app = createServer()
    registry.list().forEach((v) => registry.unregister(v.vesselId))
  })
  afterEach(() => {
    setIdentityValidator(null)
    registry.list().forEach((v) => registry.unregister(v.vesselId))
  })

  test("[MUST-FAIL] a declared llm resolver's row says llm; a declared deterministic one says deterministic", async () => {
    await register({
      vesselId: "tier-v1", vesselName: "tier-v1", endpoint: "http://tier-v1.test:9001",
      shapes: ["tierLlmShape", "tierDetShape"],
      resolvers: [{ id: "tierLlmShape", tier: "llm" }, { id: "tierDetShape", tier: "deterministic" }],
    })
    expect((await rows("tierLlmShape"))[0]?.resolver_tier).toBe("llm")
    expect((await rows("tierDetShape"))[0]?.resolver_tier).toBe("deterministic")
  })

  test("[MUST-FAIL] a resolver entry that lists the shape in `operations` declares it too", async () => {
    await register({
      vesselId: "tier-v2", vesselName: "tier-v2", endpoint: "http://tier-v2.test:9002",
      shapes: ["tierOpShape"], resolvers: [{ id: "some-resolver", tier: "pattern", operations: ["tierOpShape"] }],
    })
    expect((await rows("tierOpShape"))[0]?.resolver_tier).toBe("pattern")
  })

  test("[CONTROL] undeclared, or an unknown tier value, is ABSENT (never guessed)", async () => {
    await register({
      vesselId: "tier-v3", vesselName: "tier-v3", endpoint: "http://tier-v3.test:9003",
      shapes: ["tierNoDecl", "tierBadDecl"], resolvers: [{ id: "tierBadDecl", tier: "quantum" }],
    })
    expect((await rows("tierNoDecl"))[0]).toBeDefined()
    expect((await rows("tierNoDecl"))[0]!.resolver_tier).toBeUndefined()
    expect((await rows("tierBadDecl"))[0]!.resolver_tier).toBeUndefined()
    await register({ vesselId: "tier-v4", vesselName: "tier-v4", endpoint: "http://tier-v4.test:9004", shapes: ["tierNoResolvers"] })
    expect((await rows("tierNoResolvers"))[0]!.resolver_tier).toBeUndefined()
  })

  test("[CONTROL] the declaration is per vessel: two producers of one shape each carry their own", async () => {
    await register({ vesselId: "tier-a", vesselName: "tier-a", endpoint: "http://tier-a.test:9005", shapes: ["tierShared"], resolvers: [{ id: "tierShared", tier: "llm" }] })
    await register({ vesselId: "tier-b", vesselName: "tier-b", endpoint: "http://tier-b.test:9006", shapes: ["tierShared"] })
    const byId = new Map((await rows("tierShared")).map((v) => [v.vesselId, v.resolver_tier]))
    expect(byId.get("tier-a")).toBe("llm")
    expect(byId.get("tier-b")).toBeUndefined()
  })
})
