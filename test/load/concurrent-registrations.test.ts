/**
 * Load Test: 1000 Concurrent Vessel Registrations
 *
 * Tests:
 * - 1000 vessels register simultaneously
 * - Measure registration time
 * - Verify heartbeat reliability
 * - Test TTL expiration accuracy
 * - Measure query performance under load
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createServer, registry } from "../../src/index"
import type { Hono } from "hono"

describe("Load Test: Concurrent Registrations", () => {
  let app: Hono

  beforeEach(() => {
    app = createServer()
    // Clear registry
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))
  })

  afterEach(() => {
    registry.stop()
  })

  test("1000 concurrent vessel registrations", async () => {
    const vesselCount = 1000
    const startTime = Date.now()

    // Generate vessel registrations
    const registrations = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `MiniBob Instance ${i}`,
      version: "0.5.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: ["file", "codebase", "activityTemplate"],
      orgId: `org-${i % 10}`, // 10 different orgs
      metadata: {
        environment: "load-test",
        replicaIndex: i
      }
    }))

    // Execute concurrent registrations
    const promises = registrations.map(reg =>
      app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reg)
      })
    )

    const responses = await Promise.all(promises)
    const registrationTime = Date.now() - startTime

    // Verify all succeeded
    const successCount = responses.filter(r => r.status === 201).length
    expect(successCount).toBe(vesselCount)

    console.log(`\n✅ Load Test Results:`)
    console.log(`   - Vessels registered: ${successCount}/${vesselCount}`)
    console.log(`   - Total time: ${registrationTime}ms`)
    console.log(`   - Average time per vessel: ${(registrationTime / vesselCount).toFixed(2)}ms`)
    console.log(`   - Throughput: ${(vesselCount / (registrationTime / 1000)).toFixed(0)} registrations/sec`)

    // Verify registry state
    const stats = registry.getStats()
    expect(stats.totalVessels).toBe(vesselCount)
    expect(stats.healthyCount).toBe(vesselCount)

    // Performance assertion: should complete within reasonable time
    // 1000 registrations should complete in < 5 seconds
    expect(registrationTime).toBeLessThan(5000)
  }, { timeout: 10000 })

  test("query performance under 1000 vessel load", async () => {
    // Register 1000 vessels
    const vesselCount = 1000
    const registrations = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `Vessel ${i}`,
      version: "1.0.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: i % 3 === 0 ? ["file"] : i % 3 === 1 ? ["codebase"] : ["activityTemplate"]
    }))

    await Promise.all(
      registrations.map(reg =>
        app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg)
        })
      )
    )

    // Measure query performance
    const queryStartTime = Date.now()
    const queryRes = await app.request("/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pointer: {
          type: "vesselCapability",
          shape: "file"
        }
      })
    })

    const queryTime = Date.now() - queryStartTime
    expect(queryRes.status).toBe(200)

    const data = await queryRes.json()
    const expectedCount = Math.ceil(vesselCount / 3) // Every 3rd vessel has "file"
    expect(data.content.vessels.length).toBe(expectedCount)

    console.log(`\n✅ Query Performance:`)
    console.log(`   - Query time: ${queryTime}ms`)
    console.log(`   - Results returned: ${data.content.vessels.length}`)
    console.log(`   - Time per result: ${(queryTime / data.content.vessels.length).toFixed(2)}ms`)

    // Query should be fast even with 1000 vessels
    expect(queryTime).toBeLessThan(100)
  }, { timeout: 15000 })

  test("concurrent heartbeats from 1000 vessels", async () => {
    const vesselCount = 1000

    // Register vessels first
    const registrations = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `Vessel ${i}`,
      version: "1.0.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: ["file"]
    }))

    await Promise.all(
      registrations.map(reg =>
        app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg)
        })
      )
    )

    // Send concurrent heartbeats
    const startTime = Date.now()
    const heartbeats = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      metrics: {
        executionsCompleted: Math.floor(Math.random() * 100),
        errorRate: Math.random() * 0.1,
        avgLatencyMs: Math.floor(Math.random() * 500)
      }
    }))

    const promises = heartbeats.map(hb =>
      app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hb)
      })
    )

    const responses = await Promise.all(promises)
    const heartbeatTime = Date.now() - startTime

    const successCount = responses.filter(r => r.status === 200).length
    expect(successCount).toBe(vesselCount)

    console.log(`\n✅ Heartbeat Performance:`)
    console.log(`   - Heartbeats sent: ${successCount}/${vesselCount}`)
    console.log(`   - Total time: ${heartbeatTime}ms`)
    console.log(`   - Average time: ${(heartbeatTime / vesselCount).toFixed(2)}ms`)
    console.log(`   - Throughput: ${(vesselCount / (heartbeatTime / 1000)).toFixed(0)} heartbeats/sec`)

    // Heartbeats should be very fast
    expect(heartbeatTime).toBeLessThan(2000)
  }, { timeout: 10000 })

  test("TTL expiration accuracy under load", async () => {
    // This test verifies that TTL expiration works correctly even with many vessels
    // We can't wait 5 minutes in a test, so we'll use the registry directly

    const vesselCount = 100
    const registrations = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `Vessel ${i}`,
      version: "1.0.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: ["file"]
    }))

    // Register all vessels
    for (const reg of registrations) {
      registry.register(reg)
    }

    // Verify all are registered
    expect(registry.getStats().totalVessels).toBe(vesselCount)

    // Manually expire some vessels by modifying their expiresAt
    const vessels = registry.list()
    for (let i = 0; i < vesselCount / 2; i++) {
      const vessel = vessels[i]
      vessel.expiresAt = Date.now() - 1000 // Expired 1 second ago
    }

    // Trigger cleanup
    const prunedStartTime = Date.now()
    const pruned = registry.pruneExpired()
    const prunedTime = Date.now() - prunedStartTime

    expect(pruned.length).toBe(vesselCount / 2)

    console.log(`\n✅ TTL Expiration Performance:`)
    console.log(`   - Vessels expired: ${pruned.length}/${vesselCount}`)
    console.log(`   - Cleanup time: ${prunedTime}ms`)
    console.log(`   - Vessels remaining: ${registry.getStats().totalVessels}`)

    // Cleanup should be fast
    expect(prunedTime).toBeLessThan(100)
    expect(registry.getStats().totalVessels).toBe(vesselCount / 2)
  })

  test("mixed operations under load", async () => {
    // Simulate realistic load: registrations, heartbeats, queries, deregistrations
    const vesselCount = 500

    // Phase 1: Register vessels
    const registerStartTime = Date.now()
    const registrations = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `Vessel ${i}`,
      version: "1.0.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: ["file", "codebase"]
    }))

    await Promise.all(
      registrations.map(reg =>
        app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg)
        })
      )
    )
    const registerTime = Date.now() - registerStartTime

    // Phase 2: Concurrent queries from 50 clients
    const queryStartTime = Date.now()
    const queries = Array.from({ length: 50 }, () =>
      app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: { type: "vesselCapability", shape: "file" }
        })
      })
    )
    await Promise.all(queries)
    const queryTime = Date.now() - queryStartTime

    // Phase 3: Concurrent heartbeats
    const heartbeatStartTime = Date.now()
    const heartbeats = Array.from({ length: vesselCount }, (_, i) =>
      app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vesselId: `vessel-${i}` })
      })
    )
    await Promise.all(heartbeats)
    const heartbeatTime = Date.now() - heartbeatStartTime

    // Phase 4: Deregister half the vessels
    const deregisterStartTime = Date.now()
    const deregistrations = Array.from({ length: vesselCount / 2 }, (_, i) =>
      app.request(`/vessels/vessel-${i}`, { method: "DELETE" })
    )
    await Promise.all(deregistrations)
    const deregisterTime = Date.now() - deregisterStartTime

    console.log(`\n✅ Mixed Operations Performance:`)
    console.log(`   Phase 1 - Register ${vesselCount} vessels: ${registerTime}ms`)
    console.log(`   Phase 2 - 50 concurrent queries: ${queryTime}ms`)
    console.log(`   Phase 3 - ${vesselCount} heartbeats: ${heartbeatTime}ms`)
    console.log(`   Phase 4 - Deregister ${vesselCount / 2} vessels: ${deregisterTime}ms`)
    console.log(`   Total time: ${registerTime + queryTime + heartbeatTime + deregisterTime}ms`)

    // Verify final state
    const stats = registry.getStats()
    expect(stats.totalVessels).toBe(vesselCount / 2)
  }, { timeout: 15000 })

  test("memory efficiency with 1000 vessels", async () => {
    const vesselCount = 1000

    // Measure memory before
    const memBefore = process.memoryUsage()

    // Register 1000 vessels
    const registrations = Array.from({ length: vesselCount }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `Vessel ${i}`,
      version: "1.0.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: ["file", "codebase", "activityTemplate"],
      metadata: {
        environment: "production",
        region: `region-${i % 5}`,
        tags: ["tag1", "tag2", "tag3"]
      }
    }))

    await Promise.all(
      registrations.map(reg =>
        app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg)
        })
      )
    )

    // Measure memory after
    const memAfter = process.memoryUsage()

    const heapUsedDelta = memAfter.heapUsed - memBefore.heapUsed
    const memoryPerVessel = heapUsedDelta / vesselCount

    console.log(`\n✅ Memory Efficiency:`)
    console.log(`   - Heap used delta: ${(heapUsedDelta / 1024 / 1024).toFixed(2)} MB`)
    console.log(`   - Memory per vessel: ${(memoryPerVessel / 1024).toFixed(2)} KB`)
    console.log(`   - Total vessels: ${registry.getStats().totalVessels}`)

    // Memory usage should be reasonable (< 10 KB per vessel)
    expect(memoryPerVessel).toBeLessThan(10 * 1024)
  }, { timeout: 15000 })
})
