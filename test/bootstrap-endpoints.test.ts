/**
 * GET /bootstrap advertises every endpoint a joiner needs from one anchor: identity, discovery and the trace store.
 *
 * A joiner used to derive the trace store from the discovery port by a fixed offset. Behind a TLS front
 * (https://hub:8443) there is no arithmetic sibling, so a token join only worked on the plain-HTTP 18xxx block.
 * /bootstrap now carries activity_endpoint with the same precedence as the other two: an explicit public URL,
 * then PUBLIC_IP with the published port, else empty.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { createServer } from "../src/index.js"

const KEYS = [
  "PUBLIC_IP", "FED_PUBLIC_IP",
  "ACTIVITY_PUBLIC_URL", "ACTIVITY_PUBLIC_PORT",
  "IDENTITY_PUBLIC_URL", "IDENTITY_PUBLIC_PORT",
  "DISCOVERY_PUBLIC_URL", "DISCOVERY_PUBLIC_PORT",
  "IDENTITY_VESSEL_URL", "RELAY_MULTIADDR",
] as const
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k]
  // A configured relay keeps /bootstrap from reading the host's env file.
  process.env.RELAY_MULTIADDR = "/ip4/203.0.113.9/tcp/30333/p2p/relay"
  for (const [k, v] of Object.entries(env)) process.env[k] = v
}

async function bootstrap(): Promise<Record<string, unknown>> {
  const res = await createServer().request("/bootstrap")
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("GET /bootstrap", () => {
  it("advertises the trace store from an explicit public URL (a TLS front)", async () => {
    setEnv({
      PUBLIC_IP: "203.0.113.10",
      ACTIVITY_PUBLIC_URL: "https://hub.example:9443",
      IDENTITY_PUBLIC_URL: "https://hub.example",
      DISCOVERY_PUBLIC_URL: "https://hub.example:8443",
    })
    const b = await bootstrap()
    expect(b.activity_endpoint).toBe("https://hub.example:9443")
    expect(b.identity_endpoint).toBe("https://hub.example")
    expect(b.discovery_endpoint).toBe("https://hub.example:8443")
  })

  it("derives the trace store from PUBLIC_IP and the published port when no URL is set", async () => {
    setEnv({ PUBLIC_IP: "203.0.113.10" })
    const b = await bootstrap()
    expect(b.activity_endpoint).toBe("http://203.0.113.10:18080")
    expect(b.identity_endpoint).toBe("http://203.0.113.10:18101")
    expect(b.discovery_endpoint).toBe("http://203.0.113.10:18100")
  })

  it("honours a non-default published port", async () => {
    setEnv({ PUBLIC_IP: "203.0.113.10", ACTIVITY_PUBLIC_PORT: "24080" })
    expect((await bootstrap()).activity_endpoint).toBe("http://203.0.113.10:24080")
  })

  it("advertises an empty trace store when the fleet has no public address", async () => {
    setEnv({})
    expect((await bootstrap()).activity_endpoint).toBe("")
  })
})
