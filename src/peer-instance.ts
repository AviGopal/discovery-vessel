/**
 * A PEER NODE'S INSTANCE OF A LOCAL ROLE.
 *
 * A vesselId names a role, not an instance: every node registers its development-vessel under the
 * same id. The capability union merge used to drop every peer row whose vesselId matched a local
 * row, so a node that reaches its peers only through HTTP peer discovery never saw a peer's
 * instance, and capacity-aware placement found no peer. A colliding peer row is now admitted
 * behind the local rows (never in place of one) when ALL of these hold:
 *   - the vessel declares the shape node-distinct: its LOCAL row (this node's own registration) and the peer row both
 *     advertise it as `stateful_data_owner_merge` (state is per node; a caller asks every owner). This is the vessel's
 *     own shaped routing rule, read from the registry at use time. A shape it does not declare so (the default, and
 *     every held or interchangeable shape) keeps today's local-only answer, so walk failover, policy reads and
 *     single-producer siting for those shapes never meet a second instance of the role;
 *   - the answer came from a peer asked on the keyed path: postToPeer sent it the credential chosen
 *     for that peer (`keyed`);
 *   - the asked peer serves the row from its OWN registry (origin_upstream "local"), so it is not a
 *     row relayed through the peer, which could be our own row echoed back;
 *   - no local row of that id has the same endpoint (a true duplicate still collapses);
 *   - the row's endpoint is on THIS host (PEER_INSTANCE_SCOPE). A caller that picks the row sends it
 *     work with its key, so the endpoint, not the peer's claim, is what is checked.
 *
 * PEER_INSTANCE_SCOPE is a named constant, not yet a shaped policy: discovery reads no policy shape
 * today, and "same host only" is the standing ruling until one carries it.
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { networkInterfaces } from "node:os"
import { policyForShape, type RoutableRow } from "./held-shape-routing"

export const PEER_INSTANCE_SCOPE = "same_host" as const
/** The per-shape distribution policy that says each node's instance holds its own state for the shape. */
export const NODE_DISTINCT = "stateful_data_owner_merge"

/** Names a container runtime gives THIS host, from inside a container. */
const RUNTIME_HOST_ALIASES = new Set(["host.containers.internal", "host.docker.internal"])
const LOOPBACK_NAMES = new Set(["localhost", "::1"]) // a loopback address literal is caught by isLoopbackAddr
const LOOKUP_TIMEOUT_MS = 500

export interface HostDeps {
  /** Every address a host name resolves to. */
  resolve: (host: string) => Promise<string[]>
  /** This node's own non-internal interface addresses with their netmasks. */
  interfaces: () => Array<{ address: string; netmask: string; family: string; internal: boolean }>
}

const defaultDeps: HostDeps = {
  resolve: async (host) => {
    const all = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("lookup timeout")), LOOKUP_TIMEOUT_MS)),
    ])
    return all.map((a) => a.address)
  },
  interfaces: () => Object.values(networkInterfaces()).flat().filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => ({ address: n.address, netmask: n.netmask, family: String(n.family), internal: n.internal })),
}

/** An IPv4 or IPv6 address as a bigint, with its bit width; null when unparseable. */
function addrBits(a: string): { v: bigint; bits: number } | null {
  const kind = isIP(a)
  if (kind === 4) return { v: a.split(".").reduce((x, o) => (x << 8n) | BigInt(Number(o)), 0n), bits: 32 }
  if (kind !== 6) return null
  if (a.includes(".")) return null // an IPv4-mapped tail is not compared
  const [head, tail] = a.split("::") as [string, string | undefined]
  const h = head ? head.split(":") : []
  const t = tail !== undefined && tail ? tail.split(":") : []
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]
  if (groups.length !== 8) return null
  return { v: groups.reduce((x, g) => (x << 16n) | BigInt(parseInt(g || "0", 16)), 0n), bits: 128 }
}

const isLoopbackAddr = (a: string): boolean => a === "::1" || (isIP(a) === 4 && a.startsWith("127."))

/** Is `endpoint` on THIS host: loopback, the runtime's name for this host, or an address on a network one of this
 *  node's own interfaces attaches to (a host bridge that sibling containers share)? Unresolvable means no. */
export async function endpointIsThisHost(endpoint: string, deps: HostDeps = defaultDeps): Promise<boolean> {
  let host: string
  try { host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "") } catch { return false }
  if (!host) return false
  if (LOOPBACK_NAMES.has(host) || RUNTIME_HOST_ALIASES.has(host)) return true
  let addrs: string[]
  try { addrs = isIP(host) ? [host] : await deps.resolve(host) } catch { return false }
  const nets = deps.interfaces().filter((n) => !n.internal)
  return addrs.some((a) => {
    if (isLoopbackAddr(a)) return true
    const x = addrBits(a)
    if (!x) return false
    return nets.some((n) => {
      const ad = addrBits(n.address), m = addrBits(n.netmask)
      return !!ad && !!m && ad.bits === x.bits && m.bits === x.bits && (ad.v & m.v) === (x.v & m.v)
    })
  })
}

/** Admit a peer row of `shape` whose vesselId a local row already has? Pure; `sameHost` is endpointIsThisHost's answer.
 *  `localRows` are this node's own rows in the answer. */
export function admitsPeerInstance(
  shape: string,
  row: Record<string, unknown>,
  localRows: ReadonlyArray<Record<string, unknown>>,
  facts: { keyed: boolean; sameHost: boolean },
): boolean {
  const id = String(row.vesselId ?? "")
  const own = localRows.filter((l) => String(l.vesselId ?? "") === id)
  const declared = own.length > 0 && own.every((l) => policyForShape(l as unknown as RoutableRow, shape) === NODE_DISTINCT)
    && policyForShape(row as unknown as RoutableRow, shape) === NODE_DISTINCT
  const duplicate = own.some((l) => String(l.endpoint ?? "") === String(row.endpoint ?? ""))
  return declared && facts.keyed && row.origin_upstream === "local" && !duplicate && facts.sameHost
}
