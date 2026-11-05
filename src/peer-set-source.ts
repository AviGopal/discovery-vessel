/**
 * ACTIVITY `discovery-vessel:peer-set-source` — a variant-selected, traced peer-set selection step.
 *
 * The forward paths (forwardToPeers, forwardResolveToPeers in index.ts) need a peer SET to fan out to.
 * WHERE that set comes from is a learnable choice, selected per call by a shaped `activityVariantMask`
 * pool record (law 1 — behaviour steered by a shape read at use time), so the choice can be graded by
 * which fan-outs reach:
 *   - variant 0 (control, the operator-seeded baseline): the peer set is the env seed
 *     (PEER_DISCOVERY_ENDPOINTS, via currentPeerEndpoints). Byte-identical to the behaviour before this
 *     activity existed.
 *   - variant 1: the peer set is read from the `substrateNodes` poolImpulse
 *     (body {discovery_endpoints: string[], reason}), LOCAL-ORIGIN producers only, with THIS node dropped
 *     and unmatchable aliases tolerated. If that pool is unreadable or throws, it FAILS OPEN to the env
 *     seed (source "seed_fallback").
 *
 * TRACES. Three records, each with its own reader:
 *   - an OWN execution trace (template = the variant's id, output peerSetSelection) POSTed to activity-api
 *     each time the selection (variant, peer set) CHANGES — the first selection after boot counts;
 *   - a CREDIT trace (discovery-vessel:peer-set-source-credit) on the FIRST fan-out that consumes a
 *     selection: reached iff ≥1 peer in the set answered, chained to the own trace;
 *   - a journal line per call naming variant, source and the set used (the per-call count source).
 *
 * LOCAL-ORIGIN ONLY. Both the mask and substrateNodes are read only from THIS node's own registry rows
 * (a plain, non-libp2p registration — the discovery analogue of gap-policy's origin==="local"; peer rows
 * never live in the registry, and a libp2p row is a facade for a vessel served elsewhere). A mask or node
 * list read through a peer could be written by the very peer it would steer.
 *
 * CACHED ≤30 s, SINGLE-FLIGHT (the TTL gap-policy uses for substrateNodes). These reads sit on the forward
 * hot path; mask windows are hours long, so a flip or node-list change landing ≤30 s late is fine.
 * Concurrent forwards share one in-flight read per shape; each ACTUAL read (a cache miss) logs exactly one
 * `pool_read shape=<shape> ok=<bool>` line; cache hits log nothing. An unreadable result is cached too
 * (fail-open: variant 0 / the seed) so a silent pool is not re-asked by every forward.
 *
 * DEBT: a 2nd copy of the activityVariantMask reader (dv learning-credit.ts, discovery-vessel) and a 2nd
 * copy of the trace-post helper beside it — move both into packages/ together.
 */
import { registry } from "./registry"
import { normalizePeerKey } from "./peer-credentials"
import { endpointIsThisHost, type HostDeps } from "./peer-instance"
import type { VesselRegistration } from "./types"

export type { HostDeps }

export const PEER_SET_SOURCE_ACTIVITY_ID = "discovery-vessel:peer-set-source"
const LOG = "[discovery-vessel:peer-set-source]"
/** The two declared variants: 0 = env read (control), 1 = substrateNodes read. */
const KNOWN_VARIANTS = [0, 1] as const

// PER-VARIANT TEMPLATE/TRACE ids (mirrors build 1's reach-grade base+variant ids). The MASK FILTER uses
// the BASE id (PEER_SET_SOURCE_ACTIVITY_ID) — the base selects the activity; these per-variant ids tag the
// trace/template only. They are byte-identical to the ids in the two template payload files.
const VARIANT_TEMPLATE_IDS = ["discovery-vessel:peer-set-source", "discovery-vessel:peer-set-source-v1"] as const
const CREDIT_TEMPLATE_ID = "discovery-vessel:peer-set-source-credit"
const variantTemplateId = (variant: 0 | 1): string => VARIANT_TEMPLATE_IDS[variant]

