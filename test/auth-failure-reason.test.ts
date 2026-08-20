/**
 * A 401 must say WHY.
 *
 * Discovery sits on every vessel's register/heartbeat path, so its 401s are the
 * fleet's most-produced error, and the registry TTL is 5 minutes — a sustained
 * 401 silently empties the registry. Measured 2026-08-19 on the UI spoke: 169
 * register/heartbeat 401s over 37 minutes, with no reason recorded anywhere.
 * The key was valid the entire time; identity had been unreachable past the
 * grace window. Nothing in the logs could distinguish that from a revocation,
 * so the whole outage was spent suspecting the credential.
 *
 * These tests drive the REAL validator against a stub identity server and
 * assert on the reason it reports — not on a value the test itself supplied.
 * `IDENTITY_VESSEL_URL` is read at module load, so the stub is started and the
 * env pointed at it BEFORE the dynamic import below.
 */

import { describe, expect, it } from "bun:test"
import { Hono } from "hono"

/** Whatever the stub should answer next; reassigned per test. */
let identityHandler: (req: Request) => Promise<Response> | Response

const identity = Bun.serve({
  port: 0,
  fetch: (req) => identityHandler(req)
})

process.env.IDENTITY_VESSEL_URL = `http://127.0.0.1:${identity.port}`

// Imported AFTER the env is pointed at the stub — the module captures the URL
// in a module-level const at load time.
const { authMiddleware, lastValidationFailure, lastValidationFailureDetail } =
  await import("../src/middleware/auth.js")

/** A minimal app carrying the middleware exactly as the vessel mounts it. */
const app = new Hono()
app.use("*", authMiddleware)
app.post("/register", (c) => c.json({ ok: true }))

/** One authenticated attempt through the middleware. */
function attempt(key: string): Promise<Response> {
  return app.request("/register", {
    method: "POST",
    headers: { Authorization: `ApiKey ${key}`, "Content-Type": "application/json" },
    body: "{}"
  })
}

const authenticated = (): Response =>
  new Response(
    JSON.stringify({
      success: true,
      data: {
        authenticated: true,
        orgId: "organizations:test",
        userId: "users:test",
        keyId: "key_test",
        scopes: ["read", "write"]
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )

/** A distinct key per test: the validator caches by key. */
let n = 0
const freshKey = (): string => `mb-test-key-${++n}`

describe("401 carries the reason", () => {
  it("says 'rejected' when identity answers and denies the key", async () => {
    identityHandler = () =>
      new Response(JSON.stringify({ success: true, data: { authenticated: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })

    const res = await attempt(freshKey())
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { reason: string; detail: string } }
    expect(body.error.reason).toBe("rejected")
    expect(lastValidationFailure()).toBe("rejected")
    expect(lastValidationFailureDetail()).toContain("rejected")
  })

  it(
    "says 'identity_unreachable' when identity does not answer in time",
    async () => {
      // A stub that THROWS is not an unreachable identity — Bun turns it into
      // a 500, which is the `identity_http_error` branch. That mistake made an
      // earlier version of this test pass against the wrong code path. The
      // honest simulation of "unreachable" is silence until the validator's
      // own 10s AbortSignal.timeout fires, which is the `catch` branch.
      identityHandler = async () => {
        await Bun.sleep(20_000)
        return new Response("too late")
      }

      const res = await attempt(freshKey())
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: { reason: string } }
      // ★ THE POINT: this must NOT be "rejected". A network fault and a revoked
      // credential demand opposite responses, and collapsing them is the defect.
      expect(body.error.reason).toBe("identity_unreachable")
      expect(body.error.reason).not.toBe("rejected")
    },
    20_000
  )

  it("says 'identity_http_error' with the status when identity 5xxes", async () => {
    identityHandler = () => new Response("boom", { status: 503 })

    const res = await attempt(freshKey())
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { reason: string; detail: string } }
    expect(body.error.reason).toBe("identity_http_error")
    expect(body.error.detail).toContain("503")
  })

  it("serves a known-good key from grace while identity 5xxes", async () => {
    const key = freshKey()
    identityHandler = authenticated
    expect((await attempt(key)).status).toBe(200)

    // Identity now faulting. The cached validation is inside the grace window,
    // so the fleet keeps working rather than churning the registry.
    identityHandler = () => new Response("boom", { status: 500 })
    expect((await attempt(key)).status).toBe(200)
  })

  it("★ a 4xx revocation is not served from the 10-minute grace window", async () => {
    // WHAT THIS DOES NOT CLAIM: that revocation takes effect instantly. The
    // validator's 60s TTL cache is consulted BEFORE identity, so a revoked key
    // keeps working for up to `VALIDATION_TTL_MS` no matter what this branch
    // does. That is pre-existing and deliberately bounded — the danger is the
    // 600s GRACE window, ten times longer, which `!res.ok` would have extended
    // a revocation into. This test pins the grace boundary, not the TTL.
    //
    // Distinct keys, because a warm TTL entry would mask the branch entirely
    // (an earlier version of this test asserted 401 and got 200 for exactly
    // that reason).
    const revoked = freshKey()

    // Warm nothing: the key's first contact with identity IS the revocation.
    identityHandler = () => new Response(JSON.stringify({ success: false }), { status: 401 })
    expect((await attempt(revoked)).status).toBe(401)

    // Identity now goes dark. A 4xx must have left NO cache entry behind, so
    // there is nothing for the grace window to serve and the key stays out.
    identityHandler = async () => {
      await Bun.sleep(20_000)
      return new Response("too late")
    }
    const after = await attempt(revoked)
    expect(after.status).toBe(401)
    const body = (await after.json()) as { error: { reason: string } }
    expect(body.error.reason).toBe("identity_unreachable")
  }, 30_000)
})
