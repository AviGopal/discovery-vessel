/**
 * WHO MAY WRITE A LEARNED SHAPE DESCRIPTION (2026-10-17; qa security ruling). concept-db's shape index ingests
 * GET /registry/shape-descriptions and serves it to every org as the SYSTEM org's trusted vocabulary, so this POST is the
 * upstream source of that trust:
 *   - set and retire require the caller's identity-validated org to be the SYSTEM ORG: this vessel's own key's org as the
 *     identity vessel validates it (bootstrap identity, resolved at use, cached; never 'default' or empty). FAIL CLOSED:
 *     no validated system org, no writer;
 *   - produced_by is refused (index.ts): it named an activity-api template, and those left with activity-api.
 */
import { validateApiKeyNow } from "./middleware/auth"

const NEVER_TRUSTED = new Set(["", "default"])
let cachedSystemOrg: string | null = null

export async function systemOrgId(validate: (k: string) => Promise<{ orgId: string } | null> = validateApiKeyNow, ownKey: string = process.env.METABOB_API_KEY ?? ""): Promise<string | null> {
  if (cachedSystemOrg) return cachedSystemOrg
  if (!ownKey) return null
  let org: string | null = null
  try { org = (await validate(ownKey))?.orgId ?? null } catch { org = null }
  if (!org || NEVER_TRUSTED.has(org)) return null
  cachedSystemOrg = org
  return org
}
export function __resetSystemOrgForTests(): void { cachedSystemOrg = null }

