#!/usr/bin/env bun
/**
 * Discovery Vessel CLI Entry Point
 *
 * Starts the discovery vessel HTTP server.
 */

import { createServer, registry, getResolvableShapes } from "./src/index"
import { keepSelfRegistered } from "./src/self"

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

// Self-register as a vessel, and keep the row fresh (src/self.ts)
async function selfRegister() {
  const endpoint = process.env.DISCOVERY_SELF_ENDPOINT ??
    `http://localhost:${PORT}`

  keepSelfRegistered(process.env.DISCOVERY_VESSEL_ID ?? "discovery-vessel", endpoint)

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

// Export for Bun.serve
export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch
}
