/**
 * Per-peer credentials.
 *
 * A node that peers with two substrates which sign keys differently cannot send
 * one credential to both: one of them rejects it. These tests plant two stub peer
 * discovery servers on 127.0.0.1 (ephemeral ports, nothing live), each accepting
 * ONLY its own key, and drive the REAL /resolve route through both forwarding
 * paths (vesselCapability fan-out and general-shape fleet resolution). They assert
 * on what each stub actually RECEIVED, not on what the code says it sends.
 *
 * Canary: every secret slot holds a value containing CANARY; no console line,
 * response body, or credential descriptor may contain it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Hono } from "hono"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import {
  __resetPeerCredentialState,
  normalizePeerKey,
  parsePeerCredentialMap,
  peerAuthorization,
  REJECTION_LOG_WINDOW_MS,
} from "../src/peer-credentials"

const CANARY = "CANARY-7d1f0c"
const KEY_A = `${CANARY}-peer-a-key`
const KEY_B = `${CANARY}-peer-b-key`
const HUB_KEY = `${CANARY}-hub-key`
const CALLER = "ApiKey caller-own-key"

interface StubPeer {
  url: string
  received: Array<string | null>
  stop: () => void
}

/** A peer discovery stub: 200 only for its own key, 401 otherwise. */
function plantPeer(name: string, ownKey: string, opts: { hasShape?: boolean } = {}): StubPeer {
  const received: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization")
      received.push(auth)
      if (auth !== `ApiKey ${ownKey}`) return Response.json({ error: "unauthorized" }, { status: 401 })
      const body = (await req.json()) as { pointer: { type: string } }
      if (body.pointer.type === "vesselCapability") {
        return Response.json({ content: { vessels: [{ vesselId: `vessel-on-${name}`, endpoint: `http://10.9.9.${name === "a" ? 1 : 2}:9000` }] } })
      }
      if (opts.hasShape === false) return Response.json({ error: "Not found" }, { status: 404 })
      return Response.json({ content: { servedBy: name } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) }
}

const ENV_NAMES = ["PEER_DISCOVERY_ENDPOINTS", "PEER_CREDENTIALS", "HUB_API_KEY", "PEER_A_KEY", "PEER_B_KEY"] as const
const savedEnv: Record<string, string | undefined> = {}
for (const n of ENV_NAMES) savedEnv[n] = process.env[n]

// Capture every console line so the canary can be checked against all of them.
const lines: string[] = []
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }
function captureConsole() {
  for (const k of Object.keys(original) as Array<keyof typeof original>) {
    console[k] = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ")) }
  }
}
function restoreConsole() {
  for (const k of Object.keys(original) as Array<keyof typeof original>) console[k] = original[k]
}
const warnLines = () => lines.filter((l) => l.startsWith("[discovery]"))

let app: Hono
let peers: StubPeer[] = []
const bodies: string[] = []

async function resolveVia(pointer: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: CALLER },
    body: JSON.stringify({ pointer }),
  })
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, body: JSON.parse(text) }
}
const capability = () => resolveVia({ type: "vesselCapability", shape: "peerOnlyShape" })
const general = () => resolveVia({ type: "somePeerServedShape" })

beforeEach(() => {
  for (const n of ENV_NAMES) delete process.env[n]
  __resetPeerCredentialState()
  setIdentityValidator(async () => ({ orgId: "org-test", userId: "u", keyId: "k", scopes: ["read", "write"] }))
  for (const v of registry.list()) registry.unregister(v.vesselId)
  app = createServer()
  lines.length = 0
  captureConsole()
})

afterEach(() => {
  restoreConsole()
  allLines.push(...lines)
  for (const p of peers) p.stop()
  peers = []
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n]
    else process.env[n] = savedEnv[n]
  }
  setIdentityValidator(null)
  registry.stop()
  __resetPeerCredentialState()
})

// Lines from every test, kept for the final canary check (lines is reset per test).
const allLines: string[] = []
afterAll(() => restoreConsole())

