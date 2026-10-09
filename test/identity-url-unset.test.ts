/**
 * The identity endpoint comes from configuration only.
 *
 * API-key validation posts the presented key to identity and trusts the
 * answer, so the destination of that request is part of the trust boundary.
 * When IDENTITY_VESSEL_URL is unset or empty there is no configured identity,
 * and validation must fail closed (reason `identity_unreachable`) without any
 * outbound request. When it is configured, behaviour is unchanged.
 *
 * `fetch` is replaced by a recorder for every test, so nothing here touches
 * the network. The recorder answers "authenticated" for the valid key wherever
 * the request goes — a validator that called out anyway would be caught both
 * by the recorded URL and by the key being accepted.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { authMiddleware, getAuthContext, setIdentityValidator } from "../src/middleware/auth.js"

const CONFIGURED = "http://127.0.0.1:9"
const VALID_PREFIX = "mb-valid-"

interface Recorded {
  url: string
  apiKey: string | undefined
}

let calls: Recorded[] = []
const realFetch = globalThis.fetch
const savedEnv = process.env.IDENTITY_VESSEL_URL

const recorder = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  let apiKey: string | undefined
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      impulse?: { pointer?: { apiKey?: string } }
    }
    apiKey = body.impulse?.pointer?.apiKey
  } catch {
    apiKey = undefined
  }
  calls.push({ url, apiKey })
  const ok = typeof apiKey === "string" && apiKey.startsWith(VALID_PREFIX)
  const payload = ok
    ? {
        success: true,
        data: {
          authenticated: true,
          orgId: "organizations:test",
          userId: "users:test",
          keyId: "key_test",
          scopes: ["read", "write"]
        }
      }
    : { success: true, data: { authenticated: false } }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })
}) as typeof fetch

const app = new Hono()
app.use("*", authMiddleware)
app.post("/register", (c) => c.json({ auth: getAuthContext(c) }))

function attempt(key: string): Promise<Response> {
  return app.request("/register", {
    method: "POST",
    headers: { Authorization: `ApiKey ${key}`, "Content-Type": "application/json" },
    body: "{}"
  })
}

/** A distinct key per test: the validator caches by key. */
let n = 0
const validKey = (): string => `${VALID_PREFIX}${Date.now()}-${++n}`
const invalidKey = (): string => `mb-invalid-${Date.now()}-${++n}`

beforeEach(() => {
  calls = []
  setIdentityValidator(null)
  globalThis.fetch = recorder
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedEnv === undefined) delete process.env.IDENTITY_VESSEL_URL
  else process.env.IDENTITY_VESSEL_URL = savedEnv
})

describe("identity endpoint not configured", () => {
  it("unset: makes no outbound request and refuses the key", async () => {
    delete process.env.IDENTITY_VESSEL_URL

    const res = await attempt(validKey())

    expect(calls.map((c) => c.url)).toEqual([])
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { reason: string } }
    expect(body.error.reason).toBe("identity_unreachable")
  })

  it("empty string: makes no outbound request and refuses the key", async () => {
    process.env.IDENTITY_VESSEL_URL = ""

    const res = await attempt(validKey())

    expect(calls.map((c) => c.url)).toEqual([])
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { reason: string } }
    expect(body.error.reason).toBe("identity_unreachable")
  })
})

describe("identity endpoint configured (control)", () => {
  it("accepts a valid key and sets the resolved context, calling only the configured host", async () => {
    process.env.IDENTITY_VESSEL_URL = CONFIGURED
    const key = validKey()

    const res = await attempt(key)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { auth: unknown }
    expect(body.auth).toEqual({
      orgId: "organizations:test",
      userId: "users:test",
      keyId: "key_test",
      scopes: ["read", "write"]
    })
    expect(calls).toEqual([{ url: `${CONFIGURED}/v1/auth/resolve`, apiKey: key }])
  })

  it("refuses an invalid key", async () => {
    process.env.IDENTITY_VESSEL_URL = CONFIGURED

    const res = await attempt(invalidKey())

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { reason: string } }
    expect(body.error.reason).toBe("rejected")
    expect(calls.every((c) => c.url.startsWith(`${CONFIGURED}/`))).toBe(true)
    expect(calls.length).toBe(1)
  })
})