export type PeerSetSource = "env" | "substrateNodes" | "seed_fallback"
export interface PeerSetSelection {
  /** The peer endpoints to fan out to (origins, duplicate-free). */
  peers: string[]
  source: PeerSetSource
  variant: 0 | 1
  why: string
  /** The own execution-trace id for THIS selection (the credit's composition_chain / provenance anchor). */
  traceId: string
  /** How many listed substrateNodes entries were dropped as self (variant 1 only). */
  droppedSelf: number
  /** How many listed entries were unparseable and left undialed (variant 1 only). */
  aliasesIgnored: number
}

// ── SELECTION-CHANGE STATE (law 5: event-driven, no timer). A "selection" = (variant, resolved peer set).
// A trace is posted only when the selection CHANGES; the first selection after boot counts as a change.
let lastSelectionKey: string | null = null
let currentOwnTraceId: string | null = null
let creditedOwnTraceId: string | null = null
/** Tests only: forget the selection-change state (a fresh process). */
export function __resetPeerSetSourceStateForTests(): void {
  lastSelectionKey = null
  currentOwnTraceId = null
  creditedOwnTraceId = null
  poolCache.clear()
  poolInflight.clear()
  clock = () => Date.now()
}
/** Tests only: replace the clock the read cache ages by (null restores Date.now). */
export function __setPeerSetSourceClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now())
}

// ── READ CACHE (≤30 s TTL + single-flight, per shape; mirrors gap-policy's SUBSTRATE_NODES_TTL_MS form) ──
const POOL_READ_TTL_MS = 30_000
const poolCache = new Map<string, { at: number; v: unknown; loggedUnknown?: boolean }>()
const poolInflight = new Map<string, Promise<unknown>>()
let clock: () => number = () => Date.now()
/** `load` must not throw. On a miss: one read, one `pool_read` line, the result cached for the TTL. */
async function cachedRead<T>(shape: string, load: () => Promise<T>, ok: (v: T) => boolean): Promise<{ v: T; entry: { loggedUnknown?: boolean } }> {
  const hit = poolCache.get(shape)
  if (hit && clock() - hit.at < POOL_READ_TTL_MS) return { v: hit.v as T, entry: hit }
  let pending = poolInflight.get(shape) as Promise<T> | undefined
  if (!pending) {
    pending = (async () => {
      const v = await load()
      console.log(`${LOG} pool_read shape=${shape} ok=${ok(v)}`)
      poolCache.set(shape, { at: clock(), v })
      return v
    })().finally(() => poolInflight.delete(shape))
    poolInflight.set(shape, pending)
  }
  const v = await pending
  return { v, entry: poolCache.get(shape) ?? {} }
}

const fmt = (set: readonly string[]): string => `[${set.join(", ")}]`

// ── POOL READ (mirrors development-vessel gap-policy.ts readNewestPoolRecord + postEnvelopeRead) ──────
// LOCAL-origin poolImpulse producers in THIS node's registry: a healthy, plain (non-libp2p, non-peer)
// registration — the same predicate localEgressLiveness uses for the self-row.
function localPoolProducerUrls(): string[] {
  return registry
    .findByShape("poolImpulse")
    .filter((v) => v.status === "healthy" && v.protocol !== "libp2p" && v.discoveredVia !== "peer")
    .map(resolveUrlOf)
}
/** The resolve URL of a producer row (mirrors index.ts's forwardUrl build). */
function resolveUrlOf(v: VesselRegistration): string {
  const resolveEndpoint = v.resolve_endpoint ?? "/v2/impulses/resolve"
  return /^https?:\/\//.test(resolveEndpoint) ? resolveEndpoint : `${v.endpoint}${resolveEndpoint}`
}