function twoMappedPeers(opts: { aHasShape?: boolean } = {}) {
  const a = plantPeer("a", KEY_A, { hasShape: opts.aHasShape })
  const b = plantPeer("b", KEY_B)
  peers.push(a, b)
  process.env.PEER_DISCOVERY_ENDPOINTS = `${a.url},${b.url}/`
  // Map keys deliberately written differently from the peer list (trailing path).
  process.env.PEER_CREDENTIALS = `${a.url}/=PEER_A_KEY, ${b.url}/resolve=PEER_B_KEY`
  process.env.PEER_A_KEY = KEY_A
  process.env.PEER_B_KEY = KEY_B
  return { a, b }
}

describe("two peers, each accepting only its own key", () => {
  it("capability fan-out: both peers answer 200 and each receives only its mapped key", async () => {
    const { a, b } = twoMappedPeers()
    const { status, body } = await capability()
    expect(status).toBe(200)
    const ids = (body.content.vessels as Array<{ vesselId: string }>).map((v) => v.vesselId).sort()
    expect(ids).toEqual(["vessel-on-a", "vessel-on-b"]) // both peers answered 200
    expect(a.received).toEqual([`ApiKey ${KEY_A}`])
    expect(b.received).toEqual([`ApiKey ${KEY_B}`])
    // wrong-peer: A's key never reaches B and vice versa
    expect(b.received.join("|")).not.toContain(KEY_A)
    expect(a.received.join("|")).not.toContain(KEY_B)
    expect(warnLines()).toEqual([]) // no rejection was logged
  })

  it("general-shape fleet resolution: each peer receives only its mapped key", async () => {
    const { a, b } = twoMappedPeers({ aHasShape: false })
    const { status, body } = await general()
    expect(status).toBe(200)
    expect(body.content.servedBy).toBe("b")
    expect(a.received).toEqual([`ApiKey ${KEY_A}`])
    expect(b.received).toEqual([`ApiKey ${KEY_B}`])
  })

  it("a mapped key wins over HUB_API_KEY and over the caller header", async () => {
    const { a, b } = twoMappedPeers()
    process.env.HUB_API_KEY = HUB_KEY
    await capability()
    expect(a.received).toEqual([`ApiKey ${KEY_A}`])
    expect(b.received).toEqual([`ApiKey ${KEY_B}`])
  })
})

describe("no mapping: behaviour identical to before", () => {
  it("HUB_API_KEY set → every peer receives it (both forwarding paths)", async () => {
    const a = plantPeer("a", HUB_KEY)
    const b = plantPeer("b", HUB_KEY)
    peers.push(a, b)
    process.env.PEER_DISCOVERY_ENDPOINTS = `${a.url},${b.url}`
    process.env.HUB_API_KEY = HUB_KEY
    await capability()
    await general()
    expect(a.received).toEqual([`ApiKey ${HUB_KEY}`, `ApiKey ${HUB_KEY}`])
    expect(b.received).toEqual([`ApiKey ${HUB_KEY}`])
  })

  it("HUB_API_KEY unset → every peer receives the caller's own header", async () => {
    const a = plantPeer("a", "caller-own-key")
    const b = plantPeer("b", "caller-own-key")
    peers.push(a, b)
    process.env.PEER_DISCOVERY_ENDPOINTS = `${a.url},${b.url}`
    await capability()
    expect(a.received).toEqual([CALLER])
    expect(b.received).toEqual([CALLER])
  })

  it("an unmapped peer keeps the fallback while a mapped sibling uses its own key", async () => {
    const a = plantPeer("a", KEY_A)
    const b = plantPeer("b", "caller-own-key")
    peers.push(a, b)
    process.env.PEER_DISCOVERY_ENDPOINTS = `${a.url},${b.url}`
    process.env.PEER_CREDENTIALS = `${a.url}=PEER_A_KEY`
    process.env.PEER_A_KEY = KEY_A
    await capability()
    expect(a.received).toEqual([`ApiKey ${KEY_A}`])
    expect(b.received).toEqual([CALLER])
  })
})

