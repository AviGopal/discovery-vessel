/**
 * Integration Tests
 *
 * End-to-end tests that verify the complete vessel lifecycle:
 * 1. Registration
 * 2. Heartbeat updates
 * 3. Discovery queries
 * 4. Deregistration
 * 5. TTL expiration
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createServer, registry } from "../src/index"
import { setIdentityValidator } from "../src/middleware/auth"
import type { Hono } from "hono"

// ---------------------------------------------------------------------------
// Shared auth helpers
// ---------------------------------------------------------------------------

const TEST_ORG_ID = "org-metabob"
const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "ApiKey test-key"
}

describe("Discovery Vessel Integration", () => {
  let app: Hono

  beforeEach(() => {
    // Install a mock identity validator so tests never hit a real HTTP endpoint.
    setIdentityValidator(async (_key: string) => ({
      orgId: TEST_ORG_ID,
      userId: "test-user",
      keyId: "test-key-id",
      scopes: ["read", "write"]
    }))

    app = createServer()
    // Clear registry before each test
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))
  })

  afterEach(() => {
    setIdentityValidator(null)
    registry.stop()
  })

  describe("Complete Vessel Lifecycle", () => {
    test("register → query → heartbeat → query → deregister", async () => {
      // 1. Register vessel
      const registerRes = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "minibob-1",
          vesselName: "MiniBob Instance 1",
          version: "0.5.0",
          endpoint: "http://minibob-1:8080",
          shapes: ["file", "codebase", "activityTemplate"],
          protocol: "http",
          orgId: "org-metabob",
          metadata: {
            environment: "k8s-cluster",
            podId: "minibob-1-xyz",
            replicaIndex: 0
          }
        })
      })

      expect(registerRes.status).toBe(201)
      const registerData = await registerRes.json()
      expect(registerData.success).toBe(true)

      // 2. Query for file shape
      const queryRes1 = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      expect(queryRes1.status).toBe(200)
      const queryData1 = await queryRes1.json()
      expect(queryData1.content.found).toBe(true)
      expect(queryData1.content.vessels.length).toBe(1)
      expect(queryData1.content.vessels[0].vesselId).toBe("minibob-1")

      // 3. Send heartbeat with metrics
      const heartbeatRes = await app.request("/heartbeat", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "minibob-1",
          metrics: {
            executionsCompleted: 42,
            errorRate: 0.05,
            avgLatencyMs: 250
          }
        })
      })

      expect(heartbeatRes.status).toBe(200)

      // 4. Query health
      const healthRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselHealth",
            vesselId: "minibob-1"
          }
        })
      })

      expect(healthRes.status).toBe(200)
      const healthData = await healthRes.json()
      expect(healthData.content.status).toBe("healthy")
      expect(healthData.content.metrics).toEqual({
        executionsCompleted: 42,
        errorRate: 0.05,
        avgLatencyMs: 250
      })

      // 5. Deregister
      const deregisterRes = await app.request("/vessels/minibob-1", {
        method: "DELETE",
        headers: { Authorization: "ApiKey test-key" }
      })

      expect(deregisterRes.status).toBe(200)

      // 6. Verify vessel is gone
      const queryRes2 = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      const queryData2 = await queryRes2.json()
      expect(queryData2.content.found).toBe(false)
      expect(queryData2.content.vessels.length).toBe(0)
    })
  })

  describe("Multi-Vessel Discovery", () => {
    test("multiple vessels with overlapping shapes", async () => {
      // Register 3 vessels with different capabilities
      const vessels = [
        {
          vesselId: "minibob-1",
          vesselName: "MiniBob 1",
          version: "0.5.0",
          endpoint: "http://minibob-1:8080",
          shapes: ["file", "codebase"]
        },
        {
          vesselId: "minibob-2",
          vesselName: "MiniBob 2",
          version: "0.5.0",
          endpoint: "http://minibob-2:8080",
          shapes: ["file", "activityTemplate"]
        },
        {
          vesselId: "activity-api",
          vesselName: "Activity API",
          version: "1.0.0",
          endpoint: "http://activity-api:8080",
          shapes: ["activityTemplate", "activityExecutionTrace"]
        }
      ]

      for (const vessel of vessels) {
        const res = await app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify(vessel)
        })
        expect(res.status).toBe(201)
      }

      // Query for file shape - should return 2 vessels
      const fileRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      const fileData = await fileRes.json()
      expect(fileData.content.vessels.length).toBe(2)
      expect(fileData.content.vessels.map((v: any) => v.vesselId).sort()).toEqual([
        "minibob-1",
        "minibob-2"
      ])

      // Query for activityTemplate - should return 2 vessels
      const templateRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityTemplate"
          }
        })
      })

      const templateData = await templateRes.json()
      expect(templateData.content.vessels.length).toBe(2)

      // Query for activityExecutionTrace - should return 1 vessel
      const traceRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityExecutionTrace"
          }
        })
      })

      const traceData = await traceRes.json()
      expect(traceData.content.vessels.length).toBe(1)
      expect(traceData.content.vessels[0].vesselId).toBe("activity-api")
    })

    test("excludeVessels filter in multi-vessel scenario", async () => {
      // Register multiple vessels
      const vessels = ["vessel-1", "vessel-2", "vessel-3"]
      for (const vesselId of vessels) {
        await app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify({
            vesselId,
            vesselName: vesselId,
            version: "1.0.0",
            endpoint: `http://${vesselId}:8080`,
            shapes: ["file"]
          })
        })
      }

      // Query excluding vessel-1 and vessel-3
      const res = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file",
            excludeVessels: ["vessel-1", "vessel-3"]
          }
        })
      })

      const data = await res.json()
      expect(data.content.vessels.length).toBe(1)
      expect(data.content.vessels[0].vesselId).toBe("vessel-2")
    })
  })

  describe("Multi-Tenant Isolation", () => {
    test("vessels filtered by organization", async () => {
      // Register vessels directly in the registry (bypasses auth middleware so
      // we can use multiple different orgIds without changing the mock).
      registry.register({
        vesselId: "vessel-org1-a",
        vesselName: "Org1 Vessel A",
        version: "1.0.0",
        endpoint: "http://org1-a:8080",
        shapes: ["file"],
        orgId: "org-1"
      })

      registry.register({
        vesselId: "vessel-org1-b",
        vesselName: "Org1 Vessel B",
        version: "1.0.0",
        endpoint: "http://org1-b:8080",
        shapes: ["file"],
        orgId: "org-1"
      })

      registry.register({
        vesselId: "vessel-org2",
        vesselName: "Org2 Vessel",
        version: "1.0.0",
        endpoint: "http://org2:8080",
        shapes: ["file"],
        orgId: "org-2"
      })

      // System vessel (shared infrastructure, visible to all orgs)
      registry.register({
        vesselId: "vessel-system",
        vesselName: "System Vessel",
        version: "1.0.0",
        endpoint: "http://system:8080",
        shapes: ["file"],
        systemVessel: true
      })

      // Vessel with no orgId and no systemVessel — NOT visible in org-scoped queries
      registry.register({
        vesselId: "vessel-no-org",
        vesselName: "No-Org Vessel",
        version: "1.0.0",
        endpoint: "http://no-org:8080",
        shapes: ["file"]
      })

      // Query for org-1
      const org1Res = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file",
            orgId: "org-1"
          }
        })
      })

      const org1Data = await org1Res.json()
      // Should return 2 org-1 vessels + 1 system vessel = 3 total
      // vessel-no-org is excluded because it has no orgId and no systemVessel
      expect(org1Data.content.vessels.length).toBe(3)
      const vesselIds = org1Data.content.vessels.map((v: any) => v.vesselId).sort()
      expect(vesselIds).toEqual(["vessel-org1-a", "vessel-org1-b", "vessel-system"])

      // Query for org-2
      const org2Res = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file",
            orgId: "org-2"
          }
        })
      })

      const org2Data = await org2Res.json()
      // Should return 1 org-2 vessel + 1 system vessel = 2 total
      expect(org2Data.content.vessels.length).toBe(2)
      const org2VesselIds = org2Data.content.vessels.map((v: any) => v.vesselId).sort()
      expect(org2VesselIds).toEqual(["vessel-org2", "vessel-system"])
    })
  })

  describe("Registry Stats and Metadata", () => {
    test("stats reflect registry state changes", async () => {
      // Initial stats
      const stats1Res = await app.request("/registry/stats")
      const stats1 = await stats1Res.json()
      const initialCount = stats1.totalVessels

      // Register 2 vessels
      await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "v1",
          vesselName: "V1",
          version: "1.0.0",
          endpoint: "http://v1:8080",
          shapes: ["file", "codebase"]
        })
      })

      await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "v2",
          vesselName: "V2",
          version: "1.0.0",
          endpoint: "http://v2:8080",
          shapes: ["activityTemplate"]
        })
      })

      // Stats after registration
      const stats2Res = await app.request("/registry/stats")
      const stats2 = await stats2Res.json()
      expect(stats2.totalVessels).toBe(initialCount + 2)
      expect(stats2.totalShapes).toBeGreaterThanOrEqual(3)
      expect(stats2.healthyCount).toBe(initialCount + 2)

      // Deregister one
      await app.request("/vessels/v1", { method: "DELETE", headers: { Authorization: "ApiKey test-key" } })

      // Stats after deregistration
      const stats3Res = await app.request("/registry/stats")
      const stats3 = await stats3Res.json()
      expect(stats3.totalVessels).toBe(initialCount + 1)
    })
  })

  describe("Re-registration Scenarios", () => {
    test("re-registration updates shape index correctly", async () => {
      // Initial registration
      await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "vessel-1",
          vesselName: "V1",
          version: "1.0.0",
          endpoint: "http://v1:8080",
          shapes: ["file", "codebase"]
        })
      })

      // Verify initial shapes
      const res1 = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: { type: "vesselCapability", shape: "file" }
        })
      })
      const data1 = await res1.json()
      expect(data1.content.vessels.length).toBe(1)

      // Re-register with different shapes
      await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "vessel-1",
          vesselName: "V1",
          version: "2.0.0",
          endpoint: "http://v1:8080",
          shapes: ["activityTemplate"]
        })
      })

      // Old shape should not find vessel
      const res2 = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: { type: "vesselCapability", shape: "file" }
        })
      })
      const data2 = await res2.json()
      expect(data2.content.vessels.length).toBe(0)

      // New shape should find vessel
      const res3 = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: { type: "vesselCapability", shape: "activityTemplate" }
        })
      })
      const data3 = await res3.json()
      expect(data3.content.vessels.length).toBe(1)
      expect(data3.content.vessels[0].vesselId).toBe("vessel-1")
    })
  })

  describe("Error Handling", () => {
    test("graceful handling of malformed requests", async () => {
      const testCases = [
        {
          endpoint: "/resolve",
          body: { pointer: {} }, // Missing type
          expectedStatus: 400
        },
        {
          endpoint: "/register",
          body: { vesselId: "v1" }, // Missing required fields
          expectedStatus: 400
        },
        {
          endpoint: "/heartbeat",
          body: {}, // Missing vesselId
          expectedStatus: 400
        }
      ]

      for (const testCase of testCases) {
        const res = await app.request(testCase.endpoint, {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify(testCase.body)
        })

        expect(res.status).toBe(testCase.expectedStatus)
        const data = await res.json()
        expect(data.error).toBeDefined()
      }
    })
  })

  describe("Phase 1: Vessel Registration Fields", () => {
    test("1. Register stateful vessel with complete state object including lastMigration, schemaVersion, recordCount, and healthMetrics", async () => {
      // Register a stateful vessel with comprehensive state tracking
      const registerRes = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "stateful-vessel-1",
          vesselName: "Stateful Activity Processor",
          version: "1.5.2",
          endpoint: "http://stateful-vessel-1:8080",
          shapes: ["activityTemplate", "activityExecutionTrace"],
          protocol: "http",
          stateful: true,
          state: {
            lastMigration: "2024-01-15T10:30:00Z",
            schemaVersion: "v2.1",
            recordCount: 15234,
            healthMetrics: {
              errorRate: 0.02,
              avgLatencyMs: 125,
              lastBackup: "2024-01-20T02:00:00Z"
            }
          }
        })
      })

      expect(registerRes.status).toBe(201)
      const registerData = await registerRes.json()
      expect(registerData.success).toBe(true)
      expect(registerData.vesselId).toBe("stateful-vessel-1")

      // Verify the vessel was registered and we can query it
      const queryRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityTemplate"
          }
        })
      })

      expect(queryRes.status).toBe(200)
      const queryData = await queryRes.json()
      expect(queryData.content.found).toBe(true)
      const vessel = queryData.content.vessels.find((v: any) => v.vesselId === "stateful-vessel-1")
      expect(vessel).toBeDefined()
      expect(vessel.vesselId).toBe("stateful-vessel-1")
    })

    test("2. Register vessel with resolvers array containing kubectl and helm resolvers with deterministic tier and operations", async () => {
      // Register a vessel with multiple resolver capabilities
      const registerRes = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "k8s-ops-vessel",
          vesselName: "Kubernetes Operations Vessel",
          version: "2.1.0",
          endpoint: "http://k8s-ops:8080",
          shapes: ["file", "codebase"],
          protocol: "http",
          resolvers: [
            {
              id: "kubectl",
              tier: "deterministic",
              operations: ["get", "apply", "delete", "patch"]
            },
            {
              id: "helm",
              tier: "deterministic",
              operations: ["install", "upgrade", "uninstall", "rollback"]
            }
          ]
        })
      })

      expect(registerRes.status).toBe(201)
      const registerData = await registerRes.json()
      expect(registerData.success).toBe(true)
      expect(registerData.vesselId).toBe("k8s-ops-vessel")

      // Verify vessel is discoverable by capability
      const queryRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      expect(queryRes.status).toBe(200)
      const queryData = await queryRes.json()
      expect(queryData.content.found).toBe(true)
      const vessel = queryData.content.vessels.find((v: any) => v.vesselId === "k8s-ops-vessel")
      expect(vessel).toBeDefined()
      expect(vessel.vesselName).toBe("Kubernetes Operations Vessel")
    })

    test("3. Register vessel with peer discovery fields (discoveredVia='peer', discoveredBy='minibob-001')", async () => {
      // Register a vessel that was discovered via peer discovery
      const registerRes = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "discovered-vessel-peer",
          vesselName: "Peer-Discovered Vessel",
          version: "1.0.5",
          endpoint: "http://discovered-vessel:8080",
          shapes: ["activityTemplate"],
          protocol: "http",
          discoveredVia: "peer",
          discoveredBy: "minibob-001"
        })
      })

      expect(registerRes.status).toBe(201)
      const registerData = await registerRes.json()
      expect(registerData.success).toBe(true)
      expect(registerData.vesselId).toBe("discovered-vessel-peer")

      // Verify vessel is discoverable
      const queryRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityTemplate"
          }
        })
      })

      expect(queryRes.status).toBe(200)
      const queryData = await queryRes.json()
      expect(queryData.content.found).toBe(true)
      const vessel = queryData.content.vessels.find((v: any) => v.vesselId === "discovered-vessel-peer")
      expect(vessel).toBeDefined()
      expect(vessel.vesselName).toBe("Peer-Discovered Vessel")
    })

    test("4. Register vessel with enhanced metadata (environment='k8s-cluster', cluster='prod', namespace='activity-system', podId, deployedAt)", async () => {
      // Register a vessel with full Kubernetes deployment context
      const deployedAtTimestamp = Date.now()
      const registerRes = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "k8s-deployment-vessel",
          vesselName: "K8s Cluster Vessel",
          version: "2.3.0",
          endpoint: "http://vessel-prod.activity-system.svc.cluster.local:8080",
          shapes: ["file", "activityTemplate", "activityExecutionTrace"],
          protocol: "http",
          metadata: {
            environment: "k8s-cluster",
            cluster: "prod",
            namespace: "activity-system",
            podId: "vessel-prod-7d8f4c9b2-xyz9w",
            replicaIndex: 0,
            deployedAt: deployedAtTimestamp,
            clusterMode: true
          }
        })
      })

      expect(registerRes.status).toBe(201)
      const registerData = await registerRes.json()
      expect(registerData.success).toBe(true)
      expect(registerData.vesselId).toBe("k8s-deployment-vessel")

      // Verify vessel is discoverable and metadata persists
      const queryRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityExecutionTrace"
          }
        })
      })

      expect(queryRes.status).toBe(200)
      const queryData = await queryRes.json()
      expect(queryData.content.found).toBe(true)
      const vessel = queryData.content.vessels.find((v: any) => v.vesselId === "k8s-deployment-vessel")
      expect(vessel).toBeDefined()
      expect(vessel.vesselName).toBe("K8s Cluster Vessel")
      expect(vessel.endpoint).toContain("activity-system")
    })

    test("5. Verify commitSha extraction from version tag like '1.2.6-abc1234'", async () => {
      // Register vessel with explicit commitSha
      const registerRes1 = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "commit-tracked-vessel-1",
          vesselName: "Commit-Tracked Vessel 1",
          version: "1.2.6-abc1234",
          commitSha: "abc1234",
          endpoint: "http://commit-vessel-1:8080",
          shapes: ["file", "codebase"],
          protocol: "http"
        })
      })

      expect(registerRes1.status).toBe(201)
      const registerData1 = await registerRes1.json()
      expect(registerData1.success).toBe(true)
      expect(registerData1.vesselId).toBe("commit-tracked-vessel-1")

      // Register another vessel with different commit
      const registerRes2 = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "commit-tracked-vessel-2",
          vesselName: "Commit-Tracked Vessel 2",
          version: "2.0.0-def5678",
          commitSha: "def5678",
          endpoint: "http://commit-vessel-2:8080",
          shapes: ["activityTemplate"],
          protocol: "http"
        })
      })

      expect(registerRes2.status).toBe(201)
      const registerData2 = await registerRes2.json()
      expect(registerData2.success).toBe(true)
      expect(registerData2.vesselId).toBe("commit-tracked-vessel-2")

      // Verify both vessels are discoverable
      const queryRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      expect(queryRes.status).toBe(200)
      const queryData = await queryRes.json()
      expect(queryData.content.found).toBe(true)
      const vessel1 = queryData.content.vessels.find((v: any) => v.vesselId === "commit-tracked-vessel-1")
      expect(vessel1).toBeDefined()
      expect(vessel1.vesselName).toBe("Commit-Tracked Vessel 1")
    })

    test("Complex scenario: Register vessel with all Phase 1 features combined", async () => {
      // Register a complex vessel with all Phase 1 features
      const deployedAtTimestamp = Date.now()
      const registerRes = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "complex-phase1-vessel",
          vesselName: "Complex Phase 1 Test Vessel",
          version: "3.2.1-xyz9876",
          commitSha: "xyz9876",
          endpoint: "http://complex-vessel.activity-system.svc.cluster.local:8080",
          shapes: ["file", "codebase", "activityTemplate", "activityExecutionTrace"],
          protocol: "http",
          orgId: "org-metabob",
          stateful: true,
          state: {
            lastMigration: "2024-01-20T08:15:00Z",
            schemaVersion: "v3.0",
            recordCount: 42891,
            healthMetrics: {
              errorRate: 0.01,
              avgLatencyMs: 95,
              lastBackup: "2024-01-21T03:00:00Z"
            }
          },
          resolvers: [
            {
              id: "kubectl",
              tier: "deterministic",
              operations: ["get", "apply", "patch"]
            },
            {
              id: "helm",
              tier: "deterministic",
              operations: ["install", "upgrade"]
            },
            {
              id: "bash",
              tier: "deterministic",
              operations: ["exec"]
            }
          ],
          discoveredVia: "peer",
          discoveredBy: "discovery-bootstrap-001",
          metadata: {
            environment: "k8s-cluster",
            cluster: "production",
            namespace: "activity-system",
            podId: "complex-vessel-abc123-def456",
            replicaIndex: 2,
            deployedAt: deployedAtTimestamp,
            clusterMode: true
          }
        })
      })

      expect(registerRes.status).toBe(201)
      const registerData = await registerRes.json()
      expect(registerData.success).toBe(true)
      expect(registerData.vesselId).toBe("complex-phase1-vessel")

      // Verify vessel is discoverable by multiple shapes
      const fileShapeRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "file"
          }
        })
      })

      expect(fileShapeRes.status).toBe(200)
      const fileData = await fileShapeRes.json()
      expect(fileData.content.found).toBe(true)
      expect(fileData.content.vessels.some((v: any) => v.vesselId === "complex-phase1-vessel")).toBe(true)

      // Verify another shape
      const templateShapeRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityTemplate"
          }
        })
      })

      expect(templateShapeRes.status).toBe(200)
      const templateData = await templateShapeRes.json()
      expect(templateData.content.found).toBe(true)
      expect(templateData.content.vessels.some((v: any) => v.vesselId === "complex-phase1-vessel")).toBe(true)

      // Verify yet another shape
      const traceShapeRes = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: {
            type: "vesselCapability",
            shape: "activityExecutionTrace"
          }
        })
      })

      expect(traceShapeRes.status).toBe(200)
      const traceData = await traceShapeRes.json()
      expect(traceData.content.found).toBe(true)
      expect(traceData.content.vessels.some((v: any) => v.vesselId === "complex-phase1-vessel")).toBe(true)
    })
  })
})