type PoolRow = { id?: string; shape?: string; updated_at?: string; body?: unknown }
/** The open pool rows of `shape` across every local producer. `ok:false` iff the pool is UNREADABLE — no
 *  local producer, any producer silent/non-2xx/unparseable, or a throw (any-silent-is-unreadable, as
 *  gap-policy). A readable pool with no such row is `ok:true` with an empty list (ABSENT, not unreadable). */
async function readLocalPool(shape: string): Promise<{ ok: true; rows: PoolRow[] } | { ok: false; why: string }> {
  const urls = localPoolProducerUrls()
  if (urls.length === 0) return { ok: false, why: "no local poolImpulse producer" }
  const key = process.env.METABOB_API_KEY ?? ""
  const results = await Promise.all(
    urls.map(async (url): Promise<{ silent: true; url: string } | { silent: false; rows: PoolRow[] }> => {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
          body: JSON.stringify({ impulse: { type: "poolImpulse", shape, status: "open" } }),
          signal: AbortSignal.timeout(3000),
        })
        if (!r.ok) return { silent: true, url }
        const data = (await r.json()) as { body?: { impulses?: unknown } }
        const imps = data?.body?.impulses
        if (!Array.isArray(imps)) return { silent: true, url }
        return { silent: false, rows: imps as PoolRow[] }
      } catch {
        return { silent: true, url }
      }
    }),
  )
  const silent = results.find((x): x is { silent: true; url: string } => x.silent)
  if (silent) return { ok: false, why: `no answer from ${silent.url}` }
  const rows = results.flatMap((x) => (x.silent ? [] : x.rows)).filter((r) => r.shape === shape)
  return { ok: true, rows }
}
const newestFirst = (rows: PoolRow[]): PoolRow[] =>
  [...rows].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))

// ── VARIANT SELECTION (activityVariantMask; dv build-1 semantics, one schema fleet-wide) ─────────────
async function selectVariant(now: number): Promise<{ variant: 0 | 1; why: string }> {
  const { v: read, entry } = await cachedRead(
    "activityVariantMask",
    async (): Promise<Awaited<ReturnType<typeof readLocalPool>>> => {
      let r: Awaited<ReturnType<typeof readLocalPool>>
      try {
        r = await readLocalPool("activityVariantMask")
      } catch (err) {
        r = { ok: false, why: String((err as Error)?.message ?? err) }
      }
      // Pool unreadable/throws → variant-0 AND log (never silent) — once per READ, not per forward.
      if (!r.ok) console.log(`${LOG} mask_unread (${r.why}): variant-0`)
      return r
    },
    (r) => r.ok,
  )
  if (!read.ok) return { variant: 0, why: `mask unreadable (${read.why})` }
  // Newest first; the FIRST in-force row for this activity wins. In force iff from/until both parse
  // (Date.parse) and the window is half-open: from <= now < until.
  const inForce = newestFirst(read.rows).filter((r) => {
    const b = (r.body ?? {}) as Record<string, unknown>
    if (b.activity_id !== PEER_SET_SOURCE_ACTIVITY_ID) return false
    const from = Date.parse(String(b.from))
    const until = Date.parse(String(b.until))
    return Number.isFinite(from) && Number.isFinite(until) && from <= now && now < until
  })
  const row = inForce[0]
  if (!row) return { variant: 0, why: "no mask in force: variant-0" }
  const b = (row.body ?? {}) as Record<string, unknown>
  const av = b.active_variant
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : ""
  // active_variant must be a NUMBER in {0,1}. Any other value (a string "v0"/"v1" included) is UNKNOWN.
  if (typeof av === "number" && (KNOWN_VARIANTS as readonly number[]).includes(av)) {
    return { variant: av as 0 | 1, why: reason || `mask active_variant=${av}` }
  }
  if (!entry.loggedUnknown) {
    entry.loggedUnknown = true // once per read, not per forward
    console.log(`${LOG} mask ${String(row.id ?? row.updated_at ?? "?")} names unknown variant`)
  }
  return { variant: 0, why: `mask names unknown variant (${JSON.stringify(av)}): variant-0` }
}

