/**
 * Event-bus publisher — emits vessel-registration events onto activity-api's
 * substrate event bus via POST /v2/events/publish.
 *
 * Per openspec change 2026-05-27-neutral-emitter-lifecycle-bus, specifically
 * the vessel-registration-events capability. Each registry mutation (register,
 * heartbeat, expire) publishes a corresponding event so consumers (notably
 * goal-host-vessel's proxy registration) can react without polling.
 *
 * Semantics:
 *   - Fire-and-forget. Errors are logged once per outage window and never
 *     surface to the registry-mutation caller. The registry's in-memory state
 *     is the canonical source of truth; events are a notification layer.
 *   - 2-second HTTP timeout.
 *   - Disabled when ACTIVITY_API_ENDPOINT is unset (logs once at module load).
 */

const ACTIVITY_API_ENDPOINT = process.env.ACTIVITY_API_ENDPOINT ?? "";
const API_KEY = process.env.METABOB_API_KEY ?? "";
const SOURCE_VESSEL_ID = "discovery-vessel";

let outageSeenLogged = false;

if (!ACTIVITY_API_ENDPOINT) {
  console.warn("[discovery-vessel] event bus disabled (ACTIVITY_API_ENDPOINT unset)");
}

export type VesselEventType =
  | "vessel.registered"
  | "vessel.heartbeat"
  | "vessel.deregistered"
  | "vessel.expired";

/**
 * Publish an event to activity-api's substrate bus. Fire-and-forget.
 * Returns immediately; failures logged at warn level.
 */
export function publishVesselEvent(
  type: VesselEventType,
  data: Record<string, unknown>,
): void {
  if (!ACTIVITY_API_ENDPOINT) return;

  // Fire-and-forget — don't await, don't throw.
  void (async () => {
    try {
      const res = await fetch(`${ACTIVITY_API_ENDPOINT}/v2/events/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
        },
        body: JSON.stringify({
          type,
          source_vessel_id: SOURCE_VESSEL_ID,
          data,
        }),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        if (!outageSeenLogged) {
          console.warn(
            `[discovery-vessel] event bus publish HTTP ${res.status} (suppressing further logs this outage)`,
          );
          outageSeenLogged = true;
        }
      } else if (outageSeenLogged) {
        console.info("[discovery-vessel] event bus recovered");
        outageSeenLogged = false;
      }
    } catch (err) {
      if (!outageSeenLogged) {
        console.warn(
          `[discovery-vessel] event bus publish failed: ${(err as Error).message} ` +
            "(suppressing further logs this outage)",
        );
        outageSeenLogged = true;
      }
    }
  })();
}
