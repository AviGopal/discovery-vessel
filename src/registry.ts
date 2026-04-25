/**
 * Vessel Registry
 *
 * In-memory registry of vessel capabilities with shape indexing.
 * This is where the discovery data lives - discovery vessel resolves it.
 */

import type { VesselRegistration } from "./types"
import {
  DEFAULT_RESOLVE_ENDPOINT,
  DEFAULT_RESOLVE_REQUEST_FORMAT,
  DEFAULT_RESOLVE_AUTH_SCHEME,
  DEFAULT_AUTH_TOKEN_SOURCE,
  DEFAULT_AUTH_DELEGATION_MODE
} from "./types"
import { discoveryMetrics } from "./metrics"

/** Default TTL for vessel registrations (5 minutes) */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** Heartbeat interval (should be less than TTL) */
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000

export class VesselRegistry {
  /** vesselId -> VesselRegistration */
  private vessels = new Map<string, VesselRegistration>()

  /** shape -> Set of vesselIds that can resolve it */
  private shapeIndex = new Map<string, Set<string>>()

  /** orgId -> Set of vesselIds */
  private orgIndex = new Map<string, Set<string>>()

  /** Cleanup interval handle */
  private cleanupInterval?: ReturnType<typeof setInterval>

  constructor() {
    // Start periodic cleanup of expired registrations
    this.cleanupInterval = setInterval(() => this.pruneExpired(), 60_000)
  }

  // ---------------------------------------------------------------------------
  // Private tenant-isolation helper
  // ---------------------------------------------------------------------------

  /**
   * Returns true if `vessel` should be visible to the caller identified by
   * `orgId`.
   *
   * A vessel is accessible when:
   * 1. It is explicitly marked as a system vessel (`systemVessel === true`), OR
   * 2. Its `orgId` matches the caller's `orgId` exactly.
   *
   * Vessels registered without `orgId` AND without `systemVessel: true` are
   * NOT automatically public — they are only visible in unscoped queries
   * (i.e. when no `orgId` filter is provided by the caller).
   */
  private isAccessibleTo(vessel: VesselRegistration, orgId: string): boolean {
    return vessel.systemVessel === true || vessel.orgId === orgId
  }

  // ---------------------------------------------------------------------------

  /**
   * Register a vessel's capabilities.
   *
   * The resolve-contract fields (`resolve_endpoint`, `resolve_request_format`,
   * `auth_scheme`, `resolve_timeout_ms`) and auth-token-source fields
   * (`auth_token_source`, `auth_delegation_mode`) are optional on input and
   * get normalized to defaults at write time — the stored `VesselRegistration`
   * always has them populated (except `resolve_timeout_ms`, which stays
   * undefined when not advertised so the client can apply its own default).
   */
  register(
    registration:
      & Omit<
          VesselRegistration,
          | "registeredAt"
          | "lastHeartbeat"
          | "status"
          | "resolve_endpoint"
          | "resolve_request_format"
          | "auth_scheme"
          | "resolve_timeout_ms"
          | "auth_token_source"
          | "auth_delegation_mode"
        >
      & Partial<
          Pick<
            VesselRegistration,
            | "resolve_endpoint"
            | "resolve_request_format"
            | "auth_scheme"
            | "resolve_timeout_ms"
            | "auth_token_source"
            | "auth_delegation_mode"
          >
        >
  ): VesselRegistration {
    const startTime = Date.now()
    const existing = this.vessels.get(registration.vesselId)

    // Warn when a vessel registers without both orgId and systemVessel=true.
    // Such vessels are NOT visible in org-scoped queries (tenant isolation).
    // This warning is intentionally not a hard reject for backward compat.
    if (!registration.orgId && !registration.systemVessel) {
      console.warn(
        `[registry] Vessel "${registration.vesselId}" registered without orgId or systemVessel=true. ` +
        "It will not appear in org-scoped discovery queries. " +
        "Set systemVessel=true for shared infrastructure vessels."
      )
    }

    const record: VesselRegistration = {
      ...registration,
      // Normalize resolve contract at write time so every consumer sees a
      // populated value regardless of whether the vessel advertised it.
      resolve_endpoint: registration.resolve_endpoint ?? DEFAULT_RESOLVE_ENDPOINT,
      resolve_request_format: registration.resolve_request_format ?? DEFAULT_RESOLVE_REQUEST_FORMAT,
      auth_scheme: registration.auth_scheme ?? DEFAULT_RESOLVE_AUTH_SCHEME,
      resolve_timeout_ms: registration.resolve_timeout_ms, // stays undefined when not advertised
      // Same pattern for auth-token-source contract (Wave A3, 2026-04-23).
      auth_token_source: registration.auth_token_source ?? DEFAULT_AUTH_TOKEN_SOURCE,
      auth_delegation_mode: registration.auth_delegation_mode ?? DEFAULT_AUTH_DELEGATION_MODE,
      registeredAt: existing?.registeredAt ?? startTime,
      lastHeartbeat: startTime,
      expiresAt: startTime + DEFAULT_TTL_MS,
      status: "healthy"
    }

    // Remove from old indexes if re-registering with different shapes
    if (existing) {
      this.removeFromIndexes(existing)
    }

    // Store registration
    this.vessels.set(registration.vesselId, record)

    // Index by shapes
    for (const shape of registration.shapes) {
      if (!this.shapeIndex.has(shape)) {
        this.shapeIndex.set(shape, new Set())
      }
      this.shapeIndex.get(shape)!.add(registration.vesselId)
    }

    // Index by org
    if (registration.orgId) {
      if (!this.orgIndex.has(registration.orgId)) {
        this.orgIndex.set(registration.orgId, new Set())
      }
      this.orgIndex.get(registration.orgId)!.add(registration.vesselId)
    }

    // Record metrics
    const duration = Date.now() - startTime
    discoveryMetrics.recordRegistration(registration.vesselId, duration, true)
    this.updateMetrics()

    return record
  }

