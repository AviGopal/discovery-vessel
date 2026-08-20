/**
 * Authentication Middleware
 *
 * Validates API keys against the identity-vessel before allowing
 * mutation endpoints. Public/read-only paths bypass auth.
 */

import type { Context, Next } from "hono"

// =============================================================================
// TYPES
// =============================================================================

export interface AuthContext {
  orgId: string
  userId: string
  keyId: string
  scopes: string[]
}

/**
 * Response shape from identity-vessel POST /v1/auth/resolve.
 * Mirrors the contract used by activity-api's validateApiKeyWithFallback.
 */
interface IdentityResolveResponse {
  success: boolean
  data?: {
    authenticated: boolean
    orgId: string
    accountId?: string
    userId: string
    keyId: string
    scopes: string[]
    reason?: string
  }
}

/**
 * Signature for an identity validator. The default implementation calls
 * the identity-vessel HTTP endpoint. Tests can swap in a mock via
 * `setIdentityValidator()`.
 */
export type IdentityValidator = (apiKey: string) => Promise<AuthContext | null>

/**
 * Why a validation failed, for the 401 log line.
 *
 * A 401 alone cannot distinguish "this key is revoked" from "identity was
 * unreachable and the grace window expired" — and those demand opposite
 * responses: the first is a credential to reissue, the second is a network
 * fault to repair. Measured 2026-08-19: 169 register/heartbeat 401s over 37
 * minutes on the UI spoke, with no reason recorded anywhere. The key was
 * valid the whole time (identity answers `authenticated: true` for it), so
 * every minute spent suspecting the credential was spent on the wrong thing.
 *
 * Set as a side channel rather than widening the `IdentityValidator` return
 * type, so a test validator swapped in via `setIdentityValidator` keeps its
 * existing `AuthContext | null` contract and simply reports "rejected".
 */
export type ValidationFailure =
  /** Identity answered, and said no. The credential itself is bad. */
  | "rejected"
  /** Identity answered non-2xx — it is up but erroring. */
  | "identity_http_error"
  /** Identity unreachable/timed out, and no cached grace to fall back on. */
  | "identity_unreachable"

let lastFailure: ValidationFailure = "rejected"
/** HTTP status behind the most recent `identity_http_error`, for the log line. */
let identityHttpErrorStatus = 0

/**
 * Why the most recent validation failed. Read only on the 401 path, where a
 * `null` from the validator has just been observed.
 */
export function lastValidationFailure(): ValidationFailure {
  return lastFailure
}

/** A human-readable reason for the 401 log line and response body. */
export function lastValidationFailureDetail(): string {
  switch (lastFailure) {
    case "identity_http_error":
      return `identity returned ${identityHttpErrorStatus}`
    case "identity_unreachable":
      return "identity unreachable and no cached validation within the grace window"
    default:
      return "identity rejected the key"
  }
}

// =============================================================================
// PATHS THAT DO NOT REQUIRE AUTHENTICATION
// =============================================================================

export const PUBLIC_PATHS: readonly string[] = [
  "/health",
  // Public by design (point-and-go join): /bootstrap returns only non-secret
  // routing anchors (relay / identity / discovery) a client needs BEFORE it
  // holds a key. Do not remove — keyless bootstrap breaks without this entry.
  "/bootstrap",
  "/shapes",
  "/registry/shapes",
  "/registry/stats",
  "/metrics",
  "/metrics/json"
]

/**
 * Read-only endpoints that are public for GET but require auth for any
 * mutating method. `/registry/shape-descriptions` is public to read (the
 * planner fetches it unauthenticated) but POSTing a LEARNED description is a
 * write and must carry an ApiKey, matching the other registry mutations.
 */
export const PUBLIC_GET_ONLY_PATHS: readonly string[] = [
  "/registry/shape-descriptions",
]

/** Path prefixes treated as public read-only (GET only). */
export const PUBLIC_PATH_PREFIXES: readonly string[] = [
  "/vessels/",
]

