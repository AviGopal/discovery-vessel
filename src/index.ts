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

  // Resolve discovery impulses
  app.post("/resolve", async (c) => {
    try {
      const { pointer } = await c.req.json<ResolveRequest>()

      if (!pointer || !pointer.type) {
        return c.json({ error: "Missing pointer or pointer.type" }, 400)
      }

      const content = await resolve(pointer as DiscoveryPointer)

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
        shapes: request.shapes,
        protocol: request.protocol as "http" | "grpc" | "ws" | "unix" | undefined,
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
        resolve_timeout_ms: request.resolve_timeout_ms
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

  // List all shapes available in the registry
  app.get("/registry/shapes", (c) => {
    return c.json({
      shapes: registry.getShapes()
    })
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