  /**
   * Update heartbeat timestamp
   */
  heartbeat(vesselId: string, metrics?: { executionsCompleted?: number; errorRate?: number; avgLatencyMs?: number }): boolean {
    const vessel = this.vessels.get(vesselId)
    if (!vessel) {
      discoveryMetrics.recordHeartbeat(vesselId, false)
      return false
    }

    const now = Date.now()
    vessel.lastHeartbeat = now
    vessel.expiresAt = now + DEFAULT_TTL_MS
    vessel.status = "healthy"

    // Store metrics if provided
    if (metrics) {
      vessel.metadata = {
        ...vessel.metadata,
        lastMetrics: metrics
      }

      // Update heartbeat failure rate metric if error rate is provided
      if (metrics.errorRate !== undefined) {
        discoveryMetrics.updateHeartbeatFailureRate(vesselId, metrics.errorRate)
      }
    }

    discoveryMetrics.recordHeartbeat(vesselId, true)
    return true
  }

  /**
   * Find vessels by shape
   */
  findByShape(shape: string, options?: { excludeVessels?: string[]; orgId?: string }): VesselRegistration[] {
    const vesselIds = this.shapeIndex.get(shape)
    if (!vesselIds) return []

    let results = Array.from(vesselIds)
      .map(id => this.vessels.get(id))
      .filter((v): v is VesselRegistration => v !== undefined)
      .filter(v => !this.isExpired(v))

    // Filter by org if specified
    if (options?.orgId) {
      results = results.filter(v => this.isAccessibleTo(v, options.orgId!))
    }

    // Exclude specific vessels
    if (options?.excludeVessels) {
      const excluded = new Set(options.excludeVessels)
      results = results.filter(v => !excluded.has(v.vesselId))
    }

    return results
  }

  /**
   * Get a specific vessel by ID
   */
  get(vesselId: string): VesselRegistration | undefined {
    const vessel = this.vessels.get(vesselId)
    if (!vessel || this.isExpired(vessel)) return undefined
    return vessel
  }

  /**
   * List all vessels with optional filters
   */
  list(filters?: { shapes?: string[]; status?: string[]; orgId?: string }): VesselRegistration[] {
    let results = Array.from(this.vessels.values())
      .filter(v => !this.isExpired(v))

    // Filter by shapes
    if (filters?.shapes?.length) {
      results = results.filter(v =>
        filters.shapes!.some(shape => v.shapes.includes(shape))
      )
    }

    // Filter by status
    if (filters?.status?.length) {
      results = results.filter(v =>
        filters.status!.includes(v.status ?? "unknown")
      )
    }

    // Filter by org
    if (filters?.orgId) {
      results = results.filter(v => this.isAccessibleTo(v, filters.orgId!))
    }

    return results
  }

  /**
   * Unregister a vessel
   */
  unregister(vesselId: string): boolean {
    const vessel = this.vessels.get(vesselId)
    if (!vessel) return false

    this.removeFromIndexes(vessel)
    this.vessels.delete(vesselId)

    // Record deregistration metric
    discoveryMetrics.recordDeregistration(vesselId, 'manual')
    this.updateMetrics()

    return true
  }

  /**
   * Get all unique shapes across all vessels
   */
  getShapes(): string[] {
    return Array.from(this.shapeIndex.keys())
  }

  /**
   * Get registry stats
   */
  getStats(): { totalVessels: number; totalShapes: number; healthyCount: number } {
    const all = Array.from(this.vessels.values()).filter(v => !this.isExpired(v))
    return {
      totalVessels: all.length,
      totalShapes: this.shapeIndex.size,
      healthyCount: all.filter(v => v.status === "healthy").length
    }
  }

  /**
   * Cleanup expired registrations
   */
  pruneExpired(): string[] {
    const pruned: string[] = []

    for (const [vesselId, vessel] of this.vessels) {
      if (this.isExpired(vessel)) {
        this.removeFromIndexes(vessel)
        this.vessels.delete(vesselId)
        pruned.push(vesselId)

        // Record expiration metric
        discoveryMetrics.recordDeregistration(vesselId, 'expired')
      }
    }

    if (pruned.length > 0) {
      this.updateMetrics()
    }

    return pruned
  }

  /**
   * Stop the cleanup interval (for shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }
  }

  // --- Private helpers ---

  private isExpired(vessel: VesselRegistration): boolean {
    return vessel.expiresAt !== undefined && Date.now() > vessel.expiresAt
  }

  private removeFromIndexes(vessel: VesselRegistration): void {
    // Remove from shape index
    for (const shape of vessel.shapes) {
      const ids = this.shapeIndex.get(shape)
      if (ids) {
        ids.delete(vessel.vesselId)
        if (ids.size === 0) {
          this.shapeIndex.delete(shape)
        }
      }
    }

    // Remove from org index
    if (vessel.orgId) {
      const ids = this.orgIndex.get(vessel.orgId)
      if (ids) {
        ids.delete(vessel.vesselId)
        if (ids.size === 0) {
          this.orgIndex.delete(vessel.orgId)
        }
      }
    }
  }

  /**
   * Update registry metrics
   */
  private updateMetrics(): void {
    const stats = this.getStats()
    discoveryMetrics.updateRegistryStats(stats.totalVessels, stats.totalShapes)
  }
}

/** Singleton registry instance */
export const registry = new VesselRegistry()
