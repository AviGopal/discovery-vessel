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
 * Resolve a vesselCapability impulse
 * Returns which vessels can resolve a specific shape
 */
export async function resolveVesselCapability(
  pointer: VesselCapabilityPointer
): Promise<VesselCapabilityResult> {
  const vessels = registry.findByShape(pointer.shape, {
    excludeVessels: pointer.excludeVessels,
    orgId: pointer.orgId
  })

  return {
    shape: pointer.shape,
    vessels: vessels.map(v => ({
      vesselId: v.vesselId,
      vesselName: v.vesselName,
      endpoint: v.endpoint,
      public_endpoint: v.public_endpoint,
      protocol: v.protocol,
      // libp2p transport (federation reachability) — echo so callers can dial the
      // peer over the overlay. (metadata is NOT echoed in capability responses.)
      libp2p_peer_id: v.libp2p_peer_id,
      libp2p_multiaddr: v.libp2p_multiaddr,
      confidence: 1.0,
      lastSeen: new Date(v.lastHeartbeat).toISOString(),
      // Resolve contract (Wave 1A) — already normalized at registration time.
      resolve_endpoint: v.resolve_endpoint,
      resolve_request_format: v.resolve_request_format,
      auth_scheme: v.auth_scheme,
      resolve_timeout_ms: v.resolve_timeout_ms,
      // Auth token source (Wave A3) — also normalized at registration time.
      auth_token_source: v.auth_token_source,
      auth_delegation_mode: v.auth_delegation_mode
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
      metadata: v.metadata
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
