/**
 * Discovery Vessel Resolvers
 *
 * Impulse resolvers for discovery-related pointer types.
 * Each resolver loads content where the data lives (the registry).
 */

import { registry } from "./registry"
import { discoveryMetrics } from "./metrics"
import type {
  DiscoveryPointer,
  VesselCapabilityPointer,
  VesselEndpointPointer,
  VesselHealthPointer,
  VesselRegistryPointer,
  VesselCapabilityResult,
  VesselEndpointResult,
  VesselHealthResult,
  VesselRegistryResult,
  ResolverResult
} from "./types"

/**
 * Substrate host-mapping convention: an in-container service port `8xxx` is
 * published to the operator host at `8xxx + OFFSET` (docker `-p 1{8xxx}:8xxx`,
 * default offset 10000). Encoded here in ONE place so external (host) callers —
 * e.g. the operator's Obsidian vessel or metabob-mcp — can reach in-container
 * vessels purely by resolving shapes through discovery, never by hardcoding
 * endpoints. Set DISCOVERY_PUBLIC_PORT_OFFSET=0 to disable derivation.
 */
const PUBLIC_PORT_OFFSET = parseInt(process.env.DISCOVERY_PUBLIC_PORT_OFFSET ?? "10000", 10);

/**
 * Derive a host-reachable public_endpoint from an in-container endpoint when the
 * vessel did not advertise one explicitly. Only rewrites loopback endpoints
 * (localhost / 127.0.0.1) with a container service port in [8000, 9000); other
 * endpoints (real hosts, host.docker.internal, non-service ports) are left as-is
 * (returns undefined → caller keeps the explicit value, which is `undefined`).
 * An explicitly-registered public_endpoint always wins.
 */
export function derivePublicEndpoint(
  endpoint: string | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (!endpoint || !PUBLIC_PORT_OFFSET) return explicit;
  const m = endpoint.match(/^(https?:\/\/)(localhost|127\.0\.0\.1)(:)(\d+)(.*)$/);
  if (!m) return undefined;
  const port = parseInt(m[4] ?? "", 10);
  if (!(port >= 8000 && port < 9000)) return undefined;
  return `${m[1]}${m[2]}${m[3]}${port + PUBLIC_PORT_OFFSET}${m[5]}`;
}

/**
 * Resolve a vesselCapability impulse
 * Returns which vessels can resolve a specific shape
 */
export async function resolveVesselCapability(
  pointer: VesselCapabilityPointer
): Promise<VesselCapabilityResult> {
  let vessels = registry.findByShape(pointer.shape, {
    excludeVessels: pointer.excludeVessels,
    orgId: pointer.orgId
  })

  // DEAD-ROW EVICTION AT RESOLVE TIME (2026-09-19). A short-lived process (a
  // verify-suite or staged vessel copy booted with an ephemeral PORT) can
  // register under a shared shape and die, leaving a row whose endpoint refuses
  // every connection while its lastSeen stays fresh — measured three times in
  // one day on fileContent/codeSearchResult (ports 21016, 26305, 28353), each
  // time blinding fleet-wide compose grounding (0-byte refusals) until an
  // operator restarted the real owner. Rather than trusting registration
  // recency, probe the FIRST local-HTTP candidate with a cheap bounded request
  // when there are alternatives to fall back to; a refused connection evicts
  // that row from the registry and this response. Guarded narrowly: only
  // local plain-HTTP rows are probed (libp2p rows are dialed via the overlay
  // and cannot be TCP-probed here), only when more than one candidate exists
  // (a sole row is returned as-is — a false eviction with no fallback would be
  // strictly worse), and any probe error other than outright connection
  // failure keeps the row (fail-open: slow is not dead).
  if (vessels.length > 1) {
    const head = vessels[0]
    // Grace window: never probe a row younger than 15s — a vessel mid-restart
    // has registered but may not be listening yet, and evicting it would turn
    // a healthy restart into an outage. The measured dead rows persist for
    // minutes, so the window costs nothing against the real failure.
    const headAgeMs = head ? Date.now() - head.lastHeartbeat : 0
    if (head && headAgeMs > 15000 && head.protocol !== "libp2p" && typeof head.endpoint === "string" && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(head.endpoint)) {
      try {
        await fetch(head.endpoint.replace(/\/+$/, "") + "/health", { signal: AbortSignal.timeout(400) })
      } catch (probeErr) {
        const msg = String((probeErr as Error)?.message ?? probeErr)
        if (/refused|ECONNREFUSED|Unable to connect|ConnectionRefused/i.test(msg)) {
          console.warn(`[discovery] evicting dead row for shape=${pointer.shape}: ${head.endpoint} refused connection (vesselId=${String(head.vesselId)})`)
          try { registry.unregister(String(head.vesselId)) } catch { /* eviction is best-effort */ }
          vessels = vessels.slice(1)
        }
      }
    }
  }

  return {
    shape: pointer.shape,
    vessels: vessels.map(v => ({
      vesselId: v.vesselId,
      vesselName: v.vesselName,
      endpoint: v.endpoint,
      public_endpoint: derivePublicEndpoint(v.endpoint, v.public_endpoint),
      protocol: v.protocol,
      // libp2p transport (federation reachability) — echo so callers can dial the
      // peer over the overlay. (metadata is NOT echoed in capability responses.)
      libp2p_peer_id: v.libp2p_peer_id,
      libp2p_multiaddr: v.libp2p_multiaddr,
      confidence: 1.0,
      // Registrant attribution (who last wrote this row) -- echoed so a dead
      // ephemeral-port row can be traced to its writer without host access.
      last_writer: v.last_writer,
      lastSeen: new Date(v.lastHeartbeat).toISOString(),
      // Resolve contract (Wave 1A) — already normalized at registration time.
      resolve_endpoint: v.resolve_endpoint,
      resolve_request_format: v.resolve_request_format,
      auth_scheme: v.auth_scheme,
      resolve_timeout_ms: v.resolve_timeout_ms,
      // Auth token source (Wave A3) — also normalized at registration time.
      auth_token_source: v.auth_token_source,
      auth_delegation_mode: v.auth_delegation_mode,
      // Self-authored distribution/routing policy — echoed so federated routers
      // and the transport ingress pick can honor it (not only discovery /resolve).
      distribution_policy: v.distribution_policy
    })),
    found: vessels.length > 0
  }
}

