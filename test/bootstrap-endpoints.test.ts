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

// The caller: through the TLS front (the front adds x-forwarded-for and x-forwarded-proto), or direct over http from an
// address that is not loopback (an installed cockpit at the host's published port arrives from the bridge gateway), or
// direct with no known address (an in-process request).
type Caller = "via-front" | "direct-published" | "direct-unknown"
async function bootstrap(caller: Caller = "direct-unknown"): Promise<Record<string, unknown>> {
  const env = caller === "direct-published" ? { requestIP: () => ({ address: "172.17.0.1" }) } : undefined
  const headers = caller === "via-front" ? { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https" } : undefined
  const res = await createServer().request("/bootstrap", { headers }, env)
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
  it("[MUST-FAIL] a caller through the TLS front is never pointed at a cleartext endpoint; a direct http caller is, as before (agf_stblkwnacdn1)", async () => {
    setEnv({ PUBLIC_IP: "203.0.113.10" })
    const front = await bootstrap("via-front")
    expect([front.identity_endpoint, front.discovery_endpoint, front.activity_endpoint]).toEqual(["", "", ""])
    // a caller that reached discovery directly over http, from the bridge gateway (an installed cockpit) or unknown, is
    // given the http endpoints as before: it already sends its key to this host over http (deployment)
    for (const caller of ["direct-published", "direct-unknown"] as const) {
      expect([caller, (await bootstrap(caller)).identity_endpoint]).toEqual([caller, "http://203.0.113.10:18101"])
    }
    // accepted on purpose: a remote caller that asks this discovery DIRECTLY over plain http (no front: the published
    // port on a public address) already sends its key here in clear; an http identity endpoint on the same host adds no
    // exposure. The finding's path was through the TLS front (the USER's attach --check against https://<hub>:8443).
    expect((await createServer().request("/bootstrap", { headers: { host: "203.0.113.10:18100" } }, { requestIP: () => ({ address: "198.51.100.7" }) })
      .then((r) => r.json()) as Record<string, unknown>).identity_endpoint).toBe("http://203.0.113.10:18101")
    // a front that sets only one of the two headers still counts as a front
    for (const headers of [{ "x-forwarded-for": "198.51.100.7" }, { "x-forwarded-proto": "https" }]) {
      const b = (await (await createServer().request("/bootstrap", { headers })).json()) as Record<string, unknown>
      expect([JSON.stringify(headers), b.identity_endpoint]).toEqual([JSON.stringify(headers), ""])
    }
    // an https front is offered to everyone
    setEnv({ PUBLIC_IP: "203.0.113.10", IDENTITY_PUBLIC_URL: "https://hub.example", DISCOVERY_PUBLIC_URL: "https://hub.example:8443" })
    const remote = await bootstrap("via-front")
    expect([remote.identity_endpoint, remote.discovery_endpoint, remote.activity_endpoint]).toEqual(["https://hub.example", "https://hub.example:8443", ""])
  })

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