// ── SELF-DROP (variant 1): the node's own endpoint under every form it is listed as ──────────────────
/** host:port self-forms this node knows itself by (normalized origins). Loopback and interface-level
 *  self-matching is left to endpointIsThisHost; the in-container alias and node identity are matched by
 *  host in matchesNodeIdentity. */
function selfEndpointKeys(): Set<string> {
  const self = registry.get(process.env.DISCOVERY_VESSEL_ID ?? "discovery-vessel")
  const candidates: Array<string | undefined> = [
    process.env.DISCOVERY_SELF_ENDPOINT,
    process.env.DISCOVERY_PUBLIC_URL,
    self?.endpoint,
    self?.public_endpoint,
  ]
  const keys = new Set<string>()
  for (const c of candidates) {
    if (!c) continue
    const k = normalizePeerKey(c)
    if (k) keys.add(k)
  }
  return keys
}
/** The node-identity host aliases: SUBSTRATE_NAME names the container <name>-live, so this node is also
 *  reachable (and may be listed by a peer's record as a SECOND alias) at host `<name>-live`. */
function nodeIdentityHosts(): string[] {
  const name = (process.env.SUBSTRATE_NAME ?? "").trim()
  return name ? [name.toLowerCase(), `${name.toLowerCase()}-live`] : []
}
function matchesNodeIdentity(originKey: string, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return false
  try {
    const host = new URL(originKey).hostname.toLowerCase()
    return hosts.includes(host)
  } catch {
    return false
  }
}

// ── substrateNodes READ (variant 1) ──────────────────────────────────────────────────────────────────
/**
 * The peer set from the newest LOCAL-origin substrateNodes record, self dropped, unmatchable aliases
 * tolerated. THREE DISTINCT cases (qa+research amendment):
 *   - "unreadable": the POOL could not be read (no local producer / silent / non-2xx / unparseable / throw).
 *   - "absent":     the pool was readable but holds NO substrateNodes record. Absent is UNKNOWN, not
 *                   "no peers" — the caller fails OPEN to the seed and names it explicitly.
 *   - "present":    a record was read; `endpoints` is it, self dropped (possibly empty if all were self).
 */
type SubstrateNodesRead =
  | { kind: "unreadable"; why: string }
  | { kind: "absent" }
  | { kind: "present"; endpoints: string[]; droppedSelf: number; aliasesIgnored: number }
async function readSubstrateNodesPeers(hostDeps?: HostDeps): Promise<SubstrateNodesRead> {
  // Cached as a whole (self-drop incl. endpointIsThisHost's DNS runs once per read, not per forward).
  const { v } = await cachedRead(
    "substrateNodes",
    async () => {
      try {
        return await loadSubstrateNodesPeers(hostDeps)
      } catch (err) {
        return { kind: "unreadable", why: String((err as Error)?.message ?? err) } as SubstrateNodesRead
      }
    },
    (r) => r.kind !== "unreadable",
  )
  return v
}
async function loadSubstrateNodesPeers(hostDeps?: HostDeps): Promise<SubstrateNodesRead> {
  let read: Awaited<ReturnType<typeof readLocalPool>>
  try {
    read = await readLocalPool("substrateNodes")
  } catch (err) {
    return { kind: "unreadable", why: String((err as Error)?.message ?? err) }
  }
  if (!read.ok) return { kind: "unreadable", why: read.why }
  const newest = newestFirst(read.rows)[0]
  if (!newest) return { kind: "absent" }
  const raw = (newest.body as { discovery_endpoints?: unknown } | undefined)?.discovery_endpoints
  const listed = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0) : []
  const selfKeys = selfEndpointKeys()
  const identityHosts = nodeIdentityHosts()
  const kept: string[] = []
  const seen = new Set<string>()
  let droppedSelf = 0
  let aliasesIgnored = 0
  for (const entry of listed) {
    const key = normalizePeerKey(entry)
    // TOLERATE unknown aliases: an entry we cannot parse into a dialable origin is never dialed, but it
    // does not make the set unusable — keep going with the rest.
    if (!key) {
      aliasesIgnored++
      console.log(`${LOG} substrateNodes: unmatchable alias not dialed`)
      continue
    }
    if (selfKeys.has(key) || matchesNodeIdentity(key, identityHosts) || (await endpointIsThisHost(entry, hostDeps))) {
      droppedSelf++ // host:port self, in-container alias / node identity, or loopback / interface-level self
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(key)
  }
  return { kind: "present", endpoints: kept, droppedSelf, aliasesIgnored }
}

