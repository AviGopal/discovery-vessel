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

interface IdentityValidateSuccess {
  valid: true
  org_id: string
  user_id: string
  key_id: string
  scopes: string[]
}

interface IdentityValidateFailure {
  valid: false
  message?: string
}

type IdentityValidateResponse = IdentityValidateSuccess | IdentityValidateFailure

/**
 * Signature for an identity validator. The default implementation calls
 * the identity-vessel HTTP endpoint. Tests can swap in a mock via
 * `setIdentityValidator()`.
 */
export type IdentityValidator = (apiKey: string) => Promise<AuthContext | null>

// =============================================================================
// PATHS THAT DO NOT REQUIRE AUTHENTICATION
// =============================================================================

export const PUBLIC_PATHS: readonly string[] = [
  "/health",
  "/shapes",
  "/registry/shapes",
  "/registry/stats",
  "/metrics",
  "/metrics/json"
]

// =============================================================================
// IDENTITY VALIDATOR (swappable for testing)
// =============================================================================

const IDENTITY_VESSEL_URL =
  process.env.IDENTITY_VESSEL_URL ?? "https://identity.metabob.com"

/**
 * Default identity validator — calls identity-vessel POST /v1/keys/validate.
 */
async function defaultIdentityValidator(apiKey: string): Promise<AuthContext | null> {
  try {
    const res = await fetch(`${IDENTITY_VESSEL_URL}/v1/keys/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
      signal: AbortSignal.timeout(5000)
    })

    if (!res.ok) {
      return null
    }

    const data = (await res.json()) as IdentityValidateResponse
    if (!data.valid) {
      return null
    }

    return {
      orgId: data.org_id,
      userId: data.user_id,
      keyId: data.key_id,
      scopes: data.scopes
    }
  } catch {
    // Network error or timeout — treat as auth failure
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
    return c.json(
      { error: { code: "INVALID_API_KEY", message: "API key is invalid or has been revoked" } },
      401
    )
  }

  // Store the resolved context so route handlers can retrieve it
  c.set(AUTH_KEY as never, authCtx)
  return next()
}