describe("mapped peer whose env var is missing: fail closed", () => {
  it("that peer is never contacted, no default key is sent anywhere, one log line", async () => {
    const a = plantPeer("a", KEY_A)
    const b = plantPeer("b", KEY_B)
    peers.push(a, b)
    process.env.PEER_DISCOVERY_ENDPOINTS = `${a.url},${b.url}`
    process.env.PEER_CREDENTIALS = `${a.url}=PEER_A_KEY,${b.url}=PEER_B_KEY`
    process.env.PEER_A_KEY = KEY_A
    // PEER_B_KEY deliberately unset; a default exists that MUST NOT be used for b
    process.env.HUB_API_KEY = HUB_KEY
    await capability()
    await capability()
    await general()
    expect(b.received).toEqual([]) // zero requests: not the hub key, not the caller header
    expect(a.received.every((h) => h === `ApiKey ${KEY_A}`)).toBe(true)
    expect(a.received.length).toBe(3)
    const missing = warnLines().filter((l) => l.includes("PEER_B_KEY"))
    expect(missing.length).toBe(1)
    expect(missing[0]).toContain("unset or empty")
    expect(missing[0]).toContain(normalizePeerKey(b.url)!)
  })

  it("an empty value and an invalid var name also fail closed", () => {
    const env = { PEER_CREDENTIALS: `http://p:1=EMPTY_KEY,http://q:2=${KEY_A}`, EMPTY_KEY: "   ", HUB_API_KEY: HUB_KEY }
    const p = peerAuthorization("http://p:1", CALLER, env)
    const q = peerAuthorization("http://q:2", CALLER, env)
    expect(p.ok).toBe(false)
    expect(q.ok).toBe(false)
    // the invalid "name" was a pasted key: it must not be echoed anywhere
    expect(JSON.stringify([p, q])).not.toContain(CANARY)
  })
})

describe("endpoint normalisation", () => {
  it("trailing slashes, paths and case name the same peer; scheme and port do not", () => {
    const k = normalizePeerKey("http://Syzygy.Host:18100")
    expect(k).toBe("http://syzygy.host:18100")
    expect(normalizePeerKey("http://syzygy.host:18100/")).toBe(k!)
    expect(normalizePeerKey("HTTP://SYZYGY.HOST:18100/resolve")).toBe(k!)
    expect(normalizePeerKey("  http://syzygy.host:18100//  ")).toBe(k!)
    expect(normalizePeerKey("https://syzygy.host:18100")).not.toBe(k!)
    expect(normalizePeerKey("http://syzygy.host:18101")).not.toBe(k!)
    expect(normalizePeerKey("http://h:80")).toBe("http://h")
  })

  it("scheme-less or non-http entries are malformed, logged once without echoing them", () => {
    expect(normalizePeerKey("syzygy.host:18100")).toBeUndefined()
    expect(normalizePeerKey("ftp://h:1")).toBeUndefined()
    const m = parsePeerCredentialMap(`syzygy.host:18100=X, ${KEY_A}, http://ok:1=OK_KEY`)
    expect([...m.byPeer.entries()]).toEqual([["http://ok:1", "OK_KEY"]])
    expect(m.malformed.length).toBe(2)
    peerAuthorization("http://ok:1", undefined, { PEER_CREDENTIALS: `syzygy.host:18100=X, ${KEY_A}` })
    peerAuthorization("http://ok:1", undefined, { PEER_CREDENTIALS: `syzygy.host:18100=X, ${KEY_A}` })
    expect(warnLines().filter((l) => l.includes("malformed")).length).toBe(2)
    expect(warnLines().join("\n")).not.toContain("syzygy.host")
  })

  it("an unparseable map entry leaves the peer on today's fallback", () => {
    const r = peerAuthorization("http://syzygy.host:18100", CALLER, { PEER_CREDENTIALS: "syzygy.host:18100=SYZ", HUB_API_KEY: HUB_KEY })
    expect(r).toMatchObject({ ok: true, source: "HUB_API_KEY" })
  })
})

