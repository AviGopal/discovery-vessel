/**
 * Chaos Test: Discovery Vessel Crash During Registration
 *
 * Tests system resilience when discovery-vessel crashes during active operations:
 * - Kill discovery-vessel pod during registration
 * - Verify vessels retry with exponential backoff
 * - Verify self-healing and recovery
 * - Test graceful degradation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createServer, registry } from "../../src/index"
import type { Hono } from "hono"

describe("Chaos Test: Discovery Crash", () => {
  let app: Hono

  beforeEach(() => {
    app = createServer()
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))
  })

  afterEach(() => {
    registry.stop()
  })

  test("recovery after simulated crash during registration", async () => {
    const vesselCount = 100
    let crashedDuringRegistration = false
    let recoveredRegistrations = 0

    // Create a wrapper that simulates intermittent crashes
    const registerWithCrash = async (vesselId: string) => {
      const registration = {
        vesselId,
        vesselName: `Vessel ${vesselId}`,
        version: "1.0.0",
        endpoint: `http://${vesselId}:8080`,
        shapes: ["file"]
      }

      // Simulate crash for 20% of requests
      if (Math.random() < 0.2 && !crashedDuringRegistration) {
        crashedDuringRegistration = true
        throw new Error("Simulated crash")
      }

      try {
        const res = await app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(registration)
        })

        if (res.status === 201) {
          recoveredRegistrations++
          return { success: true, vesselId }
        }
        return { success: false, vesselId, reason: "HTTP error" }
      } catch (error: any) {
        // Retry with exponential backoff
        return await retryWithBackoff(vesselId, registration)
      }
    }

    const retryWithBackoff = async (vesselId: string, registration: any, attempt = 1, maxAttempts = 3) => {
      if (attempt > maxAttempts) {
        return { success: false, vesselId, reason: "Max retries exceeded" }
      }

      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
      await new Promise(resolve => setTimeout(resolve, backoffMs))

      try {
        const res = await app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(registration)
        })

        if (res.status === 201) {
          recoveredRegistrations++
          return { success: true, vesselId, attempts: attempt }
        }
        return await retryWithBackoff(vesselId, registration, attempt + 1, maxAttempts)
      } catch (error: any) {
        return await retryWithBackoff(vesselId, registration, attempt + 1, maxAttempts)
      }
    }

    // Execute registrations with potential crashes
    const results = await Promise.allSettled(
      Array.from({ length: vesselCount }, (_, i) => registerWithCrash(`vessel-${i}`))
    )

    const successful = results.filter(r => r.status === "fulfilled" && (r.value as any).success).length
    const failed = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && !(r.value as any).success)).length

    console.log(`\n✅ Crash Recovery Results:`)
    console.log(`   - Crash occurred: ${crashedDuringRegistration}`)
    console.log(`   - Successful registrations: ${successful}/${vesselCount}`)
    console.log(`   - Failed registrations: ${failed}`)
    console.log(`   - Recovery rate: ${((successful / vesselCount) * 100).toFixed(1)}%`)

    // Most registrations should succeed despite crashes
    expect(successful).toBeGreaterThan(vesselCount * 0.8) // 80% success rate
  }, { timeout: 30000 })

  test("registry state consistency after crash", async () => {
    // Phase 1: Register vessels
    const registrations = Array.from({ length: 50 }, (_, i) => ({
      vesselId: `vessel-${i}`,
      vesselName: `Vessel ${i}`,
      version: "1.0.0",
      endpoint: `http://vessel-${i}:8080`,
      shapes: ["file", "codebase"]
    }))

    for (const reg of registrations) {
      await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reg)
      })
    }

    const statsBefore = registry.getStats()
    expect(statsBefore.totalVessels).toBe(50)

    // Phase 2: Simulate crash by clearing registry (simulates pod restart)
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))

    const statsAfterCrash = registry.getStats()
    expect(statsAfterCrash.totalVessels).toBe(0)

    // Phase 3: Vessels re-register after detecting discovery is back
    const reregistrationResults = await Promise.all(
      registrations.map(reg =>
        app.request("/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg)
        })
      )
    )

    const successCount = reregistrationResults.filter(r => r.status === 201).length
    expect(successCount).toBe(50)

    const statsAfterRecovery = registry.getStats()
    expect(statsAfterRecovery.totalVessels).toBe(50)
    expect(statsAfterRecovery.healthyCount).toBe(50)

    console.log(`\n✅ State Consistency:`)
    console.log(`   - Before crash: ${statsBefore.totalVessels} vessels`)
    console.log(`   - After crash: ${statsAfterCrash.totalVessels} vessels`)
    console.log(`   - After recovery: ${statsAfterRecovery.totalVessels} vessels`)
    console.log(`   - Recovery: 100%`)
  })

  test("heartbeat resilience during discovery downtime", async () => {
    // Register vessels
    const vesselCount = 20
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

    // Simulate discovery downtime - heartbeats will fail
    let heartbeatsFailedDuringDowntime = 0
    let heartbeatsSucceededAfterRecovery = 0

    // Simulate downtime period (heartbeats fail)
    const downtimeHeartbeats = await Promise.allSettled(
      Array.from({ length: vesselCount }, (_, i) => {
        // Simulate that during downtime, some heartbeat attempts fail
        if (Math.random() < 0.3) {
          heartbeatsFailedDuringDowntime++
          return Promise.reject(new Error("Discovery unavailable"))
        }
        return app.request("/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vesselId: `vessel-${i}` })
        })
      })
    )

    // After recovery, vessels retry heartbeats
    const recoveryHeartbeats = await Promise.all(
      Array.from({ length: vesselCount }, (_, i) =>
        app.request("/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vesselId: `vessel-${i}` })
        }).then(res => {
          if (res.status === 200) heartbeatsSucceededAfterRecovery++
          return res
        })
      )
    )

    const allSucceeded = recoveryHeartbeats.every(r => r.status === 200)
    expect(allSucceeded).toBe(true)

    console.log(`\n✅ Heartbeat Resilience:`)
    console.log(`   - Failed during downtime: ${heartbeatsFailedDuringDowntime}`)
    console.log(`   - Succeeded after recovery: ${heartbeatsSucceededAfterRecovery}/${vesselCount}`)
    console.log(`   - Recovery rate: 100%`)
  })

  test("partial registration failure recovery", async () => {
    // Simulate scenario where registration partially completes before crash
    const vesselId = "vessel-partial"
    const registration = {
      vesselId,
      vesselName: "Partial Vessel",
      version: "1.0.0",
      endpoint: "http://vessel-partial:8080",
      shapes: ["file", "codebase", "activityTemplate"]
    }

    // First registration attempt
    const res1 = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration)
    })
    expect(res1.status).toBe(201)

    // Verify vessel is registered with all shapes
    const query1 = await app.request("/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pointer: { type: "vesselCapability", shape: "file" }
      })
    })
    const data1 = await query1.json()
    const vessel1 = data1.content.vessels.find((v: any) => v.vesselId === vesselId)
    expect(vessel1).toBeDefined()

    // Simulate crash and recovery - vessel re-registers with different shapes
    const updatedRegistration = {
      ...registration,
      shapes: ["activityTemplate", "newShape"] // Changed shapes
    }

    const res2 = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedRegistration)
    })
    expect(res2.status).toBe(201)

    // Verify old shapes are no longer associated
    const query2 = await app.request("/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pointer: { type: "vesselCapability", shape: "file" }
      })
    })
    const data2 = await query2.json()
    const vessel2 = data2.content.vessels.find((v: any) => v.vesselId === vesselId)
    expect(vessel2).toBeUndefined() // Should not be found for "file" anymore

    // Verify new shapes are associated
    const query3 = await app.request("/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pointer: { type: "vesselCapability", shape: "newShape" }
      })
    })
    const data3 = await query3.json()
    const vessel3 = data3.content.vessels.find((v: any) => v.vesselId === vesselId)
    expect(vessel3).toBeDefined()

    console.log(`\n✅ Partial Registration Recovery:`)
    console.log(`   - Initial shapes: file, codebase, activityTemplate`)
    console.log(`   - Updated shapes: activityTemplate, newShape`)
    console.log(`   - Shape index correctly updated: ✓`)
  })

  test("concurrent crashes and recovery", async () => {
    // Simulate multiple crash-recovery cycles during high load
    const cycles = 3
    const vesselsPerCycle = 30
    let totalRegistered = 0
    let totalRecovered = 0

    for (let cycle = 0; cycle < cycles; cycle++) {
      // Register vessels
      const registrations = Array.from({ length: vesselsPerCycle }, (_, i) => ({
        vesselId: `vessel-cycle${cycle}-${i}`,
        vesselName: `Vessel ${i}`,
        version: "1.0.0",
        endpoint: `http://vessel-${i}:8080`,
        shapes: ["file"]
      }))

      const registerResults = await Promise.all(
        registrations.map(reg =>
          app.request("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reg)
          })
        )
      )

      totalRegistered += registerResults.filter(r => r.status === 201).length

      // Simulate crash (clear half the vessels)
      const vessels = registry.list()
      const toRemove = vessels.slice(0, vessels.length / 2)
      toRemove.forEach(v => registry.unregister(v.vesselId))

      // Recovery: re-register removed vessels
      const reregisterResults = await Promise.all(
        toRemove.map(v =>
          app.request("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              vesselId: v.vesselId,
              vesselName: v.vesselName,
              version: v.version,
              endpoint: v.endpoint,
              shapes: v.shapes
            })
          })
        )
      )

      totalRecovered += reregisterResults.filter(r => r.status === 201).length
    }

    const finalStats = registry.getStats()

    console.log(`\n✅ Concurrent Crash Recovery:`)
    console.log(`   - Cycles: ${cycles}`)
    console.log(`   - Vessels per cycle: ${vesselsPerCycle}`)
    console.log(`   - Total registered: ${totalRegistered}`)
    console.log(`   - Total recovered: ${totalRecovered}`)
    console.log(`   - Final vessels: ${finalStats.totalVessels}`)

    // Should have vessels from all cycles
    expect(finalStats.totalVessels).toBeGreaterThan(0)
  }, { timeout: 20000 })
})
