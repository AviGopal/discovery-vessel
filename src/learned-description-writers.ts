/**
 * WHO MAY WRITE A LEARNED SHAPE DESCRIPTION (2026-10-17; qa security ruling). concept-db's shape index ingests
 * GET /registry/shape-descriptions and serves it to every org as the SYSTEM org's trusted vocabulary, so this POST is the
 * upstream source of that trust:
 *   - set and retire require the caller's identity-validated org to be the SYSTEM ORG: this vessel's own key's org as the
 *     identity vessel validates it (bootstrap identity, resolved at use, cached; never 'default' or empty). FAIL CLOSED:
 *     no validated system org, no writer;
 *   - a produced_by must name an EXISTING template whose declared output shapes include the shape, checked at write time
 *     (activity-api GET /v2/activities/templates/:id), so a minted shape is "claimed" only by a real producer.
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

export type ProducerCheck = { ok: true } | { ok: false; status: 400 | 503; reason: string }

/** Does `templateId` name an existing template whose declared outputs include `shape`? */
export async function templateProducesShape(templateId: string, shape: string, fetchImpl: typeof fetch = fetch, endpoint: string = process.env.ACTIVITY_API_ENDPOINT ?? "", ownKey: string = process.env.METABOB_API_KEY ?? ""): Promise<ProducerCheck> {
  if (!endpoint) return { ok: false, status: 503, reason: "no activity-api endpoint to verify produced_by" }
  let r: Response
  try {
    r = await fetchImpl(`${endpoint.replace(/\/$/, "")}/v2/activities/templates/${encodeURIComponent(templateId)}`, {
      headers: ownKey ? { Authorization: `ApiKey ${ownKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    })
  } catch (e) {
    return { ok: false, status: 503, reason: `produced_by could not be verified: ${(e as Error).message}` }
  }
  if (r.status === 404) return { ok: false, status: 400, reason: `produced_by ${templateId} names no template` }
  if (!r.ok) return { ok: false, status: 503, reason: `produced_by could not be verified (activity-api HTTP ${r.status})` }
  const t = (await r.json().catch(() => null)) as { output_shapes?: unknown; outputShapes?: unknown } | null
  const outs = Array.isArray(t?.output_shapes) ? t!.output_shapes : Array.isArray(t?.outputShapes) ? t!.outputShapes : []
  return (outs as unknown[]).map(String).includes(shape)
    ? { ok: true }
    : { ok: false, status: 400, reason: `produced_by ${templateId} does not declare ${shape} among its output shapes` }
}
