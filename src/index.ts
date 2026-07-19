/**
 * Discovery Vessel Server
 *
 * HTTP server that implements impulse resolution for discovery types.
 * Vessels register themselves and query for capabilities.
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import { registry, HEARTBEAT_INTERVAL_MS } from "./registry"
import { resolve, getResolvableShapes } from "./resolvers"
import { metricsRegistry } from "./metrics"
import { authMiddleware, getAuthContext, getAuthContextOptional } from "./middleware/auth"
import type {
  DiscoveryPointer,
  ResolveRequest,
  ResolveResponse,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HealthResponse
} from "./types"

const VERSION = "0.1.0"
const startTime = Date.now()

// Peer-aware resolution (2026-06-25, SUBSTRATE_AS_NETWORK.md §9 — the fleet
// control plane forwarding the cross-container recall of FLEET.md §4). When a
// vesselCapability query finds NO local producer, forward it to configured peer
// discovery instances, merge their vessels tagged discoveredVia:"peer". This is
// the seam that turns single-substrate discovery into fleet discovery: a shape is
// reachable across the boundary by the same capability-addressed query, so vessel
// location stops mattering across substrates (location-transparency, extended).
//
// SAFE BY DEFAULT: PEER_DISCOVERY_ENDPOINTS empty → no forwarding → behaviour
// byte-identical to before (a true no-op cutover). The X-Discovery-Depth header is
// a strict hop limit so peer→peer→peer can't loop or fan out unbounded (MAX_PEER_DEPTH).
const PEER_DISCOVERY_ENDPOINTS = (process.env.PEER_DISCOVERY_ENDPOINTS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean)
const MAX_PEER_DEPTH = parseInt(process.env.MAX_PEER_DEPTH ?? "1", 10)
const PEER_FANOUT_MODE = (process.env.PEER_FANOUT_MODE ?? "fallback").toLowerCase()

async function forwardToPeers(
  pointer: DiscoveryPointer,
  depth: number,
  authHeader: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (PEER_DISCOVERY_ENDPOINTS.length === 0 || depth >= MAX_PEER_DEPTH) return []
  const merged: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  await Promise.all(PEER_DISCOVERY_ENDPOINTS.map(async (peer) => {
    try {
      const res = await fetch(`${peer.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Increment the hop count so a forwarded query can't recurse past MAX_PEER_DEPTH.
          "X-Discovery-Depth": String(depth + 1),
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({ pointer }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return
      const data = (await res.json()) as { content?: { vessels?: Array<Record<string, unknown>> } }
      for (const v of data.content?.vessels ?? []) {
        const id = String(v.vesselId ?? "")
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        // Tag provenance so callers (and learning) can distinguish a local producer
        // from a peer-resolved one — the discoveredVia:"peer" enum already exists in types.
        merged.push({ ...v, discoveredVia: "peer", peerEndpoint: peer })
      }
    } catch { /* peer unreachable / timed out — skip it; the local result stands */ }
  }))
  return merged
}