/**
 * Resolve a vesselEndpoint impulse
 * Returns the endpoint URL for a specific vessel
 */
export async function resolveVesselEndpoint(
  pointer: VesselEndpointPointer
): Promise<VesselEndpointResult> {
  const vessel = registry.get(pointer.vesselId)

  if (!vessel) {
    throw new Error(`Vessel not found: ${pointer.vesselId}`)
  }

  return {
    vesselId: vessel.vesselId,
    vesselName: vessel.vesselName,
    endpoint: vessel.endpoint,
    protocol: vessel.protocol,
    health: vessel.status ?? "unknown",
    lastSeen: new Date(vessel.lastHeartbeat).toISOString()
  }
}

/**
 * Resolve a vesselHealth impulse
 * Checks if a vessel is responsive and healthy
 */
export async function resolveVesselHealth(
  pointer: VesselHealthPointer
): Promise<VesselHealthResult> {
  const vessel = registry.get(pointer.vesselId)

  if (!vessel) {
    return {
      vesselId: pointer.vesselId,
      status: "unhealthy",
      endpoint: "unknown",
      lastHeartbeat: new Date(0).toISOString(),
      error: "Vessel not found in registry"
    }
  }

  // Optional: actively ping the endpoint
  if (pointer.checkEndpoint) {
    try {
      const timeout = pointer.timeout ?? 5000
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(`${vessel.endpoint}/health`, {
        method: "GET",
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      const isHealthy = response.ok
      const uptimeSeconds = Math.floor((Date.now() - vessel.registeredAt) / 1000)

      return {
        vesselId: vessel.vesselId,
        status: isHealthy ? "healthy" : "degraded",
        endpoint: vessel.endpoint,
        lastHeartbeat: new Date(vessel.lastHeartbeat).toISOString(),
        uptimeSeconds,
        metrics: vessel.metadata?.lastMetrics as VesselHealthResult["metrics"]
      }
    } catch (error) {
      return {
        vesselId: vessel.vesselId,
        status: "unhealthy",
        endpoint: vessel.endpoint,
        lastHeartbeat: new Date(vessel.lastHeartbeat).toISOString(),
        error: String(error)
      }
    }
  }

  // Return cached status without active check
  const uptimeSeconds = Math.floor((Date.now() - vessel.registeredAt) / 1000)

  return {
    vesselId: vessel.vesselId,
    status: vessel.status ?? "unknown",
    endpoint: vessel.endpoint,
    lastHeartbeat: new Date(vessel.lastHeartbeat).toISOString(),
    uptimeSeconds,
    metrics: vessel.metadata?.lastMetrics as VesselHealthResult["metrics"]
  }
}

/**
 * Resolve a vesselRegistry impulse
 * Lists all registered vessels with optional filters
 */
export async function resolveVesselRegistry(
  pointer: VesselRegistryPointer
): Promise<VesselRegistryResult> {
  const vessels = registry.list(pointer.filters)

  return {
    vessels: vessels.map(v => ({
      vesselId: v.vesselId,
      vesselName: v.vesselName,
      shapes: v.shapes,
      endpoint: v.endpoint,
      protocol: v.protocol,
      resolve_endpoint: v.resolve_endpoint,
      resolve_request_format: v.resolve_request_format,
      status: v.status ?? "unknown",
      lastSeen: new Date(v.lastHeartbeat).toISOString(),
      metadata: v.metadata,
      // Advertise the vessel's own distribution policy + its p2p reachability in
      // the canonical registry dump so the "p2p + own-rules" bar is observable.
      distribution_policy: v.distribution_policy,
      libp2p_peer_id: v.libp2p_peer_id,
      libp2p_multiaddr: v.libp2p_multiaddr
    })),
    totalCount: vessels.length
  }
}

/**
 * Main resolver dispatch
 * Routes pointer to appropriate resolver based on type
 */
export async function resolve(pointer: DiscoveryPointer): Promise<ResolverResult> {
  const startTime = Date.now()
  let success = true

  try {
    let result: ResolverResult

    switch (pointer.type) {
      case "vesselCapability":
        result = await resolveVesselCapability(pointer)
        break

      case "vesselEndpoint":
        result = await resolveVesselEndpoint(pointer)
        break

      case "vesselHealth":
        result = await resolveVesselHealth(pointer)
        break

      case "vesselRegistry":
        result = await resolveVesselRegistry(pointer)
        break

      default:
        success = false
        throw new Error(`Unknown discovery pointer type: ${(pointer as { type: string }).type}`)
    }

    return result
  } catch (error) {
    success = false
    throw error
  } finally {
    const duration = Date.now() - startTime
    discoveryMetrics.recordResolution(pointer.type, duration, success)
  }
}

/**
 * Get shapes this vessel can resolve
 */
export function getResolvableShapes(): string[] {
  return ["vesselCapability", "vesselEndpoint", "vesselHealth", "vesselRegistry"]
}
