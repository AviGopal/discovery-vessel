/**
 * Per-peer credentials for discovery federation.
 *
 * A peer discovery endpoint is a door into ANOTHER substrate, and each substrate
 * signs its own keys. A single credential for every peer therefore cannot work
 * once a node peers with two substrates that sign differently: whichever key is
 * sent, one of them rejects it. So each peer gets the credential mapped to it.
 *
 *   PEER_CREDENTIALS="http://syzygy.host:18100=SYZYGY_PEER_API_KEY,http://other:18100=OTHER_PEER_API_KEY"
 *
 * The map names WHICH env var holds the key for WHICH peer; it never holds a key.
 * The value is read from the environment at use time (the same convention as the
 * llm-resolver's `apiKeyEnv`), so secret material stays in the env/secret files
 * and the map itself is safe to log, persist and show.
 *
 * Resolution, per peer:
 *   - peer IS in the map, its var is set and non-empty → `ApiKey <value>`.
 *   - peer IS in the map, its var is missing, empty or not a valid name →
 *     FAIL CLOSED: the peer is not contacted at all. Falling back to a default
 *     key here would hand a credential meant for one party to another.
 *   - peer is NOT in the map → unchanged behaviour: `ApiKey $HUB_API_KEY` when
 *     set, otherwise the caller's own Authorization header.
 *
 * A map entry whose endpoint cannot be parsed cannot be attached to any peer;
 * it is logged once and ignored, which leaves that peer on today's fallback.
 *
 * Every forwarded peer call goes through `postToPeer`, so there is exactly one
 * place that builds a peer request and one place that chooses its credential.
 *
 * Nothing in this module logs, returns in a descriptor, or throws a credential
 * VALUE: logs carry the peer origin and the env var NAME only.
 */

/** Where a peer request's credential came from — a label, never a value. */
export type CredentialSource = `map:${string}` | "HUB_API_KEY" | "caller" | "none"

export type PeerAuthorization =
  | { ok: true; header: string | undefined; source: CredentialSource }
  | { ok: false; reason: string; source: CredentialSource }

type Env = Record<string, string | undefined>

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Normalise a peer endpoint to its origin (lower-cased scheme and host, default
 * port elided), so `http://H:18100`, `http://H:18100/` and `HTTP://H:18100/x`
 * all name the same peer. Returns undefined for anything without a usable
 * http(s) origin — `new URL("host:18100").origin` is the string "null".
 */
export function normalizePeerKey(endpoint: string): string | undefined {
  const s = endpoint.trim()
  if (!s) return undefined
  try {
    const u = new URL(s)
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    if (!u.origin || u.origin === "null") return undefined
    return u.origin
  } catch {
    return undefined
  }
}

export interface PeerCredentialMap {
  /** normalised peer origin → env var NAME holding that peer's key */
  byPeer: Map<string, string>
  /** entries that could not be parsed, as human-readable problems (no values) */
  malformed: string[]
}

/** Parse `endpoint=VAR_NAME` pairs separated by commas. Values are never read here. */
export function parsePeerCredentialMap(raw: string | undefined): PeerCredentialMap {
  const byPeer = new Map<string, string>()
  const malformed: string[] = []
  // Problems name the entry by POSITION, never by echoing it: an operator who
  // pastes a key where a var name belongs must not see it reach the journal.
  for (const [i, part] of (raw ?? "").split(",").entries()) {
    const entry = part.trim()
    if (!entry) continue
    const eq = entry.lastIndexOf("=")
    if (eq <= 0) {
      malformed.push(`entry #${i + 1} has no '=' separating endpoint and env var name`)
      continue
    }
    const endpoint = entry.slice(0, eq).trim()
    const varName = entry.slice(eq + 1).trim()
    const key = normalizePeerKey(endpoint)
    if (!key) {
      malformed.push(`entry #${i + 1} endpoint is not an http(s) URL`)
      continue
    }
    // A bad var name still MAPS the peer: the operator meant this peer to have its
    // own credential, so it must fail closed rather than fall back to a default.
    byPeer.set(key, varName)
  }
  return { byPeer, malformed }
}

const loggedOnce = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (loggedOnce.has(key)) return
  loggedOnce.add(key)
  console.warn(message)
}

