// A peer row (a vessel mirrored from another substrate, `<vessel>@<substrate>`) is reachable here only if a local
// vessel's org could be routed to it: a system vessel's row, or one of an org this node's own vessels register under.
// discovery counts both on /health, so a shape listed as served but never routed (agf_hh1xyjlp64lu) is visible without
// naming an org.
import { describe, expect, test } from "bun:test"
import { VesselRegistry } from "../src/registry"

const reg = (r: VesselRegistry, vesselId: string, orgId?: string, systemVessel?: boolean) =>
  r.register({ vesselId, vesselName: vesselId, version: "1", endpoint: "http://127.0.0.1:1", shapes: ["thing"], ...(orgId ? { orgId } : {}), ...(systemVessel ? { systemVessel } : {}) } as never)

describe("peer reach", () => {
  test("[MUST-FAIL] a peer row of another org counts as a peer row and not as reachable; one of a local org, or a system row, is reachable", () => {
    const r = new VesselRegistry()
    reg(r, "walk-vessel", "org-local")
    reg(r, "llm-resolver-vessel@hub", "org-hub")
    reg(r, "records-vessel@hub", "org-local")
    reg(r, "concept-db@hub", undefined, true)
    expect(r.peerReach()).toEqual({ peer_rows: 3, peer_rows_reachable: 2, peer_rows_healthy_reachable: 2 })
  })

  test("no peer rows: zero and zero", () => {
    const r = new VesselRegistry()
    reg(r, "walk-vessel", "org-local")
    expect(r.peerReach()).toEqual({ peer_rows: 0, peer_rows_reachable: 0, peer_rows_healthy_reachable: 0 })
  })

  test("[MUST-FAIL] a reachable peer row that is not healthy counts as reachable and not as healthy-reachable (deployment)", () => {
    const r = new VesselRegistry()
    reg(r, "walk-vessel", "org-local")
    reg(r, "records-vessel@hub", "org-local")
    const row = r.get("records-vessel@hub")!
    row.status = "unhealthy" as never
    expect(r.peerReach()).toEqual({ peer_rows: 1, peer_rows_reachable: 1, peer_rows_healthy_reachable: 0 })
  })
})
