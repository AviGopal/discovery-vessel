/**
 * CREDENTIAL VALIDATION WITH A BOUNDED POSITIVE CACHE.
 *
 * One credential check against identity-vessel (POST /v1/auth/resolve), with
 * the cache and grace rules the fleet's validators share. Self-contained (no
 * import from the rest of discovery) so it can be lifted into a shared package
 * once a vessel can import one on a live node; until then discovery carries it.
 * Prior art lifted, not reinvented: development-vessel's caller-credential
 * (copied into human-surface-vessel and goal-host-vessel), whose cache this
 * follows, and ias-executor-ts's vessel daemon.
 *
 * CACHE.
 *   - Only a POSITIVE answer is cached. A refusal, an error or silence is never
 *     cached, and a definitive refusal evicts the entry at once.
 *   - The map key is sha256 over the audience (the identity endpoint that gave
 *     the answer) and the full credential. The raw credential is not retained,
 *     no prefix of it keys anything, and an answer from one identity never
 *     stands in for another's. The digest never leaves this module.
 *   - A positive answer is reused for `ttlMs` (60 s unless the caller says).
 *   - REVOCATION LAG IS AT MOST THE TTL: within it no identity call is made, so
 *     identity has no way to say a key was revoked. The first check after the
 *     TTL asks identity, and a refusal then evicts.
 *   - GRACE: when identity is slow, unreachable, 5xx-ing, or answering 429
 *     or 408 (rate limit, timeout: no verdict on the key), a key whose
 *     positive entry is younger than `graceMs` is served from it. Serving from
 *     grace never refreshes the entry, so a sustained fault cannot keep a key
 *     alive past the grace window.
 *   - BOUNDED: an insert sweeps every entry older than the grace window (it can
 *     serve nothing any more), a check sweeps the entry it consults when that
 *     entry is past grace, and past `maxEntries` evicts the oldest first
 *     (Map keeps insertion order; a refresh re-inserts).
 *
 * ONE QUESTION IN FLIGHT PER KEY. A check that must ask identity while an
 * identical one (same map key: the audience and the full credential) is
 * already asking awaits that answer instead of sending its own, so a burst of
 * requests on one key after its TTL, or on an unknown key, is one identity
 * call rather than one per request (federation's ingress validator keys its
 * flights the same way). The flight is dropped when it settles, whatever the
 * answer, so the next check after it asks again; what an answer decides
 * (cache, evict, grace) is unchanged.
 */
import { createHash } from "node:crypto"

/**
 * Whether identity's non-2xx answer is no verdict on the key: it is faulting (5xx), limiting its rate (429) or timed
 * out (408). Such an answer is retried, never a refusal, and a known key is served from grace through it.
 */
export const identityUndecided = (status: number): boolean => status >= 500 || status === 429 || status === 408

/** Why a check failed. */
export type ValidationFailure =
  /** Identity answered, and said no. The credential itself is bad. */
  | "rejected"
  /** Identity answered non-2xx: it is up but erroring. */
  | "identity_http_error"
  /** Identity unreachable/timed out, and no cached grace to fall back on. */
  | "identity_unreachable"
  /** No identity is configured: a misconfiguration, not a fault and not a refusal. No request is made. */
  | "identity_unconfigured"

/** One check's result, carried per call so a concurrent check cannot change what this one answers. */
export interface ValidationOutcome<T> {
  ctx: T | null
  /** Meaningful only when `ctx` is null. */
  failure: ValidationFailure
  /** Identity's HTTP status behind the failure (0 when it did not answer). */
  status: number
  /** Identity's own Retry-After on a 5xx, for the caller to pass on. */
  retryAfter?: string
}