/** Decide the Authorization header for one peer. Read at use time (law 1). */
export function peerAuthorization(
  peer: string,
  callerHeader: string | undefined,
  env: Env = process.env,
): PeerAuthorization {
  const map = parsePeerCredentialMap(env.PEER_CREDENTIALS)
  for (const problem of map.malformed) {
    warnOnce(`malformed|${problem}`, `[discovery] PEER_CREDENTIALS: ignoring malformed entry (${problem})`)
  }
  const key = normalizePeerKey(peer)
  const varName = key ? map.byPeer.get(key) : undefined
  if (key && varName !== undefined) {
    if (!ENV_NAME.test(varName)) {
      // The bad name is NOT echoed: it may be a key pasted where a name belongs.
      const reason = `PEER_CREDENTIALS maps ${key} to something that is not a valid env var name`
      warnOnce(`badname|${key}`, `[discovery] ${reason}; not forwarding to this peer`)
      return { ok: false, reason, source: "map:<invalid-name>" }
    }
    const source: CredentialSource = `map:${varName}`
    const value = (env[varName] ?? "").trim()
    if (!value) {
      const reason = `PEER_CREDENTIALS maps ${key} to ${varName}, which is unset or empty`
      warnOnce(`missing|${key}|${varName}`, `[discovery] ${reason}; not forwarding to this peer`)
      return { ok: false, reason, source }
    }
    return { ok: true, header: `ApiKey ${value}`, source }
  }
  // Unmapped peer: exactly the pre-map behaviour.
  if (env.HUB_API_KEY) return { ok: true, header: `ApiKey ${env.HUB_API_KEY}`, source: "HUB_API_KEY" }
  return { ok: true, header: callerHeader, source: callerHeader ? "caller" : "none" }
}

// ── Rejection visibility ────────────────────────────────────────────────────
// A peer that rejects our credential is otherwise invisible from this side. One
// line per peer per window says so (origin, status, credential SOURCE label).
// This does not change how the caller treats the response.
export const REJECTION_LOG_WINDOW_MS = 10 * 60 * 1000
const lastRejectionLog = new Map<string, number>()
let now: () => number = () => Date.now()

function noteRejection(peer: string, status: number, source: CredentialSource): void {
  const key = normalizePeerKey(peer) ?? peer
  const t = now()
  const last = lastRejectionLog.get(key)
  if (last !== undefined && t - last < REJECTION_LOG_WINDOW_MS) return
  lastRejectionLog.set(key, t)
  console.warn(`[discovery] peer ${key} rejected our credential (HTTP ${status}, credential source: ${source})`)
}

export interface PostToPeerArgs {
  peer: string
  pointer: unknown
  depth: number
  authHeader: string | undefined
  timeoutMs: number
}

/**
 * The single peer-forwarding request. Returns the peer's Response, or undefined
 * when the peer must not be contacted (mapped credential unavailable). Network
 * errors propagate exactly as a bare fetch would, so callers keep their handling.
 */
export async function postToPeer(args: PostToPeerArgs): Promise<Response | undefined> {
  const auth = peerAuthorization(args.peer, args.authHeader)
  if (!auth.ok) return undefined
  const res = await fetch(`${args.peer.replace(/\/$/, "")}/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Increment the hop count so a forwarded query can't recurse past MAX_PEER_DEPTH.
      "X-Discovery-Depth": String(args.depth + 1),
      ...(auth.header ? { Authorization: auth.header } : {}),
    },
    body: JSON.stringify({ pointer: args.pointer }),
    signal: AbortSignal.timeout(args.timeoutMs),
    // A peer /resolve has no reason to redirect. Refusing redirects keeps the
    // credential confined to the peer it was mapped to, instead of resting on the
    // runtime's cross-origin header-stripping default (which differs by Bun
    // version). A redirect throws here, which callers already treat as a peer failure.
    redirect: "error",
  })
  if (res.status === 401 || res.status === 403) noteRejection(args.peer, res.status, auth.source)
  return res
}

/** Test seam: reset log-once and rate-limit state, optionally inject a clock. */
export function __resetPeerCredentialState(clock?: () => number): void {
  loggedOnce.clear()
  lastRejectionLog.clear()
  now = clock ?? (() => Date.now())
}
