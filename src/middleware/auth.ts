/**
 * Authentication Middleware
 *
 * Validates API keys against the identity-vessel before allowing
 * mutation endpoints. Public/read-only paths bypass auth.
 */

import type { Context, Next } from "hono"
import {
  DEFAULT_CREDENTIAL_TTL_MS,
  makeCredentialValidator,
  type ValidationFailure,
  type ValidationOutcome
} from "./credential-cache"

export type { ValidationFailure } from "./credential-cache"

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
  return failureDetail(lastFailure, identityHttpErrorStatus)
}

function failureDetail(failure: ValidationFailure, status: number): string {
  switch (failure) {
    case "identity_http_error":
      return `identity returned ${status}`
    case "rejected":
      return status === 401 || status === 403
        ? `identity rejected the key (HTTP ${status})`
        : "identity rejected the key"
    case "identity_unreachable":
      return "identity unreachable and no cached validation within the grace window"
    case "identity_unconfigured":
      return "identity URL unset: misconfiguration"
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
function identityVesselUrl(): string | null {
  // No built-in fallback: the presented key is sent wherever this points and
  // the answer is trusted, so an unconfigured endpoint means no validation at
  // all (fail closed: a 500 IDENTITY_UNCONFIGURED, no request made), never a default host.
  return process.env.IDENTITY_VESSEL_URL || null
}

// Short-TTL validation cache (credential-cache.ts): discovery sits on every
// vessel's register/heartbeat path, so a fresh HTTP validation per request turns
// identity-vessel latency into fleet-wide 401 churn (timeouts read as revoked
// keys). A recently-validated key stays valid for the TTL without a round-trip;
// when identity is slow or unreachable a previously-valid key is served from
// cache for a bounded grace window (graceful degradation for KNOWN keys:
// unknown keys still fail, and a definitive refusal evicts the entry).

// The TTL is the parent's constant, 60 s (DEFAULT_CREDENTIAL_TTL_MS). It stays a
// constant until someone needs to change it.
let clock: () => number = () => Date.now()

const credentials = makeCredentialValidator<AuthContext>({
  identityUrl: identityVesselUrl,
  ttlMs: DEFAULT_CREDENTIAL_TTL_MS,
  clock: () => clock(),
  principal: (d) => ({ orgId: d.orgId, userId: d.userId, keyId: d.keyId, scopes: d.scopes })
})

/** Tests only: replace the clock the cache ages by (null restores Date.now). */
export function __setAuthClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now())
}
/** Tests only: a fresh process (no cached validation). */
export function __resetAuthStateForTests(): void {
  credentials.clear()
}
/** Tests only: how many validations are cached. */
export function __credentialCacheSizeForTests(): number {
  return credentials.size()
}

/** One validation with its outcome, recording it on the module-level side channel too. */
async function validateWithOutcome(apiKey: string): Promise<ValidationOutcome<AuthContext>> {
  const outcome = await credentials.validate(apiKey)
  if (!outcome.ctx) {
    lastFailure = outcome.failure
    identityHttpErrorStatus = outcome.status
  }
  return outcome
}

/**
 * Default identity validator: identity-vessel POST /v1/auth/resolve through
 * the cache (credential-cache.ts), the same endpoint and request shape as
 * activity-api's validateApiKeyWithFallback.
 */
async function defaultIdentityValidator(apiKey: string): Promise<AuthContext | null> {
  return (await validateWithOutcome(apiKey)).ctx
}

let _identityValidator: IdentityValidator = defaultIdentityValidator

/**
 * Override the identity validator. Useful in tests to avoid real HTTP calls.
 * Restoring the default: `setIdentityValidator(null)`.
 */
export function setIdentityValidator(validator: IdentityValidator | null): void {
  _identityValidator = validator ?? defaultIdentityValidator
}

