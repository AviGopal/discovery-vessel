/**
 * Discovery Vessel Type Definitions
 *
 * Impulse types for vessel capability discovery and registry.
 * Following the impulse-activity foundation: resolvers live where data lives.
 */

// =============================================================================
// VESSEL REGISTRATION
// =============================================================================

/**
 * Vessel registration record - what a vessel advertises about itself
 */
export interface VesselRegistration {
  vesselId: string
  vesselName: string
  version: string
  endpoint: string

  /** Impulse shapes this vessel can resolve */
  shapes: string[]

  /** Protocol for communication (defaults to http) */
  protocol?: "http" | "grpc" | "ws" | "unix"

  /** Organizational scope */
  orgId?: string

  /** Additional metadata */
  metadata?: {
    environment?: "k8s-cluster" | "docker" | "local"
    podId?: string
    replicaIndex?: number
    clusterMode?: boolean
    [key: string]: unknown
  }

  /** Access control for cross-vessel operations */
  codebase?: {
    accessLevel: "read-write" | "read-only" | "none"
    modifiableBy?: string
  }

  /** Health status (computed) */
  status?: "healthy" | "degraded" | "unhealthy" | "unknown"

  /** Timestamps */
  registeredAt: number
  lastHeartbeat: number
  expiresAt?: number
}

// =============================================================================
// DISCOVERY IMPULSE POINTERS
// =============================================================================

/**
 * vesselCapability - Query which vessels can resolve a specific shape
 */
export interface VesselCapabilityPointer {
  type: "vesselCapability"
  shape: string
  excludeVessels?: string[]
  orgId?: string
}

/**
 * vesselEndpoint - Get the endpoint URL for a specific vessel
 */
export interface VesselEndpointPointer {
  type: "vesselEndpoint"
  vesselId: string
  preferLocal?: boolean
}

/**
 * vesselHealth - Check if a vessel is responsive and healthy
 */
export interface VesselHealthPointer {
  type: "vesselHealth"
  vesselId: string
  checkEndpoint?: boolean
  timeout?: number
}

/**
 * vesselRegistry - List all registered vessels
 */
export interface VesselRegistryPointer {
  type: "vesselRegistry"
  filters?: {
    shapes?: string[]
    status?: ("healthy" | "degraded" | "unhealthy")[]
    orgId?: string
  }
}

/**
 * Union of all discovery pointer types
 */
export type DiscoveryPointer =
  | VesselCapabilityPointer
  | VesselEndpointPointer
  | VesselHealthPointer
  | VesselRegistryPointer

// =============================================================================
// RESOLUTION RESULTS
// =============================================================================

export interface VesselCapabilityResult {
  shape: string
  vessels: Array<{
    vesselId: string
    vesselName: string
    endpoint: string
    protocol?: string
    confidence: number
    lastSeen: string
  }>
  found: boolean
}

export interface VesselEndpointResult {
  vesselId: string
  vesselName: string
  endpoint: string
  externalEndpoint?: string
  protocol?: string
  health: string
  lastSeen: string
}

export interface VesselHealthResult {
  vesselId: string
  status: "healthy" | "degraded" | "unhealthy" | "unknown"
  endpoint: string
  lastHeartbeat: string
  uptimeSeconds?: number
  error?: string
  metrics?: {
    executionsCompleted?: number
    errorRate?: number
    avgLatencyMs?: number
  }
}

export interface VesselRegistryResult {
  vessels: Array<{
    vesselId: string
    vesselName: string
    shapes: string[]
    endpoint: string
    protocol?: string
    status: string
    lastSeen: string
    metadata?: Record<string, unknown>
  }>
  totalCount: number
}

export type ResolverResult =
  | VesselCapabilityResult
  | VesselEndpointResult
  | VesselHealthResult
  | VesselRegistryResult

// =============================================================================
// API TYPES
// =============================================================================

export interface ResolveRequest {
  pointer: DiscoveryPointer
}

export interface ResolveResponse {
  content: ResolverResult
  metadata?: {
    shape: string
    resolvedAt: string
    cacheStatus?: "hit" | "miss"
  }
}

export interface RegisterRequest {
  vesselId: string
  vesselName: string
  version: string
  endpoint: string
  shapes: string[]
  protocol?: string
  orgId?: string
  metadata?: Record<string, unknown>
  codebase?: {
    accessLevel: "read-write" | "read-only" | "none"
    modifiableBy?: string
  }
}

export interface RegisterResponse {
  success: boolean
  vesselId: string
  expiresAt: number
}

export interface HeartbeatRequest {
  vesselId: string
  metrics?: {
    executionsCompleted?: number
    errorRate?: number
    avgLatencyMs?: number
  }
}

export interface HeartbeatResponse {
  success: boolean
  nextHeartbeatMs: number
}

export interface HealthResponse {
  status: "ok" | "degraded"
  vessel: "discovery"
  version: string
  registeredVessels: number
  uptime: number
}
