/**
 * Vessel Registry
 *
 * In-memory registry of vessel capabilities with shape indexing.
 * This is where the discovery data lives - discovery vessel resolves it.
 */

import { createHash, createPublicKey, verify } from "node:crypto"
import type { VesselRegistration } from "./types"
import {
  DEFAULT_RESOLVE_ENDPOINT,
  DEFAULT_RESOLVE_REQUEST_FORMAT,
  DEFAULT_RESOLVE_AUTH_SCHEME,
  DEFAULT_AUTH_TOKEN_SOURCE,
  DEFAULT_AUTH_DELEGATION_MODE
} from "./types"
import { discoveryMetrics } from "./metrics"
import { publishVesselEvent } from "./event-bus"

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

  /**
   * shape -> one-line description, merged across all live vessels.
   * First-non-empty-writer wins per shape: once a vessel advertises a
   * description for a shape, later registrations don't overwrite it unless the
   * holder is gone (rebuilt from live vessels on each read so stale entries from
   * expired/unregistered vessels are dropped). This is the resolver-DESCRIPTION
   * catalogue a decomposition planner reads to match ANY advertised resolver.
   */

  /**
   * LEARNED descriptions (2026-06-28): shape -> {description, source, at}, set
   * via POST /registry/shape-descriptions by the auto-describe tick. These fill
   * the gap for shapes that NO live vessel advertises a description for, so the
   * substrate can describe its own resolvers without a vessel owner re-registering.
   *
   * Precedence: a vessel-ADVERTISED description ALWAYS wins over a learned one
   * (advertised = authoritative, co-located with the resolver). Learned entries
   * are dropped at read time for shapes no longer in ANY live vessel's `shapes`
   * (self-cleaning), so this map can hold stale keys but never leaks them.
   */
  private learnedDescriptions = new Map<string, { description: string; source: string; at: number }>()

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
  /**
   * Advisory H2 identity status; signature verification fills in next.
   */
  private computeIdentityStatus(
    registration: { pubkey?: string; identity_signature?: string; identity_nonce?: string; identity_signed_at?: number; vesselId: string },
    existing?: VesselRegistration,
  ): "verified" | "unverified" | "mismatch" {
    if (!registration.pubkey) return "unverified";
    if (existing?.pubkey && existing.pubkey !== registration.pubkey) return "mismatch";
    if (!registration.identity_signature || !registration.identity_nonce || typeof registration.identity_signed_at !== "number") return "unverified";
    try {
      const raw = Buffer.from(registration.pubkey, "base64");
      const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
      const key = createPublicKey({ key: spki, format: "der", type: "spki" });
      const payload = Buffer.from(JSON.stringify({ vesselId: registration.vesselId, identity_signed_at: registration.identity_signed_at, identity_nonce: registration.identity_nonce }));
      const sig = Buffer.from(registration.identity_signature, "base64");
      return verify(null, payload, key, sig) ? "verified" : "mismatch";
    } catch {
      return "mismatch";
    }
  }

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
      status: "healthy",
      pubkey_hash: registration.pubkey ? createHash("sha256").update(Buffer.from(registration.pubkey, "base64")).digest("base64url") : undefined,
      identity_status: this.computeIdentityStatus(registration, existing),
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

    // Publish vessel.registered to the substrate event bus (best-effort).
    // Per openspec/changes/2026-05-27-neutral-emitter-lifecycle-bus — consumers
    // such as goal-host-vessel subscribe to this event to reactively register
    // proxy resolvers without polling /shapes. Dissolves F-129 (registration race).
    publishVesselEvent("vessel.registered", {
      vessel_id: registration.vesselId,
      shapes: registration.shapes,
      resolve_endpoint: record.resolve_endpoint,
      resolve_request_format: record.resolve_request_format,
      auth_scheme: record.auth_scheme,
      ttl_seconds: Math.round(DEFAULT_TTL_MS / 1000),
      is_reregistration: existing !== undefined,
    })

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

    // Bus emit (best-effort) — consumers track liveness without polling.
    publishVesselEvent("vessel.heartbeat", {
      vessel_id: vesselId,
      ttl_seconds: Math.round(DEFAULT_TTL_MS / 1000),
      shapes_count: vessel.shapes.length,
    })

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
   * Get all unique shapes across all vessels.
   *
   * When `orgIds` is provided, only shapes from vessels accessible to at least
   * one of the given orgIds are returned (system vessels are always included).
   */
  getShapes(options?: { orgIds?: string[] }): string[] {
    if (!options?.orgIds?.length) {
      return Array.from(this.shapeIndex.keys())
    }
    const orgIds = options.orgIds
    const accessible: string[] = []
    for (const [shape, vesselIds] of this.shapeIndex) {
      const reachable = Array.from(vesselIds).some(id => {
        const vessel = this.vessels.get(id)
        if (!vessel || this.isExpired(vessel)) return false
        return vessel.systemVessel === true || (vessel.orgId != null && orgIds.includes(vessel.orgId))
      })
      if (reachable) accessible.push(shape)
    }
    return accessible
  }

  /**
   * Get the merged shape→description map across all live vessels.
   *
   * Computed fresh from currently-registered, non-expired vessels (so an
   * expired/unregistered vessel's descriptions disappear automatically).
   * First-non-empty-writer wins per shape; only descriptions for shapes the
   * vessel actually advertises in `shapes` are included (ignore stray keys).
   *
   * When `orgIds` is provided, only descriptions from vessels accessible to at
   * least one of the given orgIds are returned (system vessels always included).
   */
  getShapeDescriptions(options?: { orgIds?: string[] }): Record<string, string> {
    const orgIds = options?.orgIds
    const merged: Record<string, string> = {}
    // Track which shapes are advertised by at least one accessible live vessel,
    // so a learned description can fill the gap ONLY for shapes that are live
    // but undescribed by their owner.
    const liveShapes = new Set<string>()
    for (const vessel of this.vessels.values()) {
      if (this.isExpired(vessel)) continue
      if (orgIds?.length) {
        const reachable =
          vessel.systemVessel === true ||
          (vessel.orgId != null && orgIds.includes(vessel.orgId))
        if (!reachable) continue
      }
      for (const shape of vessel.shapes) liveShapes.add(shape)
      const descs = vessel.shape_descriptions
      if (!descs) continue
      const advertised = new Set(vessel.shapes)
      for (const [shape, desc] of Object.entries(descs)) {
        if (!advertised.has(shape)) continue // ignore stray keys not in `shapes`
        if (typeof desc !== "string" || desc.trim().length === 0) continue
        if (merged[shape]) continue // first-non-empty-writer wins (advertised)
        merged[shape] = desc.trim()
      }
    }
    // Fill remaining gaps with LEARNED descriptions. Advertised always wins
    // (we skip any shape already in `merged`). Self-cleaning: only fill for a
    // shape that some live, accessible vessel still advertises in `shapes`.
    for (const [shape, entry] of this.learnedDescriptions) {
      if (merged[shape]) continue // advertised wins
      if (!liveShapes.has(shape)) continue // shape gone from the fleet — skip (and prune below)
      merged[shape] = entry.description
    }
    return merged
  }

  /**
   * Set (upsert) a LEARNED description for a shape (auto-describe tick).
   * The learned value only surfaces in getShapeDescriptions when no live vessel
   * ADVERTISES a description for that shape (advertised-wins). Returns the stored
   * entry. Empty/blank descriptions are rejected (no-op, returns null).
   *
   * Also opportunistically prunes learned entries for shapes that are no longer
   * advertised by ANY live vessel, so the map self-cleans over time.
   */
  setLearnedDescription(shape: string, description: string, source = "auto"):
    { description: string; source: string; at: number } | null {
    if (typeof shape !== "string" || shape.trim().length === 0) return null
    if (typeof description !== "string" || description.trim().length === 0) return null
    const entry = { description: description.trim(), source, at: Date.now() }
    this.learnedDescriptions.set(shape.trim(), entry)
    this.pruneLearnedDescriptions()
    return entry
  }

  /**
   * Drop learned descriptions for shapes no longer advertised by any live vessel.
   */
  private pruneLearnedDescriptions(): void {
    if (this.learnedDescriptions.size === 0) return
    const liveShapes = new Set<string>()
    for (const vessel of this.vessels.values()) {
      if (this.isExpired(vessel)) continue
      for (const shape of vessel.shapes) liveShapes.add(shape)
    }
    for (const shape of this.learnedDescriptions.keys()) {
      if (!liveShapes.has(shape)) this.learnedDescriptions.delete(shape)
    }
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

        // Bus emit (best-effort).
        publishVesselEvent("vessel.expired", {
          vessel_id: vesselId,
          last_heartbeat_ms: vessel.lastHeartbeat,
          ttl_seconds: Math.round(DEFAULT_TTL_MS / 1000),
          reason: "ttl_expired",
        })
      }
    }

    if (pruned.length > 0) {
      this.updateMetrics()
      // Drop learned descriptions for shapes whose last advertising vessel expired.
      this.pruneLearnedDescriptions()
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