// =============================================================================
// IDENTITY VALIDATOR (swappable for testing)
// =============================================================================

/**
 * Read at CALL time, not module-load time.
 *
 * A module-level const captures whatever the env held when the first importer
 * pulled this file in. In the suite that made three tests silently validate
 * against the PUBLIC identity service — they passed alone and failed in the
 * full run, because another test file imported this module first and froze the
 * default. The same hazard exists in production any time a unit rewrites its
 * environment after start. Reading per call costs a property lookup and makes
 * the value honest.
 */
function identityVesselUrl(): string {
  return process.env.IDENTITY_VESSEL_URL ?? "https://identity.metabob.com"
}

// Short-TTL validation cache: discovery sits on every vessel's register/
// heartbeat path, so a fresh HTTP validation per request turns identity-vessel
// latency into fleet-wide 401 churn (timeouts read as revoked keys). A
// recently-validated key stays valid for the TTL without a round-trip; when
// identity is slow or unreachable a previously-valid key is served from cache
// for a bounded grace window (graceful degradation for KNOWN keys — unknown
// keys still fail closed, and a definitive rejection evicts the cache entry).
const VALIDATION_TTL_MS = 60_000
const VALIDATION_GRACE_MS = 600_000
const validationCache = new Map<string, { ctx: AuthContext; at: number }>()

/**
 * Default identity validator — calls identity-vessel POST /v1/auth/resolve.
 *
 * Uses the same endpoint and request shape as activity-api's
 * validateApiKeyWithFallback (the canonical reference implementation).
 * The old /v1/keys/validate path rejects mb-{b64}-{hmac} format keys that
 * /v1/auth/resolve accepts correctly.
 */
