/**
 * WHO MAY REPLACE, REFRESH OR EVICT A REGISTERED ROW. A row's orgId is the org of the key that registered it, and
 * /resolve forwards each caller's Authorization header to the row's endpoint, so whoever can rewrite or remove a row
 * receives the keys of everyone routed to it, or to its replacement. An existing row is re-registered, heartbeated, or
 * evicted by peer dedup only on behalf of a key of the row's own org, or of the system identity (this vessel's own
 * key's org, as systemOrgId validates it), which sees and keeps the whole registry. A caller with no org never matches
 * a row, and with no validated system org nobody is the system identity: both fail closed. A vesselId with no row yet
 * is anyone's to register.
 */
import type { VesselRegistration } from "./types"
import { systemOrgId } from "./learned-description-writers"

/** Why this caller may not write the existing row (by org class, never an id or key), or null when it may. */
export function ownerVerdict(prior: VesselRegistration | undefined, callerOrg: string | undefined, sys: string | null): string | null {
  if (!prior) return null
  const caller = typeof callerOrg === "string" ? callerOrg : ""
  if (caller !== "" && prior.orgId === caller) return null
  if (sys !== null && caller === sys) return null
  const rowClass = prior.systemVessel === true ? "a system vessel" : typeof prior.orgId === "string" && prior.orgId !== "" ? (sys !== null && prior.orgId === sys ? "a system-org row" : "a tenant row") : "a row with no org"
  const callerClass = caller === "" ? "a caller with no org" : "a tenant caller"
  return `${callerClass} may not rewrite ${rowClass} (not the row's org, not the system identity${sys === null ? ", which is not validated" : ""})`
}

/** ownerVerdict with the system org resolved at use. */
export async function refusesOwner(
  prior: VesselRegistration | undefined,
  callerOrg: string | undefined,
  system: () => Promise<string | null> = systemOrgId,
): Promise<string | null> {
  return prior ? ownerVerdict(prior, callerOrg, await system()) : null
}
