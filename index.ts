#!/usr/bin/env bun
/**
 * Discovery Vessel CLI Entry Point
 *
 * Starts the discovery vessel HTTP server.
 */

import { createServer, registry, getResolvableShapes } from "./src/index"

const PORT = parseInt(process.env.DISCOVERY_PORT ?? process.env.PORT ?? "8080", 10)
const HOST = process.env.DISCOVERY_HOST ?? "0.0.0.0"

// Handle graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[discovery-vessel] Received ${signal}, shutting down...`)
  registry.stop()
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// Self-register as a vessel
async function selfRegister() {
  const endpoint = process.env.DISCOVERY_SELF_ENDPOINT ??
    `http://localhost:${PORT}`

  registry.register({
    vesselId: process.env.DISCOVERY_VESSEL_ID ?? "discovery-vessel",
    vesselName: "Discovery Vessel",
    version: "0.1.0",
    endpoint,
    shapes: getResolvableShapes(),
    protocol: "http",
    // Discovery-vessel is shared infrastructure accessible to all tenants.
    systemVessel: true,
    metadata: {
      environment: process.env.KUBERNETES_SERVICE_HOST ? "k8s-cluster" : "local",
      selfRegistered: true
    }
  })

  console.log(`[discovery-vessel] Self-registered with shapes: ${getResolvableShapes().join(", ")}`)
}

// Start server
const app = createServer()

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    Discovery Vessel v0.1.0                    ║
╠══════════════════════════════════════════════════════════════╣
║  Resolves: vesselCapability, vesselEndpoint, vesselHealth,   ║
║            vesselRegistry                                     ║
╚══════════════════════════════════════════════════════════════╝
`)

console.log(`[discovery-vessel] Starting server on ${HOST}:${PORT}`)

// Self-register
await selfRegister()

// Export for Bun.serve. idleTimeout 0: a forwarded call is held open for as long as its producer's advertised bound,
// so the server's own 10 s idle default must not cut it first (a forward's only limit is src/index.ts' signal).
export default {
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  fetch: app.fetch
}