/** Validate a key with the CURRENT validator (the same one the middleware uses; a test's mock included). */
export function validateApiKeyNow(apiKey: string): Promise<AuthContext | null> {
  return _identityValidator(apiKey)
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
 * Whether a failed validation is identity failing to decide (503) rather than
 * identity refusing the key (401): a 5xx or no answer. A 401/403, a 200 saying
 * not authenticated, and any other 4xx (429 and 408 included) stay refusals.
 */
function identityCouldNotDecide(outcome: ValidationOutcome<AuthContext>): boolean {
  if (outcome.failure === "identity_unreachable") return true
  return outcome.failure === "identity_http_error" && outcome.status >= 500
}

/**
 * Hono middleware that enforces API-key authentication on mutation endpoints.
 *
 * - Public paths (GET read-only endpoints) pass through without a token.
 * - All other paths require `Authorization: ApiKey <key>`.
 * - On success the resolved AuthContext is stored in `c.set("auth", ...)`.
 * - A refused key is a 401 JSON response; identity unable to decide (and no
 *   grace for the key) is a retryable 503; no identity configured is a 500.
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
  // The default validator's outcome is read per call: the module-level side
  // channel can be overwritten by a concurrent request before it is read here.
  let outcome: ValidationOutcome<AuthContext>
  if (_identityValidator === defaultIdentityValidator) {
    outcome = await validateWithOutcome(apiKey)
  } else {
    const ctx = await _identityValidator(apiKey)
    outcome = { ctx, failure: "rejected", status: 0 }
  }
  const authCtx = outcome.ctx

  if (!authCtx && outcome.failure === "identity_unconfigured") {
    // No identity is configured. That is neither a verdict on the key (401)
    // nor a passing fault to retry (503): it is this node's misconfiguration,
    // and it stays until someone sets the identity endpoint.
    const detail = failureDetail(outcome.failure, outcome.status)
    console.error(`[discovery] 500 ${c.req.method} ${normalisedPath} — identity_unconfigured: ${detail}`)
    return c.json(
      {
        error: {
          code: "IDENTITY_UNCONFIGURED",
          message: "this discovery has no identity endpoint configured",
          reason: outcome.failure,
          detail
        }
      },
      500
    )
  }

  if (!authCtx && identityCouldNotDecide(outcome)) {
    // Identity is erroring or unreachable, and this key has no grace. That is
    // no verdict on the key: answer a retryable 503, never a 401, so a caller
    // that exits on a 401 does not restart over identity's state.
    // (ias-executor-ts's vessel daemon draws the same line: refused is 401,
    // identity unavailable is 503.)
    const detail = failureDetail(outcome.failure, outcome.status)
    console.warn(
      `[discovery] 503 ${c.req.method} ${normalisedPath} — ${outcome.failure}: ${detail} (identity=${identityVesselUrl() ?? "unset"})`
    )
    const retryAfter = outcome.retryAfter?.trim()
    if (retryAfter && /^\d+$/.test(retryAfter)) c.header("Retry-After", retryAfter)
    return c.json(
      {
        error: {
          code: "IDENTITY_UNAVAILABLE",
          message: "identity could not validate the key right now; retry",
          reason: outcome.failure,
          detail
        }
      },
      503
    )
  }

  if (!authCtx) {
    // ★ LOG WHY. Discovery sits on every vessel's register/heartbeat path, so
    // its 401s are the fleet's most-produced error — and until now the only
    // record of one was the access log's bare `--> POST /heartbeat 401`, which
    // is identical whether the key was revoked or identity was unreachable.
    // The registry TTL is 5 minutes, so a sustained 401 silently empties the
    // registry; the reason is what tells an operator whether to reissue a
    // credential or repair a network path.
    const failure = outcome.failure
    const detail = failureDetail(outcome.failure, outcome.status)
    console.warn(
      `[discovery] 401 ${c.req.method} ${normalisedPath} — ${failure}: ${detail} (identity=${identityVesselUrl() ?? "unset"})`
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