// ── THE SELECTION ────────────────────────────────────────────────────────────────────────────────────
/**
 * Select the peer set to fan out to, and record the source + set-used (the trace the grade reads).
 * `seed` is the env peer set (currentPeerEndpoints()) — the variant-0 body and the fail-open seed.
 */
export async function selectPeerSet(
  seed: string[],
  now: number = Date.now(),
  hostDeps?: HostDeps,
): Promise<PeerSetSelection> {
  const sel = await selectVariant(now)
  let peers: string[]
  let source: PeerSetSource
  let why: string
  let droppedSelf = 0
  let aliasesIgnored = 0
  if (sel.variant === 0) {
    peers = seed
    source = "env"
    why = sel.why
    console.log(`${LOG} variant=0 source=env (${why}) set=${fmt(peers)}`)
  } else {
    const nodes = await readSubstrateNodesPeers(hostDeps)
    if (nodes.kind === "unreadable") {
      // FAIL OPEN: the substrateNodes pool could not be read — use the env seed.
      peers = seed
      source = "seed_fallback"
      why = `substrateNodes unreadable: ${nodes.why}`
      console.log(`${LOG} variant=1 source=seed_fallback (${why}; using env seed) set=${fmt(peers)}`)
    } else if (nodes.kind === "absent") {
      // FAIL OPEN: a readable pool with no substrateNodes record — absent is UNKNOWN, not "no peers".
      peers = seed
      source = "seed_fallback"
      why = "substrateNodes record absent"
      console.log(`${LOG} variant=1 source=seed_fallback (${why}; using env seed) set=${fmt(peers)}`)
    } else {
      // A record was read; the set is it, self dropped (possibly empty when every entry was self).
      peers = nodes.endpoints
      source = "substrateNodes"
      why = sel.why
      droppedSelf = nodes.droppedSelf
      aliasesIgnored = nodes.aliasesIgnored
      console.log(`${LOG} variant=1 source=substrateNodes (${why}) set=${fmt(peers)}`)
    }
  }
  // SELECTION CHANGE → own execution trace (law 5: only on change; the first selection after boot counts).
  const key = `${sel.variant}|${source}|${[...peers].sort().join(",")}`
  if (key !== lastSelectionKey) {
    lastSelectionKey = key
    currentOwnTraceId = crypto.randomUUID()
    creditedOwnTraceId = null // a new selection — its consumption is not yet credited
    void postOwnTrace({ variant: sel.variant, source, peers, why, droppedSelf, aliasesIgnored, traceId: currentOwnTraceId })
  }
  return { peers, source, variant: sel.variant, why, traceId: currentOwnTraceId!, droppedSelf, aliasesIgnored }
}

// ── EXECUTION TRACES (discovery has no trace-store client; a POST to activity-api is its own trace). ────
/** activity-api's base URL, resolved through discovery's OWN registry (the routing fixed point) by a shape
 *  activity-api serves, with ACTIVITY_API_ENDPOINT as a bootstrap fallback only. Null when neither answers. */
function activityApiBase(): string | null {
  const row = registry
    .findByShape("executionTraces")
    .find((v) => v.status === "healthy" && v.protocol !== "libp2p" && v.discoveredVia !== "peer")
  const base = row?.endpoint ?? process.env.ACTIVITY_API_ENDPOINT
  return base ? base.replace(/\/+$/, "") : null
}
/** POST one trace to activity-api. FAIL-OPEN: never throws, never blocks the fan-out (mirrors light-dispatch
 *  postTrace / build 1's emitReachGradeTraces). */