export function createServer() {
  const app = new Hono()

  // Middleware
  app.use("*", cors())
  app.use("*", logger())
  app.use("*", authMiddleware)

  // Health check
  app.get("/health", (c) => {
    const stats = registry.getStats()
    const response: HealthResponse = {
      status: "ok",
      vessel: "discovery",
      version: VERSION,
      registeredVessels: stats.totalVessels,
      uptime: Math.floor((Date.now() - startTime) / 1000)
    }
    return c.json(response)
  })

  // Bootstrap: the ONE public read a client needs to "just point and go".
  // A vessel/client pointed at this discovery (plus an API key for everything
  // else it does) reads the relay anchor + identity authority here, then dials
  // the p2p overlay — no out-of-band RELAY_MULTIADDR env, no stale-peerId drift
  // (law 1: the relay is a value read at use time, not frozen at bootstrap).
  // Public (pre-auth) so a fresh client can reach it before it holds a key.
  app.get("/bootstrap", (c) => {
    const relayEnv = (process.env.RELAY_MULTIADDR ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean)
    // Fallback: derive the relay anchor from any registered circuit multiaddr
    // (/…/p2p/<relay>/p2p-circuit/p2p/<vessel>) so bootstrap works even if this
    // process was not handed RELAY_MULTIADDR directly.
    const relayFromCircuits = relayEnv.length ? [] : Array.from(new Set(
      registry.list()
        .flatMap((v) => v.libp2p_multiaddr ?? [])
        .map((ma) => { const i = ma.indexOf("/p2p-circuit"); return i > 0 ? ma.slice(0, i) : ""; })
        .filter(Boolean)
    ))
    const relay_multiaddrs = relayEnv.length ? relayEnv : relayFromCircuits
    const publicIp = process.env.PUBLIC_IP ?? process.env.FED_PUBLIC_IP ?? ""
    const identity_endpoint =
      process.env.IDENTITY_PUBLIC_URL ??
      (publicIp ? `http://${publicIp}:${process.env.IDENTITY_PUBLIC_PORT ?? "18101"}` : undefined) ??
      process.env.IDENTITY_VESSEL_URL ??
      ""
    const discovery_endpoint =
      process.env.DISCOVERY_PUBLIC_URL ??
      (publicIp ? `http://${publicIp}:${process.env.DISCOVERY_PUBLIC_PORT ?? "18100"}` : undefined) ??
      ""
    return c.json({
      relay_multiaddrs,
      identity_endpoint,
      discovery_endpoint,
      // A client SHOULD reserve a circuit on the relay and dial vessels via their
      // libp2p_multiaddr, falling back to direct HTTP only when no circuit exists.
      prefer_transport: "libp2p",
    })
  })

  // Resolve discovery impulses
  app.post("/resolve", async (c) => {
    try {
      const body = await c.req.json<ResolveRequest>()
      const pointer = (body.pointer) as ResolveRequest["pointer"]

      if (!pointer || !pointer.type) {
        return c.json({ error: "Missing pointer or pointer.type" }, 400)
      }

      const DISCOVERY_SHAPES = ["vesselCapability", "vesselEndpoint", "vesselHealth", "vesselRegistry"]
      if (!DISCOVERY_SHAPES.includes(pointer.type)) {
        const auth = getAuthContextOptional(c)
        const candidates = registry.findByShape(pointer.type, auth?.orgId ? { orgId: auth.orgId } : undefined).filter((v) => v.status === "healthy")
        if (candidates.length === 0) {
          return c.json({ error: "Not found", shape: pointer.type }, 404)
        }
        const target = candidates[0]!
        const endpoint = target.endpoint
        const resolveEndpoint = target.resolve_endpoint ?? "/v2/impulses/resolve"
        const timeoutMs = target.resolve_timeout_ms ?? 10000
        const forwardUrl = /^https?:\/\//.test(resolveEndpoint) ? resolveEndpoint : `${endpoint}${resolveEndpoint}`
        try {
          const fwd = await fetch(forwardUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(c.req.header("Authorization") ? { Authorization: c.req.header("Authorization")! } : {}),
            },
            body: JSON.stringify({ impulse: { pointer } }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          const fwdBody = await fwd.json()
          return c.json(fwdBody, fwd.status as 200)
        } catch (err) {
          return c.json({ error: "forward_failed", shape: pointer.type, detail: (err as Error).message }, 502)
        }
      }

      const content = await resolve(pointer as DiscoveryPointer)

      // Fleet-resolution: a capability query with no LOCAL producer is forwarded to
      // peer discovery instances (depth-limited). No-op unless PEER_DISCOVERY_ENDPOINTS
      // is set, so single-substrate behaviour is unchanged.
      if (pointer.type === "vesselCapability") {
        const cap = content as { vessels?: Array<Record<string, unknown>>; found?: boolean }
        if (!cap.vessels || cap.vessels.length === 0 || PEER_FANOUT_MODE === "union") {
          const depth = parseInt(c.req.header("X-Discovery-Depth") ?? "0", 10) || 0
          const peerVessels = await forwardToPeers(pointer as DiscoveryPointer, depth, c.req.header("Authorization"))
          if (peerVessels.length > 0) {
            // Union merge: peer rows must be dialable from here (a libp2p circuit
            // multiaddr, or a non-loopback endpoint), must not be this substrate's own
            // rows echoed back through the hub (libp2p_peer_id matching a locally
            // registered vessel), and local rows win on vesselId collision.
            const localIds = new Set((cap.vessels ?? []).map((v) => String(v.vesselId ?? "")))
            const localPeerIds = new Set(
              registry.list().map((v) => String((v as unknown as Record<string, unknown>).libp2p_peer_id ?? "")).filter(Boolean),
            )
            const usable = peerVessels.filter((v) => {
              const ma = v.libp2p_multiaddr
              const dialable = (Array.isArray(ma) && ma.length > 0)
                || !/127\.0\.0\.1|localhost/.test(String(v.endpoint ?? ""))
              const selfEcho = localPeerIds.has(String(v.libp2p_peer_id ?? ""))
              return dialable && !selfEcho && !localIds.has(String(v.vesselId ?? ""))
            })
            if (usable.length > 0) {
              cap.vessels = [...(cap.vessels ?? []), ...usable]
              cap.found = true
            }
          }
        }
      }

      const response: ResolveResponse = {
        content,
        metadata: {
          shape: pointer.type,
          resolvedAt: new Date().toISOString(),
          cacheStatus: "miss" // In-memory registry always "miss"
        }
      }

      return c.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 404)
    }
  })

  // Register a vessel
  app.post("/register", async (c) => {
    try {
      const request = await c.req.json<RegisterRequest>()

      if (!request.vesselId || !request.endpoint || !request.shapes) {
        return c.json({ error: "Missing required fields: vesselId, endpoint, shapes" }, 400)
      }

      // Use the authenticated caller's orgId. The body's orgId is ignored in
      // favour of the verified identity so that a caller cannot register
      // vessels under a different tenant's namespace.
      const auth = getAuthContextOptional(c)
      const orgId = auth?.orgId ?? request.orgId

      const registration = registry.register({
        vesselId: request.vesselId,
        vesselName: request.vesselName ?? request.vesselId,
        version: request.version ?? "unknown",
        endpoint: request.endpoint,
        // Optional host/LAN-reachable URL (cross-host attach contract,
        // 2026-07-02) — without this passthrough the handler's explicit field
        // list silently dropped the body field before registry.register().
        public_endpoint: request.public_endpoint,
        // Advisory H2 identity proof-of-possession passthrough (recorded, never enforced).
        pubkey: request.pubkey,
        identity_signature: request.identity_signature,
        identity_nonce: request.identity_nonce,
        identity_signed_at: request.identity_signed_at,
        shapes: request.shapes,
        // Resolver-DESCRIPTION advertisement (2026-06-28): optional per-shape
        // one-liners that let a decomposition planner match ANY advertised
        // resolver from its description alone. Backward-compatible (absent = id-only).
        shape_descriptions: request.shape_descriptions,
        protocol: request.protocol as "http" | "grpc" | "ws" | "unix" | "libp2p" | undefined,
        // libp2p transport advertisement (federation reachability).
        libp2p_peer_id: request.libp2p_peer_id,
        libp2p_multiaddr: request.libp2p_multiaddr,
        orgId,
        systemVessel: request.systemVessel,
        metadata: request.metadata,
        codebase: request.codebase,
        // Phase 1: Explicit typed properties
        stateful: request.stateful,
        state: request.state,
        resolvers: request.resolvers,
        commitSha: request.commitSha,
        discoveredVia: request.discoveredVia,
        discoveredBy: request.discoveredBy,
        // Wave 1A: resolve-contract self-description (all optional; registry
        // normalizes omitted fields to defaults at write time).
        resolve_endpoint: request.resolve_endpoint,
        resolve_request_format: request.resolve_request_format,
        auth_scheme: request.auth_scheme,
        resolve_timeout_ms: request.resolve_timeout_ms,
        // Wave A3 (2026-04-23): auth-token-source contract. Same pattern —
        // optional on input, normalized to defaults at write time.
        auth_token_source: request.auth_token_source,
        auth_delegation_mode: request.auth_delegation_mode
      })

      const response: RegisterResponse = {
        success: true,
        vesselId: registration.vesselId,
        expiresAt: registration.expiresAt ?? Date.now() + 300000
      }

      return c.json(response, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 400)
    }
  })

  // Heartbeat from a vessel
  app.post("/heartbeat", async (c) => {
    try {
      const request = await c.req.json<HeartbeatRequest>()

      if (!request.vesselId) {
        return c.json({ error: "Missing vesselId" }, 400)
      }

      const success = registry.heartbeat(request.vesselId, request.metrics)

      if (!success) {
        return c.json({ error: "Vessel not found - must register first" }, 404)
      }

      const response: HeartbeatResponse = {
        success: true,
        nextHeartbeatMs: HEARTBEAT_INTERVAL_MS
      }

      return c.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 400)
    }
  })

  // Get vessel by ID — used by vessel-proxy to look up endpoint for vessel-prefixed resolvers
  app.get("/vessels/:vesselId", (c) => {
    const vesselId = c.req.param("vesselId")
    const vessel = registry.get(vesselId)
    if (!vessel) {
      return c.json({ error: "Vessel not found" }, 404)
    }
    return c.json({
      vesselId: vessel.vesselId,
      endpoint: vessel.endpoint,
      resolve_endpoint: vessel.resolve_endpoint,
      shapes: vessel.shapes,
      version: vessel.version,
      pubkey_hash: vessel.pubkey_hash,
      identity_status: vessel.identity_status,
    })
  })

  // Unregister a vessel
  app.delete("/vessels/:vesselId", (c) => {
    const vesselId = c.req.param("vesselId")

    // Verify the vessel belongs to the authenticated caller's org before
    // allowing deletion. System vessels can be deleted by any authenticated
    // caller (they are infrastructure-owned).
    const auth = getAuthContextOptional(c)
    if (auth) {
      const vessel = registry.get(vesselId)
      if (!vessel) {
        return c.json({ error: "Vessel not found" }, 404)
      }
      // Reject cross-tenant deletion attempts
      if (vessel.orgId && vessel.orgId !== auth.orgId) {
        return c.json(
          { error: { code: "FORBIDDEN", message: "You do not have permission to delete this vessel" } },
          403
        )
      }
    }

    const success = registry.unregister(vesselId)

    if (!success) {
      return c.json({ error: "Vessel not found" }, 404)
    }

    return c.json({ success: true })
  })

  // List all shapes the discovery vessel can resolve
  app.get("/shapes", (c) => {
    return c.json({
      shapes: getResolvableShapes(),
      vessel: "discovery",
      version: VERSION
    })
  })

  // List all shapes available in the registry.
  // Optional ?org_ids=id1,id2 filters to shapes accessible to those orgs.
  app.get("/registry/shapes", (c) => {
    const orgIdsParam = c.req.query("org_ids")
    const orgIds = orgIdsParam ? orgIdsParam.split(",").map(s => s.trim()).filter(Boolean) : undefined
    return c.json({
      shapes: registry.getShapes(orgIds ? { orgIds } : undefined)
    })
  })

  // Merged shape→description catalogue across all live vessels.
  // Resolver-DESCRIPTION advertisement (2026-06-28): a decomposition planner
  // reads this to match a goal to ANY advertised resolver from its description
  // alone — no hand-written per-resolver hint. Optional ?org_ids=id1,id2 scopes
  // to descriptions from vessels accessible to those orgs.
  app.get("/registry/shape-descriptions", (c) => {
    const orgIdsParam = c.req.query("org_ids")
    const orgIds = orgIdsParam ? orgIdsParam.split(",").map(s => s.trim()).filter(Boolean) : undefined
    return c.json({
      shape_descriptions: registry.getShapeDescriptions(orgIds ? { orgIds } : undefined)
    })
  })

  // Set a LEARNED description for a shape (auto-describe tick, 2026-06-28).
  // Body: { shape, description, source?:"auto" }. Fills the description gap for
  // shapes no live vessel advertises a description for, so the substrate can
  // describe its OWN resolvers without a vessel owner re-registering. A vessel-
  // ADVERTISED description always wins over a learned one (see getShapeDescriptions).
  // Auth: requires ApiKey (not in PUBLIC_PATHS, and POST), matching other writes.
  app.post("/registry/shape-descriptions", async (c) => {
    try {
      const body = await c.req.json<{ shape?: string; description?: string; source?: string }>()
      const shape = typeof body.shape === "string" ? body.shape.trim() : ""
      const description = typeof body.description === "string" ? body.description.trim() : ""
      if (!shape || !description) {
        return c.json({ error: "Missing required fields: shape, description" }, 400)
      }
      const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "auto"
      const entry = registry.setLearnedDescription(shape, description, source)
      if (!entry) {
        return c.json({ error: "Invalid shape or description" }, 400)
      }
      return c.json({ success: true, shape, description: entry.description, source: entry.source }, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 400)
    }
  })

  // Registry stats
  app.get("/registry/stats", (c) => {
    return c.json(registry.getStats())
  })

  // Prometheus metrics endpoint
  app.get("/metrics", (c) => {
    const metrics = metricsRegistry.export()
    return c.text(metrics, 200, {
      'Content-Type': 'text/plain; version=0.0.4'
    })
  })

  // Metrics in JSON format (for debugging)
  app.get("/metrics/json", (c) => {
    return c.json(metricsRegistry.exportJSON())
  })

  return app
}

export { registry } from "./registry"
export { resolve, getResolvableShapes } from "./resolvers"
export * from "./types"
