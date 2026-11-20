#!/usr/bin/env bun
/**
 * Discovery Vessel CLI Entry Point
 *
 * Starts the discovery vessel HTTP server.
 */

import { createServer, registry, getResolvableShapes } from "./src/index"
import { keepSelfRegistered } from "./src/self"
import { setClientObserver, validateApiKeyNow } from "./src/middleware/auth"
import { clientObserver, writeConnectedVia } from "./src/client-connected"
import { selfVesselId } from "./src/peer-set-source"

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

  keepSelfRegistered(selfVesselId(), endpoint)

  console.log(`[discovery-vessel] Self-registered with shapes: ${getResolvableShapes().join(", ")}`)
}

// Start server
const app = createServer()
// The first outside request of each key is recorded (src/client-connected.ts)
setClientObserver(clientObserver(writeConnectedVia(`http://127.0.0.1:${PORT}`, () => process.env.METABOB_API_KEY ?? "", selfVesselId,
  async (k) => (await validateApiKeyNow(k))?.keyId ?? null)))

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