async function postTrace(trace: Record<string, unknown>): Promise<void> {
  const base = activityApiBase()
  if (!base) {
    console.warn(`${LOG} trace POST skipped: activity-api not resolvable (no executionTraces producer, no ACTIVITY_API_ENDPOINT)`)
    return
  }
  const token = process.env.METABOB_API_KEY ?? ""
  try {
    const res = await fetch(`${base}/v2/activities/execution-traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `ApiKey ${token}` } : {}) },
      body: JSON.stringify(trace),
      signal: AbortSignal.timeout(10_000),
    })
    try { await res.body?.cancel() } catch { /* swallow */ }
    if (!res.ok) console.warn(`${LOG} trace POST HTTP ${res.status}`)
  } catch (err) {
    console.warn(`${LOG} trace POST failed: ${String((err as Error)?.message ?? err)}`)
  }
}
/** The OWN trace of a selection: one deterministic task, output shape peerSetSelection, tagged by the variant's id. */
async function postOwnTrace(m: {
  variant: 0 | 1
  source: PeerSetSource
  peers: string[]
  why: string
  droppedSelf: number
  aliasesIgnored: number
  traceId: string
}): Promise<void> {
  const templateId = variantTemplateId(m.variant)
  await postTrace({
    execution_id: m.traceId, // activity-api keeps the caller's execution_id
    template_id: templateId,
    activity_id: templateId,
    activity_variant_id: templateId,
    status: "completed",
    success: true,
    output_shapes: ["peerSetSelection"],
    tasks: [{ id: "select_peer_set", resolver_id: "deterministic", success: true }],
    tags: [`variant_role:${m.variant === 0 ? "control" : "treatment"}`, "reach_decided_by:consumer"],
    metadata: {
      variant: m.variant,
      source: m.source,
      peers: m.peers,
      dropped_self: m.droppedSelf,
      aliases_ignored: m.aliasesIgnored,
      mask_why: m.why,
    },
  })
}

/**
 * GRADE BY CONSUMPTION (law 2, event-driven — no timer, no count constant). On the FIRST fan-out that USES a
 * selection, post a credit trace that consumes the selection's own trace: reached iff ≥1 peer in the set
 * answered the fan-out, else failure_mode verifier_negative. Idempotent per selection (the own trace id is
 * credited at most once). Fail-open; never blocks the fan-out.
 */
export async function recordPeerSetConsumption(selection: PeerSetSelection, reached: boolean): Promise<void> {
  const ownTraceId = selection.traceId
  if (!ownTraceId || creditedOwnTraceId === ownTraceId) return
  creditedOwnTraceId = ownTraceId
  await postTrace({
    execution_id: crypto.randomUUID(),
    template_id: CREDIT_TEMPLATE_ID,
    activity_id: CREDIT_TEMPLATE_ID,
    activity_variant_id: CREDIT_TEMPLATE_ID,
    status: "completed",
    success: true,
    reached, // judgeReachVerdict reads the body's `reached` boolean directly
    failure_mode: reached ? null : { type: "verifier_negative", reason: "no peer in the selected set answered the fan-out" },
    composition_chain: [ownTraceId],
    output_shapes: [],
    tasks: [
      {
        id: "grade_peer_set_consumption",
        resolver_id: "deterministic",
        success: true,
        // consumed_provenance is a per-task field: the own selection trace is the consumed producer.
        consumed_provenance: [{ impulse_id: "peerSetSelection", producer_execution_id: ownTraceId, origin: variantTemplateId(selection.variant) }],
      },
    ],
    tags: ["reach_decided_by:consumer"],
    metadata: { reached, source: selection.source, variant: selection.variant, peers: selection.peers },
  })
}
