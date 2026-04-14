/**
 * Metrics System Tests
 *
 * Validates that the metrics system correctly records and exports metrics.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { metricsRegistry, discoveryMetrics, DiscoveryMetrics } from "../src/metrics"

describe("MetricsRegistry", () => {
  beforeEach(() => {
    metricsRegistry.reset()
  })

  it("should register and increment counters", () => {
    metricsRegistry.register("test_counter", "counter", "Test counter")
    metricsRegistry.inc("test_counter", 1)
    metricsRegistry.inc("test_counter", 2)

    const exported = metricsRegistry.export()
    expect(exported).toContain("test_counter 3")
  })

  it("should register and set gauges", () => {
    metricsRegistry.register("test_gauge", "gauge", "Test gauge")
    metricsRegistry.set("test_gauge", 42)

    const exported = metricsRegistry.export()
    expect(exported).toContain("test_gauge 42")
  })

  it("should register and observe histograms", () => {
    metricsRegistry.register(
      "test_histogram",
      "histogram",
      "Test histogram",
      [],
      [10, 50, 100]
    )

    metricsRegistry.observe("test_histogram", 5)
    metricsRegistry.observe("test_histogram", 25)
    metricsRegistry.observe("test_histogram", 75)

    const exported = metricsRegistry.export()
    expect(exported).toContain("test_histogram_bucket{le=\"10\"} 1")
    expect(exported).toContain("test_histogram_bucket{le=\"50\"} 2")
    expect(exported).toContain("test_histogram_bucket{le=\"100\"} 3")
    expect(exported).toContain("test_histogram_sum 105")
    expect(exported).toContain("test_histogram_count 3")
  })

  it("should support labels", () => {
    metricsRegistry.register("test_labeled", "counter", "Labeled counter", ["status"])
    metricsRegistry.inc("test_labeled", 1, { status: "success" })
    metricsRegistry.inc("test_labeled", 1, { status: "failure" })

    const exported = metricsRegistry.export()
    expect(exported).toContain('test_labeled{status="success"} 1')
    expect(exported).toContain('test_labeled{status="failure"} 1')
  })

  it("should export in Prometheus format", () => {
    metricsRegistry.register("test_metric", "counter", "Help text")
    metricsRegistry.inc("test_metric", 5)

    const exported = metricsRegistry.export()
    expect(exported).toContain("# HELP test_metric Help text")
    expect(exported).toContain("# TYPE test_metric counter")
    expect(exported).toContain("test_metric 5")
  })

  it("should export JSON for debugging", () => {
    metricsRegistry.register("test_counter", "counter", "Test")
    metricsRegistry.inc("test_counter", 10)

    const json = metricsRegistry.exportJSON()
    expect(json.counters).toHaveProperty("test_counter")
    expect(json.counters.test_counter).toBe(10)
  })

  it("should reset all metrics", () => {
    metricsRegistry.register("test_counter", "counter", "Test")
    metricsRegistry.inc("test_counter", 5)

    metricsRegistry.reset()

    const json = metricsRegistry.exportJSON()
    expect(json.counters.test_counter).toBeUndefined()
  })
})

describe("DiscoveryMetrics", () => {
  beforeEach(() => {
    metricsRegistry.reset()
    // Re-register metrics
    new DiscoveryMetrics()
  })

  it("should record successful registration", () => {
    discoveryMetrics.recordRegistration("test-vessel", 100, true)

    const exported = metricsRegistry.export()
    // Check both possible label orders
    const hasMetric = exported.includes('vessel_registration_total{status="success",vessel_id="test-vessel"} 1') ||
                      exported.includes('vessel_registration_total{vessel_id="test-vessel",status="success"} 1')
    expect(hasMetric).toBe(true)
    expect(exported).toContain("vessel_registration_duration_ms")
  })

  it("should record failed registration", () => {
    discoveryMetrics.recordRegistration("test-vessel", 50, false)

    const exported = metricsRegistry.export()
    const hasMetric = exported.includes('vessel_registration_total{status="failure",vessel_id="test-vessel"} 1') ||
                      exported.includes('vessel_registration_total{vessel_id="test-vessel",status="failure"} 1')
    expect(hasMetric).toBe(true)
    // Duration histogram should NOT be updated for failures
    expect(exported).toContain("vessel_registration_duration_ms_count 0")
  })

  it("should record heartbeats", () => {
    discoveryMetrics.recordHeartbeat("test-vessel", true)
    discoveryMetrics.recordHeartbeat("test-vessel", false)

    const exported = metricsRegistry.export()
    const hasSuccess = exported.includes('vessel_heartbeat_total{status="success",vessel_id="test-vessel"} 1') ||
                       exported.includes('vessel_heartbeat_total{vessel_id="test-vessel",status="success"} 1')
    const hasFailure = exported.includes('vessel_heartbeat_total{status="failure",vessel_id="test-vessel"} 1') ||
                       exported.includes('vessel_heartbeat_total{vessel_id="test-vessel",status="failure"} 1')
    expect(hasSuccess).toBe(true)
    expect(hasFailure).toBe(true)
  })

  it("should update heartbeat failure rate", () => {
    discoveryMetrics.updateHeartbeatFailureRate("test-vessel", 0.15)

    const exported = metricsRegistry.export()
    expect(exported).toContain('vessel_heartbeat_failure_rate{vessel_id="test-vessel"} 0.15')
  })

  it("should record deregistrations by reason", () => {
    discoveryMetrics.recordDeregistration("vessel-1", "manual")
    discoveryMetrics.recordDeregistration("vessel-2", "expired")
    discoveryMetrics.recordDeregistration("vessel-3", "error")

    const exported = metricsRegistry.export()
    const has1 = exported.includes('vessel_deregistration_total{reason="manual",vessel_id="vessel-1"} 1') ||
                 exported.includes('vessel_deregistration_total{vessel_id="vessel-1",reason="manual"} 1')
    const has2 = exported.includes('vessel_deregistration_total{reason="expired",vessel_id="vessel-2"} 1') ||
                 exported.includes('vessel_deregistration_total{vessel_id="vessel-2",reason="expired"} 1')
    const has3 = exported.includes('vessel_deregistration_total{reason="error",vessel_id="vessel-3"} 1') ||
                 exported.includes('vessel_deregistration_total{vessel_id="vessel-3",reason="error"} 1')
    expect(has1).toBe(true)
    expect(has2).toBe(true)
    expect(has3).toBe(true)
  })

  it("should record TTL expirations", () => {
    discoveryMetrics.recordDeregistration("expired-vessel", "expired")

    const exported = metricsRegistry.export()
    expect(exported).toContain('vessel_ttl_expired_total{vessel_id="expired-vessel"} 1')
  })

  it("should update registry stats", () => {
    discoveryMetrics.updateRegistryStats(10, 5)

    const exported = metricsRegistry.export()
    expect(exported).toContain("discovery_registry_size 10")
    expect(exported).toContain("discovery_shapes_count 5")
  })

  it("should update circuit breaker state", () => {
    discoveryMetrics.updateCircuitBreakerState("vessel-1", "closed")
    discoveryMetrics.updateCircuitBreakerState("vessel-2", "open")
    discoveryMetrics.updateCircuitBreakerState("vessel-3", "half_open")

    const exported = metricsRegistry.export()
    expect(exported).toContain('circuit_breaker_state{vessel_id="vessel-1"} 0')
    expect(exported).toContain('circuit_breaker_state{vessel_id="vessel-2"} 1')
    expect(exported).toContain('circuit_breaker_state{vessel_id="vessel-3"} 2')
  })

  it("should record impulse resolutions", () => {
    discoveryMetrics.recordResolution("vesselCapability", 50, true)
    discoveryMetrics.recordResolution("vesselEndpoint", 100, false)

    const exported = metricsRegistry.export()
    expect(exported).toContain('impulse_resolution_total{shape="vesselCapability",status="success"} 1')
    expect(exported).toContain('impulse_resolution_total{shape="vesselEndpoint",status="failure"} 1')
  })

  it("should record resolution duration for success only", () => {
    discoveryMetrics.recordResolution("vesselHealth", 150, true)
    discoveryMetrics.recordResolution("vesselHealth", 200, false)

    const json = metricsRegistry.exportJSON()
    expect(json.histograms.impulse_resolution_duration_ms.count).toBe(1)
    expect(json.histograms.impulse_resolution_duration_ms.sum).toBe(150)
  })
})

describe("Histogram Buckets", () => {
  beforeEach(() => {
    metricsRegistry.reset()
    new DiscoveryMetrics()
  })

  it("should place values in correct buckets", () => {
    // Registration duration buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000]
    discoveryMetrics.recordRegistration("v1", 5, true)    // <= 10
    discoveryMetrics.recordRegistration("v2", 25, true)   // <= 50
    discoveryMetrics.recordRegistration("v3", 75, true)   // <= 100
    discoveryMetrics.recordRegistration("v4", 200, true)  // <= 250
    discoveryMetrics.recordRegistration("v5", 6000, true) // > 5000 (+Inf)

    const exported = metricsRegistry.export()

    // All values should be in +Inf bucket
    expect(exported).toContain('vessel_registration_duration_ms_bucket{le="+Inf"} 5')

    // Check individual buckets
    expect(exported).toContain('vessel_registration_duration_ms_bucket{le="10"} 1')
    expect(exported).toContain('vessel_registration_duration_ms_bucket{le="50"} 2')
    expect(exported).toContain('vessel_registration_duration_ms_bucket{le="100"} 3')
    expect(exported).toContain('vessel_registration_duration_ms_bucket{le="250"} 4')
  })

  it("should calculate sum and count correctly", () => {
    discoveryMetrics.recordRegistration("v1", 10, true)
    discoveryMetrics.recordRegistration("v2", 20, true)
    discoveryMetrics.recordRegistration("v3", 30, true)

    const exported = metricsRegistry.export()
    expect(exported).toContain("vessel_registration_duration_ms_sum 60")
    expect(exported).toContain("vessel_registration_duration_ms_count 3")
  })
})

describe("Metrics Integration", () => {
  it("should handle concurrent metric updates", () => {
    metricsRegistry.reset()
    new DiscoveryMetrics()

    // Simulate concurrent registrations
    for (let i = 0; i < 100; i++) {
      discoveryMetrics.recordRegistration(`vessel-${i}`, Math.random() * 1000, true)
    }

    const json = metricsRegistry.exportJSON()
    // Count all registration metrics (keys that include vessel_registration_total)
    const totalRegistrations = Object.entries(json.counters)
      .filter(([key]) => key.includes("vessel_registration_total"))
      .reduce((sum, [, val]) => sum + (typeof val === 'number' ? val : 0), 0)

    expect(totalRegistrations).toBeGreaterThanOrEqual(100)
  })

  it("should maintain metric type consistency", () => {
    metricsRegistry.reset()
    new DiscoveryMetrics()

    discoveryMetrics.recordRegistration("test", 100, true)
    discoveryMetrics.updateRegistryStats(5, 3)
    discoveryMetrics.recordResolution("vesselCapability", 50, true)

    const exported = metricsRegistry.export()

    // Verify TYPE declarations
    expect(exported).toContain("# TYPE vessel_registration_total counter")
    expect(exported).toContain("# TYPE discovery_registry_size gauge")
    expect(exported).toContain("# TYPE vessel_registration_duration_ms histogram")
  })
})
