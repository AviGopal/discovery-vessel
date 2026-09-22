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

/**
 * Which credential the caller should attach when invoking this vessel's
 * resolve endpoint. Pairs with `ResolveAuthScheme`, which says *how* to
 * format the Authorization header; this says *whose* token to format.
 *
 *   "caller_identity"  caller's own service token (e.g. METABOB_API_KEY).
 *                      Default — preserves pre-2026-04-23 behavior.
 *   "user_identity"    a user JWT the caller is acting on behalf of.
 *   "service_identity" alias for caller_identity, future-reserved.
 *   "no_token"         vessel explicitly wants no Authorization header,
 *                      even if `auth_scheme` would normally attach one.
 *
 * See `docs/specs/auth-token-source-field.md` in the super-repo.
 */
export type AuthTokenSource =
  | "caller_identity"
  | "user_identity"
  | "service_identity"
  | "no_token"

/**
 * For vessels that advertise `auth_token_source: "user_identity"`, declares
 * how the caller obtains the token to send.
 *
 *   "forward" caller forwards the user JWT it already holds.
 *   "mint"    caller asks identity-vessel to mint a target-bound token.
 *   "none"    vessel does not accept delegation.
 *
 * Default: `"forward"`.
 */
export type AuthDelegationMode = "forward" | "mint" | "none"

/**
 * Self-authored distribution/routing rule a vessel advertises about ITS OWN
 * shapes — the "vessels set their own distribution and routing rules" contract.
 * The routing fixed point (discovery /resolve) and any federated router reading
 * capability rows honor it when choosing among multiple producers of a shape.
 *
 *   "stateless"                 every instance is interchangeable; pick any live one (default).
 *   "interchangeable"           explicit synonym of stateless.
 *   "unique_authoritative"      exactly one row is authoritative; never load-balance across replicas.
 *   "unique_target"             route to a single declared target (e.g. a pinned owner).
 *   "stateful_data_owner_pin"   state lives on one instance; always route to the owning row.
 *   "stateful_data_owner_merge" state is sharded; a caller fans out and merges across owners.
 *
 * Normalized at write time (defaults to "stateless"); read from a top-level
 * `distribution_policy` field OR, for back-compat with vessels already sending
 * it inside the free-form metadata blob, `metadata.duplicate_policy`.
 */
export type DistributionPolicy =
  | "stateless"
  | "interchangeable"
  | "unique_authoritative"
  | "unique_target"
  | "stateful_data_owner_pin"
  | "stateful_data_owner_merge"