async function defaultIdentityValidator(apiKey: string): Promise<AuthContext | null> {
  const now = Date.now()
  const cached = validationCache.get(apiKey)
  if (cached && now - cached.at < VALIDATION_TTL_MS) {
    return cached.ctx
  }
  try {
    const res = await fetch(`${identityVesselUrl()}/v1/auth/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        impulse: {
          type: "authentication",
          pointer: {
            type: "apiKey",
            apiKey
          }
        }
      }),
      signal: AbortSignal.timeout(10000)
    })

    if (!res.ok) {
      lastFailure = "identity_http_error"
      identityHttpErrorStatus = res.status
      // A 5xx is identity FAULTING; a 4xx is identity DECIDING. Only the
      // former may be served from grace.
      //
      // ★ The grace window must never outlive a revocation. `!res.ok` also
      // covers 401/403 — identity's way of saying this key is revoked — and
      // serving those from cache would keep a withdrawn credential working
      // for the full 10-minute window. That is a strictly worse failure than
      // the churn grace exists to prevent, so 4xx evicts exactly as before.
      if (res.status >= 500) {
        if (cached && now - cached.at < VALIDATION_GRACE_MS) {
          return cached.ctx
        }
        return null
      }
      validationCache.delete(apiKey)
      return null
    }

    const data = (await res.json()) as IdentityResolveResponse
    if (!data.success || !data.data?.authenticated) {
      // A definitive answer from identity: this key really is bad. Evict.
      lastFailure = "rejected"
      validationCache.delete(apiKey)
      return null
    }

    const ctx: AuthContext = {
      orgId: data.data.orgId,
      userId: data.data.userId,
      keyId: data.data.keyId,
      scopes: data.data.scopes
    }
    validationCache.set(apiKey, { ctx, at: now })
    return ctx
  } catch {
    // Identity slow/unreachable — serve a known-good key within the grace
    // window rather than churning the registry; unknown keys fail closed.
    lastFailure = "identity_unreachable"
    if (cached && now - cached.at < VALIDATION_GRACE_MS) {
      return cached.ctx
    }
    return null
  }
}

let _identityValidator: IdentityValidator = defaultIdentityValidator

/**
 * Override the identity validator. Useful in tests to avoid real HTTP calls.
 * Restoring the default: `setIdentityValidator(null)`.
 */
export function setIdentityValidator(validator: IdentityValidator | null): void {
  _identityValidator = validator ?? defaultIdentityValidator
}

// =============================================================================
// CONTEXT HELPER
// =============================================================================

const AUTH_KEY = "auth"

/**
 * Retrieve the authenticated context set by `authMiddleware`.
 * Returns `undefined` on public paths where auth was not required.
 */
export function getAuthContext(c: Context): AuthContext {
  const auth = c.get(AUTH_KEY as never) as AuthContext | undefined
  if (!auth) {
    throw new Error("Auth context not set — route is missing authMiddleware or is on a public path")
  }
  return auth
}

/**
 * Retrieve the authenticated context, or `undefined` if not set.
 * Use this on paths where auth is optional (e.g. the self-registration path
 * called internally).
 */
export function getAuthContextOptional(c: Context): AuthContext | undefined {
  return c.get(AUTH_KEY as never) as AuthContext | undefined
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Hono middleware that enforces API-key authentication on mutation endpoints.
 *
 * - Public paths (GET read-only endpoints) pass through without a token.
 * - All other paths require `Authorization: ApiKey <key>`.
 * - On success the resolved AuthContext is stored in `c.set("auth", ...)`.
 * - On failure a 401 JSON response is returned.
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname

  // Strip any trailing slash for normalisation
  const normalisedPath = path.endsWith("/") && path.length > 1
    ? path.slice(0, -1)
    : path

  // Public paths: skip auth entirely when no Authorization header is present.
  // If an Authorization header IS provided we still validate it so callers can
  // optionally authenticate on public paths.
  const isPublic = (PUBLIC_PATHS as string[]).includes(normalisedPath)
    || (c.req.method === "GET" && (PUBLIC_GET_ONLY_PATHS as string[]).includes(normalisedPath))
    || (c.req.method === "GET" && (PUBLIC_PATH_PREFIXES as string[]).some(p => normalisedPath.startsWith(p)))
  const authHeader = c.req.header("Authorization")

  if (isPublic && !authHeader) {
    return next()
  }

  // Require Authorization header on non-public paths
  if (!authHeader) {
    return c.json(
      { error: { code: "INVALID_API_KEY", message: "Authorization header is required" } },
      401
    )
  }

  // Parse `Authorization: ApiKey <key>`
  const match = /^ApiKey\s+(.+)$/i.exec(authHeader)
  if (!match || !match[1]) {
    return c.json(
      { error: { code: "INVALID_API_KEY", message: "Invalid Authorization format; expected 'ApiKey <key>'" } },
      401
    )
  }

  const apiKey = match[1].trim()
  const authCtx = await _identityValidator(apiKey)

  if (!authCtx) {
    // ★ LOG WHY. Discovery sits on every vessel's register/heartbeat path, so
    // its 401s are the fleet's most-produced error — and until now the only
    // record of one was the access log's bare `--> POST /heartbeat 401`, which
    // is identical whether the key was revoked or identity was unreachable.
    // The registry TTL is 5 minutes, so a sustained 401 silently empties the
    // registry; the reason is what tells an operator whether to reissue a
    // credential or repair a network path.
    const failure = lastValidationFailure()
    const detail = lastValidationFailureDetail()
    console.warn(
      `[discovery] 401 ${c.req.method} ${normalisedPath} — ${failure}: ${detail} (identity=${identityVesselUrl()})`
    )
    return c.json(
      {
        error: {
          code: "INVALID_API_KEY",
          message: "API key is invalid or has been revoked",
          // The reason travels to the CALLER too. A vessel logging
          // "discovery register failed: 401" cannot otherwise tell its
          // operator anything about the cause.
          reason: failure,
          detail
        }
      },
      401
    )
  }

  // Store the resolved context so route handlers can retrieve it
  c.set(AUTH_KEY as never, authCtx)
  return next()
}
