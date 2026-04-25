/**
 * Discovery Vessel Type Definitions
 *
 * Impulse types for vessel capability discovery and registry.
 * Following the impulse-activity foundation: resolvers live where data lives.
 */

// =============================================================================
// RESOLVE CONTRACT (Wave 1A)
// =============================================================================

/**
 * How a vessel wants resolve requests encoded.
 * - "pointer": body is `{pointer: {type, ...rest}}` (canonical impulse contract)
 * - "mcp-tool": body is `{tool: "${pointer.type}_resolve", arguments: pointer}`
 *   (used by MCP-style vessels like legacy concept-db).
 */
export type ResolveRequestFormat = "pointer" | "mcp-tool"

/**
 * Authentication scheme the vessel expects on resolve requests.
 * - "none": no Authorization header
 * - "ApiKey": `Authorization: ApiKey <key>`
 * - "Bearer": `Authorization: Bearer <token>`
 */
export type ResolveAuthScheme = "none" | "ApiKey" | "Bearer"

/** Default HTTP path for impulse resolution on a vessel. */
export const DEFAULT_RESOLVE_ENDPOINT = "/v2/impulses/resolve"
/** Default resolve request body encoding. */
export const DEFAULT_RESOLVE_REQUEST_FORMAT: ResolveRequestFormat = "pointer"
/** Default auth scheme (no auth). */
export const DEFAULT_RESOLVE_AUTH_SCHEME: ResolveAuthScheme = "none"

// =============================================================================
// AUTHENTICATION
// =============================================================================

/**
 * Resolved auth context populated by the auth middleware on every authenticated
 * request. Available via `getAuthContext(c)` in route handlers.
 */
export interface AuthContext {
  orgId: string
  userId: string
  keyId: string
  scopes: string[]
}

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

  /**
   * When `true`, this vessel is treated as a system vessel accessible to all
   * tenants regardless of `orgId`. Discovery-vessel itself self-registers with
   * this flag. Use `systemVessel: true` instead of leaving `orgId` undefined
   * for public/shared infrastructure vessels.
   */
  systemVessel?: boolean

  // --- Resolve contract (Wave 1A) -------------------------------------------
  /** HTTP path appended to `endpoint` when resolving impulses. */
  resolve_endpoint: string

  /** Shape of the resolve request body (pointer vs mcp-tool). */
  resolve_request_format: ResolveRequestFormat

  /** Authentication scheme expected on resolve requests. */
  auth_scheme: ResolveAuthScheme

  /** Vessel-declared max-time-to-respond on the resolve endpoint (ms). */
  resolve_timeout_ms?: number

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

  // Phase 1: Explicit typed properties
  /** Whether the vessel maintains state */
  stateful?: boolean

  /** State tracking information */
  state?: {
    lastMigration?: string
    schemaVersion?: string
    recordCount?: number
    healthMetrics?: {
      errorRate?: number
      avgLatencyMs?: number
      lastBackup?: string
    }
  }

  /** Resolver configurations */
  resolvers?: Array<{
    id: string
    tier: string
    operations?: string[]
  }>

  /** Git commit SHA for tracking deployments */
  commitSha?: string

  /** How the vessel was discovered */
  discoveredVia?: "self" | "peer" | "network-scan" | "bootstrap"

  /** ID of the vessel that discovered this one */
  discoveredBy?: string
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

export interface VesselCapability {
  vesselId: string
  vesselName: string
  endpoint: string
  protocol?: string
  confidence: number
  lastSeen: string

  // --- Resolve contract (Wave 1A) -------------------------------------------
  /** HTTP path appended to `endpoint` when resolving impulses. */
  resolve_endpoint: string
  /** Shape of the resolve request body (pointer vs mcp-tool). */
  resolve_request_format: ResolveRequestFormat
  /** Authentication scheme expected on resolve requests. */
  auth_scheme: ResolveAuthScheme
  /** Vessel-declared max-time-to-respond on the resolve endpoint (ms). */
  resolve_timeout_ms?: number
}

export interface VesselCapabilityResult {
  shape: string
  vessels: VesselCapability[]
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
  /** System vessels are accessible to all tenants regardless of orgId. */
  systemVessel?: boolean
  metadata?: Record<string, unknown>
  codebase?: {
    accessLevel: "read-write" | "read-only" | "none"
    modifiableBy?: string
  }

  // --- Resolve contract (Wave 1A, all optional) -----------------------------
  /** HTTP path appended to `endpoint` when resolving impulses.
   *  Default: "/v2/impulses/resolve" */
  resolve_endpoint?: string
  /** Shape of the resolve request body. Default: "pointer" */
  resolve_request_format?: ResolveRequestFormat
  /** Authentication scheme expected on resolve requests. Default: "none" */
  auth_scheme?: ResolveAuthScheme
  /** Vessel-declared max-time-to-respond on the resolve endpoint (ms).
   *  Left unset by default; client applies its own default (typically 5000). */
  resolve_timeout_ms?: number

  // Phase 1: Explicit typed properties
  /** Whether the vessel maintains state */
  stateful?: boolean

  /** State tracking information */
  state?: {
    lastMigration?: string
    schemaVersion?: string
    recordCount?: number
    healthMetrics?: {
      errorRate?: number
      avgLatencyMs?: number
      lastBackup?: string
    }
  }

  /** Resolver configurations */
  resolvers?: Array<{
    id: string
    tier: string
    operations?: string[]
  }>

  /** Git commit SHA for tracking deployments */
  commitSha?: string

  /** How the vessel was discovered */
  discoveredVia?: "self" | "peer" | "network-scan" | "bootstrap"

  /** ID of the vessel that discovered this one */
  discoveredBy?: string
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
