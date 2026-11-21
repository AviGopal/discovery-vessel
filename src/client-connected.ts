/**
 * A CLIENT CONNECTED FROM OUTSIDE. Every outside client call passes through
 * discovery, which validates its key, so discovery is where a connection is seen. The first request of each key whose
 * socket is not loopback is recorded as a records row (client_connected), and the fleet's status reads that row: no
 * marker file, and no other vessel's word.
 *
 * Outside is the socket's own address, never x-forwarded-for: a caller sets that header itself, so a vessel inside
 * the container could claim any address with it. A request whose address cannot be read is not known to be outside.
 *
 * The row names the key and the path, and the node key it was written under (node_key_id), so a reader on another
 * node's records can tell this node's rows from that node's: one discovery id is shared by every node. Never the client's
 * address: a detector row's short values are shown by record_summary, and status needs only the key and the time.
 *
 * A key is recorded once per process, and only after records has taken its row, so a write that failed is tried again
 * on that key's next request. One write per key is in flight at a time: a busy key cannot start one per request while
 * records is down.
 */

export type Connected = { key_id: string; path: string }
/** Writes the row; true only when records has taken it. */
export type WriteConnected = (row: Connected) => Promise<boolean>

/** Loopback is the container itself: 127.0.0.0/8, ::1, and IPv4 loopback mapped into IPv6. */
export function isLoopback(addr: string): boolean {
  const a = addr.toLowerCase()
  if (a === "::1") return true
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/** Returns what the auth middleware calls for each validated request: (key id, socket address, path). */
export function clientObserver(write: WriteConnected): (keyId: string | undefined, remote: string, path: string) => void {
  const written = new Set<string>()
  const inFlight = new Set<string>()
  return (keyId, remote, path) => {
    if (!keyId || !remote || isLoopback(remote)) return
    if (written.has(keyId) || inFlight.has(keyId)) return
    inFlight.add(keyId)
    write({ key_id: keyId, path })
      .then((ok) => {
        if (!ok) return
        written.add(keyId)
        console.log(`[discovery] client_connected recorded: a key's first request from outside the container (${path})`)
      }, () => { /* not taken: tried again on the key's next request */ })
      .finally(() => inFlight.delete(keyId))
  }
}

/**
 * The row goes to records through this discovery's own /resolve, over loopback (so it is never itself an outside
 * request), under the node key and naming its id (the node key validated, as any caller's is), as this discovery's observation (writer its own id, role detector: records gives a
 * detector row meaning only when it is a gap, so this opens no root). Taken = records answered 2xx with the row's id.
 * Why a row was not taken is said once per cause, never with the key.
 */
export function writeConnectedVia(base: string, key: () => string, writer: () => string, keyIdOf: (k: string) => Promise<string | null>): WriteConnected {
  return writeObservedVia("client_connected", "that key's next request", base, key, writer, keyIdOf)
}

/** One of this discovery's observations written so, as a row of `shape`; `retry` says when a row not taken is tried again. */
export function writeObservedVia<R extends Record<string, unknown>>(shape: string, retry: string, base: string, key: () => string, writer: () => string,
  keyIdOf: (k: string) => Promise<string | null>): (row: R) => Promise<boolean> {
  const said = new Set<string>()
  const note = (why: string): false => {
    if (!said.has(why)) { said.add(why); console.warn(`[discovery] ${shape} not recorded: ${why}; tried again on ${retry}`) }
    return false
  }
  return async (row) => {
    const k = key()
    if (!k) return note("no node key")
    try {
      const nodeKeyId = await keyIdOf(k)
      if (!nodeKeyId) return note("the node key's id is not known (identity did not validate it)")
      const res = await fetch(new URL("/resolve", base).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${k}` },
        body: JSON.stringify({ pointer: { type: "record_write", row: { shape, ...row, node_key_id: nodeKeyId, input_refs: [] }, writer: writer(), role: "detector" } }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return note(`records answered ${res.status}`)
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null
      return typeof body?.id === "string" ? true : note("records answered no row id")
    } catch (e) {
      return note(`records unreachable (${(e as Error).name})`)
    }
  }
}
