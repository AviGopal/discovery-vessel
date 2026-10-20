/**
 * The peer-instance admission rule (src/peer-instance.ts) alone: which peer row sharing a local
 * vesselId the capability merge may list behind the local rows. Same-host peers only, and only for a
 * shape the vessel declares node-distinct.
 */

import { describe, expect, it } from "bun:test"
import { admitsPeerInstance, endpointIsThisHost } from "../src/peer-instance"

describe("peer instance admission - the rule alone", () => {
  const SHAPE = "composeOwnership"
  const policies = { [SHAPE]: { distribution_policy: "stateful_data_owner_merge" } }
  const row = { vesselId: "development-vessel-local", endpoint: "http://sibling.test:18090", origin_upstream: "local", shape_policies: policies }
  const local = [{ vesselId: "development-vessel-local", endpoint: "http://localhost:8090", shape_policies: policies }]
  const ok = { keyed: true, sameHost: true }

  it("admits only a keyed, own-registry, same-host row at a new endpoint, for a shape both rows declare node-distinct", () => {
    expect(admitsPeerInstance(SHAPE, row, local, ok)).toBe(true)
    expect(admitsPeerInstance(SHAPE, row, local, { keyed: false, sameHost: true })).toBe(false) // unauthenticated peer
    expect(admitsPeerInstance(SHAPE, row, local, { keyed: true, sameHost: false })).toBe(false) // not this host
    expect(admitsPeerInstance(SHAPE, { ...row, origin_upstream: "peer:http://elsewhere.test:18100" }, local, ok)).toBe(false) // relayed
    expect(admitsPeerInstance(SHAPE, { ...row, origin_upstream: undefined }, local, ok)).toBe(false) // unattributed
    expect(admitsPeerInstance(SHAPE, { ...row, endpoint: "http://localhost:8090" }, local, ok)).toBe(false) // duplicate endpoint
    expect(admitsPeerInstance("feature_compose", row, local, ok)).toBe(false) // undeclared shape
    expect(admitsPeerInstance(SHAPE, { ...row, shape_policies: undefined }, local, ok)).toBe(false) // peer does not declare
    expect(admitsPeerInstance(SHAPE, row, [{ ...local[0]!, shape_policies: undefined }], ok)).toBe(false) // local does not declare
    expect(admitsPeerInstance(SHAPE, row, [], ok)).toBe(false) // no local row of the role: not a collision this rule handles
  })

  // Interfaces and lookups are injected (IPv6 unique-local addresses), so nothing here resolves or dials.
  const bridge = [{ address: "fd12:3456:789a:1::5", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false }]
  const deps = (answer: string[] | null) => ({
    resolve: async () => { if (!answer) throw new Error("ENOTFOUND"); return answer },
    interfaces: () => bridge,
  })

  it("a sibling container's name resolving onto a network this node attaches to is this host", async () => {
    expect(await endpointIsThisHost("http://sibling.test:8100", deps(["fd12:3456:789a:1::9"]))).toBe(true)
  })
  it("control - a name resolving elsewhere, an unresolvable name, and a remote literal are not this host", async () => {
    expect(await endpointIsThisHost("http://far.test:8100", deps(["fd99::9"]))).toBe(false)
    expect(await endpointIsThisHost("http://missing.test:8100", deps(null))).toBe(false)
    expect(await endpointIsThisHost("http://[2001:db8::5]:8100", deps(null))).toBe(false)
  })
  it("control - loopback and the runtime's name for this host are this host without a lookup", async () => {
    expect(await endpointIsThisHost("http://localhost:8090", deps(null))).toBe(true)
    expect(await endpointIsThisHost("http://[::1]:8090", deps(null))).toBe(true)
    expect(await endpointIsThisHost("http://host.containers.internal:18090", deps(null))).toBe(true)
  })
})
