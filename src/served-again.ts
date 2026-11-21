/**
 * A SHAPE SERVED AGAIN. Discovery is where a call finds no producer (its 404 says unserved: the shape) and where a
 * producer registers, so it is where a recovery is seen. A shape this discovery answered unserved is recorded once a
 * vessel registers it again, as a records row (shape_served {served, vessel_id, node_key_id}, client-connected.ts's
 * writer): records shows it to a walk root whose call went unserved on that shape, and ends that walk's wait on it.
 *
 * Only a shape this discovery said unserved: a restart re-registers every shape, and none of those is a recovery
 * anything waited on here, so a restart writes no row. A shape said unserved before this process started, or served
 * again on a peer, writes none either: the owner's bound on a wait (wait_bound) ends that wait.
 *
 * A shape stays said until records has taken its row, so a write not taken is tried at the shape's next register; one
 * write per shape is in flight at a time.
 */
import { writeObservedVia } from "./client-connected"

export type Served = { served: string; vessel_id: string }
export type ServedAgain = { unserved: (shape: string) => void; registered: (vesselId: string, shapes: string[]) => void }

export function servedAgain(write: (row: Served) => Promise<boolean>): ServedAgain {
  const said = new Set<string>()
  const inFlight = new Set<string>()
  return {
    unserved: (shape) => { said.add(shape) },
    registered: (vesselId, shapes) => {
      for (const shape of shapes) {
        if (!said.has(shape) || inFlight.has(shape)) continue
        inFlight.add(shape)
        write({ served: shape, vessel_id: vesselId })
          .then((ok) => {
            if (!ok) return
            said.delete(shape)
            console.log(`[discovery] shape_served recorded: ${JSON.stringify(shape)} has a producer again`)
          }, () => { /* not taken: tried again at the shape's next register */ })
          .finally(() => inFlight.delete(shape))
      }
    },
  }
}

/** The observer as the entry point runs it: its rows written as shape_served through this discovery's own /resolve. */
export function servedAgainVia(base: string, key: () => string, writer: () => string, keyIdOf: (k: string) => Promise<string | null>): ServedAgain {
  return servedAgain(writeObservedVia<Served>("shape_served", "the shape's next register", base, key, writer, keyIdOf))
}

let observer: ServedAgain | null = null
/** Set by the entry point; with none (tests, a process with no records), nothing is recorded. */
export function setServedAgain(o: ServedAgain | null): void { observer = o }
export function saidUnserved(shape: string): void { observer?.unserved(shape) }
export function registeredShapes(vesselId: string, shapes: string[]): void { observer?.registered(vesselId, shapes) }