/** Default HTTP path for impulse resolution on a vessel. */
export const DEFAULT_RESOLVE_ENDPOINT = "/v2/impulses/resolve"
/** Default resolve request body encoding. */
export const DEFAULT_RESOLVE_REQUEST_FORMAT: ResolveRequestFormat = "pointer"
/** Default auth scheme (no auth). */
export const DEFAULT_RESOLVE_AUTH_SCHEME: ResolveAuthScheme = "none"
/** Default credential kind (caller's own service identity). */
export const DEFAULT_AUTH_TOKEN_SOURCE: AuthTokenSource = "caller_identity"
/** Default delegation mode for user-identity tokens. */
export const DEFAULT_AUTH_DELEGATION_MODE: AuthDelegationMode = "forward"
/** Default distribution/routing policy when a vessel advertises none. */
export const DEFAULT_DISTRIBUTION_POLICY: DistributionPolicy = "stateless"

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
  /** Advisory (recorded, never enforced) proof-of-possession: base64-encoded Ed25519 public key (32 bytes raw). */
  pubkey?: string
  /** Advisory proof-of-possession: base64 Ed25519 signature over canonical JSON of {vesselId, identity_signed_at, identity_nonce}. */
  identity_signature?: string
  /** Advisory proof-of-possession: nonce used in the identity signature payload. */
  identity_nonce?: string
  /** Advisory proof-of-possession: unix ms timestamp used in the identity signature payload. */
  identity_signed_at?: number
  /** Registry-computed advisory field: base64url SHA-256 of the raw pubkey bytes. */
  pubkey_hash?: string
  /** Registry-computed advisory identity status: verified = signature checked OK, unverified = no signature provided, mismatch = signature check failed. */
  identity_status?: "verified" | "unverified" | "mismatch"
  /** Registry-computed attribution: who last wrote this row (the /register handler passes the verified auth identity + remote address; fail-open, absent for self-registered rows). */
  last_writer?: { remote_addr?: string; key_id?: string; user_id?: string; org_id?: string; claimed_vessel_id?: string; at?: number }
  vesselId: string
  vesselName: string
  version: string
  endpoint: string

  /** Impulse shapes this vessel can resolve */
  shapes: string[]

  /**
   * OPTIONAL per-shape one-line descriptions: shape id → "what it produces +
   * when to use it". This is the resolver-DESCRIPTION advertisement (2026-06-28)
   * that lets a decomposition planner MATCH a goal to ANY advertised resolver
   * from its description alone, without a hand-written hint per resolver class.
   * Co-located with the resolver: the vessel that OWNS a shape writes its
   * description once, here. Backward-compatible — absent = today's id-only
   * behaviour. Keys that aren't in `shapes` are ignored at read time.
   */
  shape_descriptions?: Record<string, string>

  /** Protocol for communication (defaults to http). "libp2p" = reachable over the
   *  libp2p overlay (peerId/multiaddr below) rather than a plain http endpoint. */
  protocol?: "http" | "grpc" | "ws" | "unix" | "libp2p"

  // --- libp2p transport (federation reachability) ---------------------------
  /** Stable libp2p PeerId (multihash of the vessel pubkey, seeded from vessel id).
   *  Present when the vessel is reachable over the libp2p overlay. */
  libp2p_peer_id?: string
  /** libp2p multiaddr(s) the vessel is reachable at — typically a relay-circuit
   *  address `/…/p2p/<relay>/p2p-circuit/p2p/<vessel>`. Callers dial these over the
   *  overlay (NAT-traversed via relay + DCUtR). This is the field a caller needs to
   *  reach a peer vessel; advertised here because discovery's capability response
   *  does NOT echo `metadata`. */
  libp2p_multiaddr?: string[]

  /** Organizational scope */
  orgId?: string

  /**
   * When `true`, this vessel is treated as a system vessel accessible to all
   * tenants regardless of `orgId`. Discovery-vessel itself self-registers with
   * this flag. Use `systemVessel: true` instead of leaving `orgId` undefined
   * for public/shared infrastructure vessels.
   */
  systemVessel?: boolean

  /**
   * Optional host/LAN-reachable URL for callers OUTSIDE the substrate's
   * container network (e.g. metabob-mcp on the operator host). `endpoint`
   * remains the substrate-internal URL; external consumers prefer
   * `public_endpoint` when present. Stored and echoed verbatim; absent means
   * no behavior change (2026-07-02, cross-host attach contract).
   */
  public_endpoint?: string

  // --- Resolve contract (Wave 1A) -------------------------------------------
  /** HTTP path appended to `endpoint` when resolving impulses. */
  resolve_endpoint: string

  /** Shape of the resolve request body (pointer vs mcp-tool). */
  resolve_request_format: ResolveRequestFormat

  /** Authentication scheme expected on resolve requests. */
  auth_scheme: ResolveAuthScheme

  /** Vessel-declared max-time-to-respond on the resolve endpoint (ms). */
  resolve_timeout_ms?: number

  // --- Auth token source (Wave A3, 2026-04-23) ------------------------------
  /** Which credential kind the caller should attach. Normalized at write
   *  time — defaults to "caller_identity" when absent on input. */
  auth_token_source: AuthTokenSource

  /** Delegation mode for user-identity tokens. Normalized at write time —
   *  defaults to "forward" when absent on input. Meaningful only when
   *  `auth_token_source === "user_identity"`. */
  auth_delegation_mode: AuthDelegationMode

  /** Self-authored distribution/routing policy (see DistributionPolicy).
   *  Normalized at write time — defaults to "stateless"; read from this field
   *  or `metadata.duplicate_policy`. Honored by the /resolve producer pick. */
  distribution_policy: DistributionPolicy

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
  /** libp2p transport (federation reachability) — present when the vessel advertised
   *  a libp2p peerId/multiaddr at registration. Callers dial `libp2p_multiaddr` over
   *  the overlay when the vessel isn't reachable at a plain http `endpoint`. */
  libp2p_peer_id?: string
  libp2p_multiaddr?: string[]
  confidence: number
  /** Registrant attribution echoed from the registry row (who last wrote it). */
  last_writer?: { remote_addr?: string; key_id?: string; user_id?: string; org_id?: string; claimed_vessel_id?: string; at?: number }
  lastSeen: string

  /** Optional host/LAN-reachable URL advertised by the vessel (see registration). */
  public_endpoint?: string

  // --- Resolve contract (Wave 1A) -------------------------------------------
  /** HTTP path appended to `endpoint` when resolving impulses. */
  resolve_endpoint: string
  /** Shape of the resolve request body (pointer vs mcp-tool). */
  resolve_request_format: ResolveRequestFormat
  /** Authentication scheme expected on resolve requests. */
  auth_scheme: ResolveAuthScheme
  /** Vessel-declared max-time-to-respond on the resolve endpoint (ms). */
  resolve_timeout_ms?: number

  // --- Auth token source (Wave A3, 2026-04-23) ------------------------------
  /** Which credential kind the caller should attach. */
  auth_token_source: AuthTokenSource
  /** Delegation mode for user-identity tokens. */
  auth_delegation_mode: AuthDelegationMode

  /** Self-authored distribution/routing policy the caller should honor when
   *  this shape has multiple producers (see DistributionPolicy). */
  distribution_policy?: DistributionPolicy
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
    resolve_endpoint?: string
    resolve_request_format?: string
    protocol?: string
    status: string
    lastSeen: string
    metadata?: Record<string, unknown>
    distribution_policy?: DistributionPolicy
    libp2p_peer_id?: string
    libp2p_multiaddr?: string[]
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
  /** Advisory (recorded, never enforced) proof-of-possession: base64-encoded Ed25519 public key (32 bytes raw). */
  pubkey?: string
  /** Advisory proof-of-possession: base64 Ed25519 signature over canonical JSON of {vesselId, identity_signed_at, identity_nonce}. */
  identity_signature?: string
  /** Advisory proof-of-possession: nonce used in the identity signature payload. */
  identity_nonce?: string
  /** Advisory proof-of-possession: unix ms timestamp used in the identity signature payload. */
  identity_signed_at?: number
  vesselId: string
  vesselName: string
  version: string
  endpoint: string
  shapes: string[]
  /** OPTIONAL per-shape one-line descriptions (shape id → "produces + when to
   *  use it"). Powers description-based planner matching. Backward-compatible. */
  shape_descriptions?: Record<string, string>
  protocol?: string
  /** libp2p transport advertisement (federation reachability). */
  libp2p_peer_id?: string
  libp2p_multiaddr?: string[]
  orgId?: string
  /** System vessels are accessible to all tenants regardless of orgId. */
  systemVessel?: boolean
  metadata?: Record<string, unknown>
  /** Self-authored distribution/routing policy (see DistributionPolicy). Optional;
   *  normalized to "stateless" at write time. */
  distribution_policy?: DistributionPolicy
  codebase?: {
    accessLevel: "read-write" | "read-only" | "none"
    modifiableBy?: string
  }

  /** Optional host/LAN-reachable URL for callers outside the substrate network. */
  public_endpoint?: string

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

  // --- Auth token source (Wave A3, 2026-04-23, all optional) ---------------
  /** Which credential kind callers should attach. Default: "caller_identity". */
  auth_token_source?: AuthTokenSource
  /** Delegation mode for user-identity tokens. Default: "forward". */
  auth_delegation_mode?: AuthDelegationMode

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
