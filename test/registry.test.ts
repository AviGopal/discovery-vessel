/**
 * Registry Unit Tests
 *
 * Tests for VesselRegistry core functionality including:
 * - Registration and deregistration
 * - TTL expiration and cleanup
 * - Shape indexing and queries
 * - Heartbeat updates
 * - Organization filtering
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { VesselRegistry, HEARTBEAT_INTERVAL_MS } from "../src/registry"
import type { VesselRegistration } from "../src/types"

describe("VesselRegistry", () => {
  let registry: VesselRegistry

  beforeEach(() => {
    registry = new VesselRegistry()
  })

  afterEach(() => {
    registry.stop()
  })

  describe("Registration", () => {
    test("registers a new vessel with all fields", () => {
      const registration = registry.register({
        vesselId: "test-vessel-1",
        vesselName: "Test Vessel",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file", "codebase"],
        protocol: "http",
        orgId: "org-123",
        metadata: { environment: "local" }
      })

      expect(registration.vesselId).toBe("test-vessel-1")
      expect(registration.vesselName).toBe("Test Vessel")
      expect(registration.status).toBe("healthy")
      expect(registration.registeredAt).toBeGreaterThan(0)
      expect(registration.lastHeartbeat).toBeGreaterThan(0)
      expect(registration.expiresAt).toBeGreaterThan(Date.now())
    })

    test("re-registration preserves registeredAt timestamp", async () => {
      const first = registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      await Bun.sleep(10) // Small delay

      const second = registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.1",
        endpoint: "http://localhost:8080",
        shapes: ["file", "codebase"]
      })

      expect(second.registeredAt).toBe(first.registeredAt)
      expect(second.lastHeartbeat).toBeGreaterThan(first.lastHeartbeat)
    })

    test("re-registration updates shape index", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.1",
        endpoint: "http://localhost:8080",
        shapes: ["codebase", "activityTemplate"]
      })

      // Old shape should be removed
      const fileVessels = registry.findByShape("file")
      expect(fileVessels.length).toBe(0)

      // New shapes should be indexed
      const codebaseVessels = registry.findByShape("codebase")
      expect(codebaseVessels.length).toBe(1)
      expect(codebaseVessels[0].vesselId).toBe("vessel-1")
    })
  })

  describe("Heartbeat", () => {
    test("updates lastHeartbeat and expiresAt", async () => {
      const registration = registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      await Bun.sleep(100)

      const success = registry.heartbeat("vessel-1")
      expect(success).toBe(true)

      const vessel = registry.get("vessel-1")
      expect(vessel).toBeDefined()
      expect(vessel!.lastHeartbeat).toBeGreaterThanOrEqual(registration.lastHeartbeat)
      expect(vessel!.expiresAt).toBeGreaterThanOrEqual(registration.expiresAt!)
    })

    test("stores metrics from heartbeat", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      const metrics = {
        executionsCompleted: 42,
        errorRate: 0.05,
        avgLatencyMs: 250
      }

      registry.heartbeat("vessel-1", metrics)

      const vessel = registry.get("vessel-1")
      expect(vessel!.metadata!.lastMetrics).toEqual(metrics)
    })

    test("returns false for unknown vessel", () => {
      const success = registry.heartbeat("unknown-vessel")
      expect(success).toBe(false)
    })
  })

  describe("Shape Indexing", () => {
    beforeEach(() => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file", "codebase"]
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["file", "activityTemplate"]
      })

      registry.register({
        vesselId: "vessel-3",
        vesselName: "V3",
        version: "1.0.0",
        endpoint: "http://localhost:8082",
        shapes: ["activityTemplate"]
      })
    })

    test("findByShape returns all vessels for a shape", () => {
      const fileVessels = registry.findByShape("file")
      expect(fileVessels.length).toBe(2)
      expect(fileVessels.map(v => v.vesselId).sort()).toEqual(["vessel-1", "vessel-2"])
    })

    test("findByShape returns empty array for unknown shape", () => {
      const vessels = registry.findByShape("unknown-shape")
      expect(vessels.length).toBe(0)
    })

    test("findByShape excludes specified vessels", () => {
      const vessels = registry.findByShape("file", { excludeVessels: ["vessel-1"] })
      expect(vessels.length).toBe(1)
      expect(vessels[0].vesselId).toBe("vessel-2")
    })

    test("findByShape filters by orgId", () => {
      registry.register({
        vesselId: "vessel-4",
        vesselName: "V4",
        version: "1.0.0",
        endpoint: "http://localhost:8083",
        shapes: ["file"],
        orgId: "org-123"
      })

      // Without orgId filter, returns all
      const all = registry.findByShape("file")
      expect(all.length).toBe(3)

      // With orgId filter, returns vessels with that orgId OR no orgId (public)
      // vessel-1 and vessel-2 have no orgId (public), vessel-4 has org-123
      const filtered = registry.findByShape("file", { orgId: "org-123" })
      expect(filtered.length).toBe(3) // All 3 vessels match (2 public + 1 org-123)
      expect(filtered.map(v => v.vesselId).sort()).toEqual(["vessel-1", "vessel-2", "vessel-4"])
    })

    test("getShapes returns all unique shapes", () => {
      const shapes = registry.getShapes()
      expect(shapes.sort()).toEqual(["activityTemplate", "codebase", "file"])
    })
  })

  describe("Organization Indexing", () => {
    test("indexes vessels by organization", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"],
        orgId: "org-123"
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["file"],
        orgId: "org-123"
      })

      registry.register({
        vesselId: "vessel-3",
        vesselName: "V3",
        version: "1.0.0",
        endpoint: "http://localhost:8082",
        shapes: ["file"],
        orgId: "org-456"
      })

      const org123Vessels = registry.list({ orgId: "org-123" })
      expect(org123Vessels.length).toBe(2)
      expect(org123Vessels.map(v => v.vesselId).sort()).toEqual(["vessel-1", "vessel-2"])
    })
  })

  describe("List and Get", () => {
    beforeEach(() => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"],
        orgId: "org-123"
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["codebase"],
        orgId: "org-456"
      })
    })

    test("get returns vessel by ID", () => {
      const vessel = registry.get("vessel-1")
      expect(vessel).toBeDefined()
      expect(vessel!.vesselId).toBe("vessel-1")
    })

    test("get returns undefined for unknown vessel", () => {
      const vessel = registry.get("unknown")
      expect(vessel).toBeUndefined()
    })

    test("list returns all vessels", () => {
      const vessels = registry.list()
      expect(vessels.length).toBe(2)
    })

    test("list filters by shapes", () => {
      const vessels = registry.list({ shapes: ["file"] })
      expect(vessels.length).toBe(1)
      expect(vessels[0].vesselId).toBe("vessel-1")
    })

    test("list filters by status", () => {
      const vessels = registry.list({ status: ["healthy"] })
      expect(vessels.length).toBe(2)
    })

    test("list filters by orgId", () => {
      const vessels = registry.list({ orgId: "org-123" })
      expect(vessels.length).toBe(1)
      expect(vessels[0].vesselId).toBe("vessel-1")
    })
  })

  describe("Unregister", () => {
    test("removes vessel from registry", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      const success = registry.unregister("vessel-1")
      expect(success).toBe(true)

      const vessel = registry.get("vessel-1")
      expect(vessel).toBeUndefined()
    })

    test("removes vessel from shape index", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file", "codebase"]
      })

      registry.unregister("vessel-1")

      expect(registry.findByShape("file").length).toBe(0)
      expect(registry.findByShape("codebase").length).toBe(0)
      expect(registry.getShapes().length).toBe(0)
    })

    test("returns false for unknown vessel", () => {
      const success = registry.unregister("unknown")
      expect(success).toBe(false)
    })
  })

  describe("TTL and Expiration", () => {
    test("expired vessels are not returned by get", async () => {
      const registration = registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      // Manually expire by setting expiresAt to the past
      const vessel = (registry as any).vessels.get("vessel-1")
      vessel.expiresAt = Date.now() - 1000

      const result = registry.get("vessel-1")
      expect(result).toBeUndefined()
    })

    test("expired vessels are not returned by findByShape", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      // Expire vessel
      const vessel = (registry as any).vessels.get("vessel-1")
      vessel.expiresAt = Date.now() - 1000

      const vessels = registry.findByShape("file")
      expect(vessels.length).toBe(0)
    })

    test("pruneExpired removes expired vessels", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["file"]
      })

      // Expire vessel-1
      const vessel1 = (registry as any).vessels.get("vessel-1")
      vessel1.expiresAt = Date.now() - 1000

      const pruned = registry.pruneExpired()
      expect(pruned).toEqual(["vessel-1"])

      expect(registry.get("vessel-1")).toBeUndefined()
      expect(registry.get("vessel-2")).toBeDefined()
      expect(registry.findByShape("file").length).toBe(1)
    })
  })

  describe("Stats", () => {
    test("getStats returns registry statistics", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file", "codebase"]
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["activityTemplate"]
      })

      const stats = registry.getStats()
      expect(stats.totalVessels).toBe(2)
      expect(stats.totalShapes).toBe(3)
      expect(stats.healthyCount).toBe(2)
    })

    test("stats exclude expired vessels", () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["codebase"]
      })

      // Expire vessel-1
      const vessel1 = (registry as any).vessels.get("vessel-1")
      vessel1.expiresAt = Date.now() - 1000

      const stats = registry.getStats()
      expect(stats.totalVessels).toBe(1)
      expect(stats.healthyCount).toBe(1)
    })
  })
})
