/**
 * Endpoint Integration Tests
 *
 * Tests for all discovery vessel HTTP endpoints:
 * - POST /resolve - Impulse resolution
 * - POST /register - Vessel registration
 * - POST /heartbeat - Heartbeat updates
 * - DELETE /vessels/:id - Deregistration
 * - GET /health - Health check
 * - GET /shapes - Resolvable shapes
 * - GET /registry/shapes - Available shapes
 * - GET /registry/stats - Registry statistics
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createServer, registry } from "../src/index"
import type { Hono } from "hono"

describe("Discovery Vessel Endpoints", () => {
  let app: Hono

  beforeEach(() => {
    app = createServer()
    // Clear registry before each test
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))
  })

  afterEach(() => {
    registry.stop()
  })

  describe("GET /health", () => {
    test("returns health status", async () => {
      const res = await app.request("/health")
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.status).toBe("ok")
      expect(data.vessel).toBe("discovery")
      expect(data.version).toBeDefined()
      expect(data.registeredVessels).toBeGreaterThanOrEqual(0)
      expect(data.uptime).toBeGreaterThanOrEqual(0)
    })

    test("includes registered vessel count", async () => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })

      const res = await app.request("/health")
      const data = await res.json()
      expect(data.registeredVessels).toBeGreaterThanOrEqual(1)
    })
  })

  describe("POST /register", () => {
    test("registers a new vessel", async () => {
      const res = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "test-vessel",
          vesselName: "Test Vessel",
          version: "1.0.0",
          endpoint: "http://localhost:9000",
          shapes: ["file", "codebase"],
          protocol: "http",
          orgId: "org-123"
        })
      })

      expect(res.status).toBe(201)

      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.vesselId).toBe("test-vessel")
      expect(data.expiresAt).toBeGreaterThan(Date.now())

      // Verify vessel is in registry
      const vessel = registry.get("test-vessel")
      expect(vessel).toBeDefined()
      expect(vessel!.shapes).toEqual(["file", "codebase"])
    })

    test("validates required fields", async () => {
      const res = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "test-vessel"
          // Missing endpoint and shapes
        })
      })

      expect(res.status).toBe(400)

      const data = await res.json()
      expect(data.error).toBeDefined()
    })

    test("allows re-registration", async () => {
      // First registration
      await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "vessel-1",
          vesselName: "V1",
          version: "1.0.0",
          endpoint: "http://localhost:9000",
          shapes: ["file"]
        })
      })

      // Second registration with different shapes
      const res = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "vessel-1",
          vesselName: "V1 Updated",
          version: "1.0.1",
          endpoint: "http://localhost:9000",
          shapes: ["codebase"]
        })
      })

      expect(res.status).toBe(201)

      const vessel = registry.get("vessel-1")
      expect(vessel!.shapes).toEqual(["codebase"])
      expect(vessel!.vesselName).toBe("V1 Updated")
    })
  })

  describe("POST /heartbeat", () => {
    beforeEach(() => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })
    })

    test("updates heartbeat timestamp", async () => {
      const res = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "vessel-1"
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.nextHeartbeatMs).toBeGreaterThan(0)
    })

    test("stores metrics from heartbeat", async () => {
      const res = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "vessel-1",
          metrics: {
            executionsCompleted: 100,
            errorRate: 0.02,
            avgLatencyMs: 150
          }
        })
      })

      expect(res.status).toBe(200)

      const vessel = registry.get("vessel-1")
      expect(vessel!.metadata!.lastMetrics).toEqual({
        executionsCompleted: 100,
        errorRate: 0.02,
        avgLatencyMs: 150
      })
    })

    test("returns 404 for unregistered vessel", async () => {
      const res = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: "unknown-vessel"
        })
      })

      expect(res.status).toBe(404)

      const data = await res.json()
      expect(data.error).toContain("not found")
    })

    test("validates vesselId is present", async () => {
      const res = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })

      expect(res.status).toBe(400)
    })
  })

  describe("DELETE /vessels/:vesselId", () => {
    beforeEach(() => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file"]
      })
    })

    test("unregisters a vessel", async () => {
      const res = await app.request("/vessels/vessel-1", {
        method: "DELETE"
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.success).toBe(true)

      // Verify vessel is removed
      const vessel = registry.get("vessel-1")
      expect(vessel).toBeUndefined()
    })

    test("returns 404 for unknown vessel", async () => {
      const res = await app.request("/vessels/unknown-vessel", {
        method: "DELETE"
      })

      expect(res.status).toBe(404)

      const data = await res.json()
      expect(data.error).toContain("not found")
    })
  })

  describe("POST /resolve", () => {
    beforeEach(() => {
      registry.register({
        vesselId: "vessel-1",
        vesselName: "V1",
        version: "1.0.0",
        endpoint: "http://localhost:8080",
        shapes: ["file", "codebase"],
        orgId: "org-123"
      })

      registry.register({
        vesselId: "vessel-2",
        vesselName: "V2",
        version: "1.0.0",
        endpoint: "http://localhost:8081",
        shapes: ["file"]
      })
    })

    test("resolves vesselCapability pointer", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.content.shape).toBe("file")
      expect(data.content.found).toBe(true)
      expect(data.content.vessels.length).toBe(2)
      expect(data.metadata.shape).toBe("vesselCapability")
    })

    test("resolves vesselEndpoint pointer", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselEndpoint",
            vesselId: "vessel-1"
          }
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.content.vesselId).toBe("vessel-1")
      expect(data.content.endpoint).toBe("http://localhost:8080")
      expect(data.content.health).toBe("healthy")
    })

    test("resolves vesselHealth pointer", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselHealth",
            vesselId: "vessel-1"
          }
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.content.vesselId).toBe("vessel-1")
      expect(data.content.status).toBe("healthy")
      expect(data.content.endpoint).toBeDefined()
    })

    test("resolves vesselRegistry pointer", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselRegistry"
          }
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.content.vessels.length).toBe(2)
      expect(data.content.totalCount).toBe(2)
    })

    test("filters vesselCapability by excludeVessels", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file",
            excludeVessels: ["vessel-1"]
          }
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.content.vessels.length).toBe(1)
      expect(data.content.vessels[0].vesselId).toBe("vessel-2")
    })

    test("filters vesselCapability by orgId", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file",
            orgId: "org-123"
          }
        })
      })

      expect(res.status).toBe(200)

      const data = await res.json()
      // Returns vessels with org-123 OR no orgId (public)
      // vessel-1 has org-123, vessel-2 has no orgId
      expect(data.content.vessels.length).toBe(2)
      expect(data.content.vessels.some((v: any) => v.vesselId === "vessel-1")).toBe(true)
      expect(data.content.vessels.some((v: any) => v.vesselId === "vessel-2")).toBe(true)
    })

    test("returns 404 for unknown vessel in vesselEndpoint", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "vesselEndpoint",
            vesselId: "unknown-vessel"
          }
        })
      })

      expect(res.status).toBe(404)
    })

    test("returns 400 for missing pointer", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })

      expect(res.status).toBe(400)
    })

    test("returns 404 for unknown pointer type", async () => {
      const res = await app.request("/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "unknownType"
          }
        })
      })

      expect(res.status).toBe(404)
    })
  })

  describe("GET /shapes", () => {
    test("returns resolvable shapes", async () => {
      const res = await app.request("/shapes")
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.shapes).toEqual([
        "vesselCapability",
        "vesselEndpoint",
        "vesselHealth",
        "vesselRegistry"
      ])
      expect(data.vessel).toBe("discovery")
      expect(data.version).toBeDefined()
    })
  })

  describe("GET /registry/shapes", () => {
    test("returns empty array when no vessels registered", async () => {
      const res = await app.request("/registry/shapes")
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.shapes).toEqual([])
    })

    test("returns registered shapes", async () => {
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

      const res = await app.request("/registry/shapes")
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.shapes.sort()).toEqual(["activityTemplate", "codebase", "file"])
    })
  })

  describe("GET /registry/stats", () => {
    test("returns registry statistics", async () => {
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

      const res = await app.request("/registry/stats")
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.totalVessels).toBe(2)
      expect(data.totalShapes).toBeGreaterThanOrEqual(2)
      expect(data.healthyCount).toBe(2)
    })
  })
})
