/**
 * HELD SHAPES ROUTE TO THEIR HOLDER (2026-10-17; user ruling "Build the full fix before RUN 2").
 *
 * distribution_policy is PER ROW, so a vessel serving ~250 shapes could not say that a few of them read data it HOLDS (the
 * gap store, the memory store) while the rest are interchangeable; and the /resolve pick took the FIRST pinned row in
 * registration order, ahead of the direct-local preference, so pinning a row could route to a PEER after a restart.
 * Now a producer may advertise PER-SHAPE policies (`shape_policies: {shape: {distribution_policy, holder}}`), and for a
 * shape any candidate pins as held data (stateful_data_owner_pin):
 *   - a LOCAL (direct, non-libp2p) row is chosen first, whatever the registration order;
 *   - with no local row, a peer row is REFUSED with a named reason: a held shape is reached through the node's own
 *     producer, which forwards to its designated holder by its own configured route (a spoke's dev-vessel forwards its
 *     gap reads and writes to the holder), never through any peer that merely advertises the shape;
 *   - a shape no candidate pins is chosen exactly as before (stateless: any; firstPolicyOwner/firstDirect unchanged).
 * The DETECTOR (law 6): a row that advertises a held shape as stateless while another row pins it is a MISMATCH, flagged
 * on the routing record, so the next false advertisement is caught without us.
 */
export type ShapePolicy = { distribution_policy: string; holder?: string }
export interface RoutableRow {
  vesselId: string
  protocol?: unknown
  distribution_policy?: string
  shape_policies?: Record<string, ShapePolicy>
}

export const HELD = "stateful_data_owner_pin"
export const policyForShape = (row: RoutableRow, shape: string): string =>
  String(row.shape_policies?.[shape]?.distribution_policy ?? row.distribution_policy ?? "stateless")
const isDirect = (row: RoutableRow) => row.protocol !== "libp2p"

export type HeldPick<R extends RoutableRow> =
  | { kind: "not_held" }
  | { kind: "held"; target: R; reason: string; mismatched: string[] }
  | { kind: "refused"; reason: string; mismatched: string[] }

/** The pick for a shape that some candidate pins as held data; `not_held` leaves the existing selector in charge. */
export function pickHeldShapeProducer<R extends RoutableRow>(shape: string, candidates: readonly R[]): HeldPick<R> {
  const pinned = candidates.filter((c) => c.shape_policies?.[shape]?.distribution_policy === HELD)
  if (pinned.length === 0) return { kind: "not_held" }
  // Rows that serve the same shape but advertise it as interchangeable while another producer holds its data.
  const mismatched = candidates.filter((c) => !c.shape_policies?.[shape] && policyForShape(c, shape) !== HELD).map((c) => c.vesselId)
  const local = pinned.find(isDirect)
  if (local) return { kind: "held", target: local, reason: "held shape: the local holder row", mismatched }
  // No local producer (a profile with no dev-vessel, e.g. surface or hub-minimal): reach the HOLDER itself, i.e. the one
  // peer row whose holder names its own row (a store it holds, not a forwarder's "designated-holder"). Exactly one is
  // required: several holders are separate authorities, and choosing among them is not this router's call.
  const holders = pinned.filter((c) => isHolderRow(c, shape))
  if (holders.length === 1) return { kind: "held", target: holders[0]!, reason: "held shape: no local producer; the peer row that holds the data", mismatched }
  return { kind: "refused", reason: holders.length === 0
    ? `held shape ${shape}: no local producer, and no peer row holds the data (only forwarders or non-holders advertise it)`
    : `held shape ${shape}: no local producer, and ${holders.length} peer rows each hold their own data (separate authorities)`, mismatched }
}

/** A row that HOLDS the shape's data: its holder names the row's own vessel (store@<vesselId-without-@suffix>). */
export function isHolderRow(row: RoutableRow, shape: string): boolean {
  const h = row.shape_policies?.[shape]?.holder ?? ""
  const at = h.indexOf("@")
  if (at < 0) return false
  const who = h.slice(at + 1)
  if (!who || who === "designated-holder") return false
  const base = row.vesselId.split("@")[0]
  return who === row.vesselId || who === base
}

/** One routing record per forwarded resolve (the chosen row names itself; a mismatch is flagged). */
export function routingRecord(shape: string, row: RoutableRow | null, why: string, mismatched: readonly string[] = []): string {
  const r = row ? `${row.vesselId} (${isDirect(row) ? "direct" : "libp2p"}, ${policyForShape(row, shape)}${row.shape_policies?.[shape]?.holder ? `, holder ${row.shape_policies[shape]!.holder}` : ""})` : "none"
  return `[discovery] resolve ${shape} -> ${r}: ${why}${mismatched.length ? ` MISMATCH: ${mismatched.join(", ")} advertise ${shape} as stateless while it is held data` : ""}`
}

const KNOWN_POLICIES = new Set(["stateless", "interchangeable", "unique_authoritative", "unique_target", HELD, "stateful_data_owner_merge"])
/** A registration's shape_policies, keeping only well-formed entries (unknown policies and non-string holders dropped). */
export function sanitizeShapePolicies(raw: unknown): Record<string, { distribution_policy: any; holder?: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, { distribution_policy: any; holder?: string }> = {}
  for (const [shape, p] of Object.entries(raw as Record<string, unknown>)) {
    const pol = (p as { distribution_policy?: unknown })?.distribution_policy
    if (typeof shape !== "string" || !shape || typeof pol !== "string" || !KNOWN_POLICIES.has(pol)) continue
    const holder = (p as { holder?: unknown }).holder
    out[shape] = { distribution_policy: pol, ...(typeof holder === "string" && holder ? { holder: holder.slice(0, 120) } : {}) }
  }
  return Object.keys(out).length ? out : undefined
}