/** What identity's /v1/auth/resolve answers. */
export interface IdentityResolveResponse {
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

export const DEFAULT_CREDENTIAL_TTL_MS = 60_000
export const DEFAULT_CREDENTIAL_GRACE_MS = 600_000
export const DEFAULT_CREDENTIAL_CACHE_MAX_ENTRIES = 256

export interface CredentialValidatorOptions<T> {
  /** The identity base URL, read per check; null means not configured (no request is made). */
  identityUrl: () => string | null
  /** How long a positive answer is reused (default DEFAULT_CREDENTIAL_TTL_MS). */
  ttlMs?: number
  /** Maps identity's authenticated answer to the principal the caller keeps. */
  principal: (data: NonNullable<IdentityResolveResponse["data"]>) => T
  graceMs?: number
  maxEntries?: number
  clock?: () => number
  timeoutMs?: number
}

export interface CredentialValidator<T> {
  validate(apiKey: string): Promise<ValidationOutcome<T>>
  /** Forget every entry. */
  clear(): void
  /** How many entries are held (for tests and bounds). */
  size(): number
}

export function credentialCacheKey(audience: string, apiKey: string): string {
  return createHash("sha256").update(audience).update("\0").update(apiKey).digest("hex")
}

export function makeCredentialValidator<T>(opts: CredentialValidatorOptions<T>): CredentialValidator<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_CREDENTIAL_TTL_MS
  const graceMs = opts.graceMs ?? DEFAULT_CREDENTIAL_GRACE_MS
  const maxEntries = opts.maxEntries ?? DEFAULT_CREDENTIAL_CACHE_MAX_ENTRIES
  const clock = opts.clock ?? (() => Date.now())
  const timeoutMs = opts.timeoutMs ?? 10_000
  const entries = new Map<string, { ctx: T; at: number }>()
  const inFlight = new Map<string, Promise<ValidationOutcome<T>>>()

  function remember(key: string, ctx: T, now: number): void {
    for (const [k, e] of entries) if (now - e.at >= graceMs) entries.delete(k)
    entries.delete(key)
    entries.set(key, { ctx, at: now })
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  async function validate(apiKey: string): Promise<ValidationOutcome<T>> {
    const now = clock()
    const base = opts.identityUrl()
    const key = base ? credentialCacheKey(base, apiKey) : null
    let cached = key ? entries.get(key) : undefined
    // Swept when consulted, as on insert: an entry past grace serves nothing,
    // and a quiet discovery (no inserts) must not keep holding it.
    if (cached && key && now - cached.at >= graceMs) {
      entries.delete(key)
      cached = undefined
    }
    const inGrace = !!cached && now - cached.at < graceMs
    if (cached && now - cached.at < ttlMs) {
      return { ctx: cached.ctx, failure: "rejected", status: 0 }
    }
    if (!base || !key) return { ctx: null, failure: "identity_unconfigured", status: 0 }
    const asking = inFlight.get(key)
    if (asking) return asking
    const flight = ask(apiKey, base, key, cached, inGrace, now).finally(() => inFlight.delete(key))
    inFlight.set(key, flight)
    return flight
  }

  async function ask(apiKey: string, base: string, key: string, cached: { ctx: T; at: number } | undefined, inGrace: boolean, now: number): Promise<ValidationOutcome<T>> {
    try {
      const res = await fetch(`${base}/v1/auth/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impulse: { type: "authentication", pointer: { type: "apiKey", apiKey } } }),
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!res.ok) {
        // A 401/403 is identity REFUSING the key, expressed as a status code
        // (identity answers a bad key with HTTP 401, not 200 + authenticated:
        // false). It evicts at once, so grace can never outlive a revocation.
        if (res.status === 401 || res.status === 403) {
          entries.delete(key)
          return { ctx: null, failure: "rejected", status: res.status }
        }
        // A 5xx, 429 or 408 is identity not deciding; a known key is served from grace, and the entry is kept.
        if (identityUndecided(res.status)) {
          if (inGrace) return { ctx: cached!.ctx, failure: "identity_http_error", status: res.status }
          const retryAfter = res.headers.get("Retry-After") ?? undefined
          return { ctx: null, failure: "identity_http_error", status: res.status, retryAfter }
        }
        // Any other 4xx is identity DECIDING: evict.
        entries.delete(key)
        return { ctx: null, failure: "identity_http_error", status: res.status }
      }

      const data = (await res.json()) as IdentityResolveResponse
      if (!data.success || !data.data?.authenticated) {
        // A definitive refusal: evict, and cache nothing.
        entries.delete(key)
        return { ctx: null, failure: "rejected", status: 0 }
      }
      const ctx = opts.principal(data.data)
      remember(key, ctx, now)
      return { ctx, failure: "rejected", status: 0 }
    } catch {
      // Identity slow/unreachable: a known key is served from grace rather
      // than churning the registry; an unknown key fails.
      if (inGrace) return { ctx: cached!.ctx, failure: "identity_unreachable", status: 0 }
      return { ctx: null, failure: "identity_unreachable", status: 0 }
    }
  }

  return { validate, clear: () => entries.clear(), size: () => entries.size }
}