describe("redirects are refused", () => {
  it("a mapped peer answering 307 to another host is a peer failure; the target receives nothing", async () => {
    const b = plantPeer("b", KEY_A) // would even ACCEPT A's key if it ever arrived
    const redirecting = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 307, headers: { Location: `${b.url}/resolve` } }),
    })
    const aUrl = `http://127.0.0.1:${redirecting.port}`
    peers.push(b, { url: aUrl, received: [], stop: () => redirecting.stop(true) })
    process.env.PEER_DISCOVERY_ENDPOINTS = aUrl
    process.env.PEER_CREDENTIALS = `${aUrl}=PEER_A_KEY`
    process.env.PEER_A_KEY = KEY_A

    // Spy on fetch to pin the request option itself, independent of what this
    // runtime would do with a followed redirect.
    const realFetch = globalThis.fetch
    const peerInits: RequestInit[] = []
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (String(input).startsWith(aUrl)) peerInits.push(init ?? {})
      return realFetch(input, init)
    }) as typeof fetch
    let cap: { status: number; body: any }, gen: { status: number; body: any }
    try {
      cap = await capability()
      gen = await general()
    } finally {
      globalThis.fetch = realFetch
    }
    expect(b.received).toEqual([]) // zero requests reached the redirect target
    expect(cap.status).toBe(200)
    expect(cap.body.content.vessels ?? []).toEqual([]) // A contributed nothing
    expect(gen.status).toBe(404) // fleet resolution: A failed, nobody else served it
    expect(peerInits.length).toBe(2)
    for (const init of peerInits) expect(init.redirect).toBe("error")
  })
})

describe("rejection visibility", () => {
  it("a 401 logs one line per peer per window, naming the source but never the value", async () => {
    let t = 1_000_000
    __resetPeerCredentialState(() => t)
    const a = plantPeer("a", "some-other-key") // rejects what we send
    peers.push(a)
    process.env.PEER_DISCOVERY_ENDPOINTS = a.url
    process.env.PEER_CREDENTIALS = `${a.url}=PEER_A_KEY`
    process.env.PEER_A_KEY = KEY_A
    await capability()
    await capability()
    let rejected = warnLines().filter((l) => l.includes("rejected"))
    expect(rejected).toEqual([`[discovery] peer ${normalizePeerKey(a.url)} rejected our credential (HTTP 401, credential source: map:PEER_A_KEY)`])
    t += REJECTION_LOG_WINDOW_MS + 1
    await capability()
    rejected = warnLines().filter((l) => l.includes("rejected"))
    expect(rejected.length).toBe(2)
    expect(a.received.length).toBe(3)
  })
})

describe("every peer forwarding site goes through postToPeer", () => {
  const srcDir = join(import.meta.dir, "..", "src")
  const files = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, text: readFileSync(join(srcDir, f), "utf8") }))

  it("only peer-credentials.ts builds a peer request (sets X-Discovery-Depth / posts to a peer)", () => {
    const setters = files.filter(({ text }) => /["']X-Discovery-Depth["']\s*:/.test(text)).map(({ f }) => f)
    expect(setters).toEqual(["peer-credentials.ts"])
    const peerFetches = files.filter(({ text }) => /fetch\(\s*`\$\{[^}]*peer/i.test(text)).map(({ f }) => f)
    expect(peerFetches).toEqual(["peer-credentials.ts"])
  })

  it("each consumer of the peer list sends through postToPeer", () => {
    const index = files.find(({ f }) => f === "index.ts")!.text
    const peerListUses = (index.match(/currentPeerEndpoints\(\)/g) ?? []).length - 1 // minus the definition
    const sends = (index.match(/postToPeer\(\{/g) ?? []).length
    expect(peerListUses).toBe(2)
    expect(sends).toBe(peerListUses)
    expect(index).not.toMatch(/peerAuthHeader|HUB_API_KEY\}/)
  })
})

describe("canary", () => {
  // Runs last in this file: every console line and response body produced by the
  // tests above (which put CANARY in every secret slot) must be free of it.
  it("no secret value appears in any log line or response body", () => {
    expect(allLines.length).toBeGreaterThan(0)
    expect(bodies.length).toBeGreaterThan(5)
    for (const text of [...allLines, ...bodies]) expect(text).not.toContain(CANARY)
  })
})
