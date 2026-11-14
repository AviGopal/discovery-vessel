/**
 * A loopback public_endpoint for a container port the launch does not publish names a host port nothing answers on. A
 * peer re-homes it onto this node's host (stampPeerRow), and every node that asks gets a dead row for the vessel. The
 * published set is read from the launch manifest (its `ports:` entries' container ports), so a vessel on an
 * unpublished port gets no loopback public_endpoint, and a peer marks the row unreachable instead.
 */
import { describe, expect, it } from "bun:test"
import { stampPeerRow } from "../src/index"
import { derivePublicEndpoint, forgetPublishedPorts, parsePublishedPorts, publishedPorts } from "../src/resolvers"

const MANIFEST = [
  "services:",
  "  substrate:",
  "    image: x",
  "    ports:",
  '      - "${ACTIVITY_API_PUBLISH_IP:-${SUBSTRATE_PUBLISH_IP:+${SUBSTRATE_PUBLISH_IP}:}}${ACTIVITY_API_PUBLISH_IP:+:}${ACTIVITY_API_PORT:-${SUBSTRATE_PORT_PREFIX:-18}080}:8080"   # activity-api',
  '      - "18100:8100"',
  "      - 127.0.0.1:18310:8310/tcp",
  '      - "30333:30333" # relay',
  "    volumes:",
  '      - "work:9999"',
].join("\n")

describe("the launch's published container ports", () => {
  it("are each ports: entry's container port, in any form compose accepts, and nothing after the list", () => {
    expect([...parsePublishedPorts(MANIFEST)].sort((a, b) => a - b)).toEqual([8080, 8100, 8310, 30333])
  })
})

describe("a public_endpoint for an unpublished port", () => {
  const published = parsePublishedPorts(MANIFEST)

  it("[MUST-FAIL] is not derived for a loopback endpoint on a port the launch does not publish", () => {
    expect(derivePublicEndpoint("http://127.0.0.1:8510", undefined, published)).toBeUndefined()
  })

  it("[MUST-FAIL] is withheld when the vessel registered a loopback one itself", () => {
    expect(derivePublicEndpoint("http://127.0.0.1:8221", "http://127.0.0.1:18221", published)).toBeUndefined()
  })

  it("is derived as before for a published port, and a real host the vessel names is kept", () => {
    expect(derivePublicEndpoint("http://127.0.0.1:8080", undefined, published)).toBe("http://127.0.0.1:18080")
    expect(derivePublicEndpoint("http://127.0.0.1:8510", "http://hub.example:18510", published)).toBe("http://hub.example:18510")
  })

  it("is derived as before when the published set cannot be read", () => {
    expect(derivePublicEndpoint("http://127.0.0.1:8510", undefined, null)).toBe("http://127.0.0.1:18510")
  })

  it("[MUST-FAIL] reaches a peer as an unreachable row, not as a dead address on the peer's host", () => {
    const answered = { vesselId: "records-vessel", endpoint: "http://127.0.0.1:8510", public_endpoint: derivePublicEndpoint("http://127.0.0.1:8510", undefined, published) }
    const row = stampPeerRow(answered, "http://hub.example:18100")
    expect(row.endpoint_unreachable).toBe(true)
    expect(String(row.endpoint)).not.toContain("hub.example:18510")
  })
})

describe("whether the published set could be read", () => {
  it("[MUST-FAIL] is said once when it cannot be (nothing withheld), and again only when that changes", () => {
    const said: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")) }
    // Another file in the same run may have read (and cached) the set already; this test starts from nothing and
    // leaves nothing behind.
    forgetPublishedPorts()
    try {
      // The preload points the manifest at an absent file. Each call is past the cache, so each reads again.
      const t0 = Date.now()
      expect(publishedPorts(t0)).toBeNull()
      expect(publishedPorts(t0 + 120_000)).toBeNull()
      process.env.SUBSTRATE_PUBLISHED_PORTS = "8100 8310"
      expect([...publishedPorts(t0 + 240_000)!].sort()).toEqual([8100, 8310])
      expect(publishedPorts(t0 + 360_000)).not.toBeNull()
    } finally {
      delete process.env.SUBSTRATE_PUBLISHED_PORTS
      forgetPublishedPorts()
      console.log = log
    }
    const unreadable = said.filter((l) => l.startsWith("[discovery] published ports unreadable"))
    const read = said.filter((l) => l.startsWith("[discovery] published ports read"))
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toContain("absent.yml")
    expect(unreadable[0]).toContain("nothing withheld")
    expect(read).toHaveLength(1)
  })
})
