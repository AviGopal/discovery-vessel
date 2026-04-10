# Discovery Vessel

A vessel that resolves discovery-related impulse types. Following the impulse-activity foundation: **resolvers live where data lives**.

## Core Concept

Discovery is not special infrastructure - it's **just another vessel** that happens to resolve discovery impulses. Any vessel can implement these resolvers; this one provides a canonical implementation.

## Impulse Types Resolved

| Type | Purpose | Example Use Case |
|------|---------|-----------------|
| `vesselCapability` | Find vessels that can resolve a shape | "Who can resolve `k8s_resource`?" |
| `vesselEndpoint` | Get endpoint URL for a vessel | "Where is vessel `minibob-pod-1`?" |
| `vesselHealth` | Check if a vessel is responsive | "Is `k8s-vessel` healthy?" |
| `vesselRegistry` | List all registered vessels | "Show me all vessels" |

## Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run start

# Or with custom port
PORT=9000 bun run start
```

## API Endpoints

### POST /resolve

Resolve a discovery impulse.

```bash
# Find vessels that can resolve "k8s_resource"
curl -X POST http://localhost:8080/resolve \
  -H "Content-Type: application/json" \
  -d '{"pointer": {"type": "vesselCapability", "shape": "k8s_resource"}}'
```

Response:
```json
{
  "content": {
    "shape": "k8s_resource",
    "vessels": [
      {
        "vesselId": "k8s-vessel-001",
        "vesselName": "k8s-vessel",
        "endpoint": "http://k8s-vessel:8080",
        "confidence": 1.0,
        "lastSeen": "2026-04-10T12:00:00.000Z"
      }
    ],
    "found": true
  }
}
```

### POST /register

Register a vessel's capabilities.

```bash
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{
    "vesselId": "minibob-pod-1",
    "vesselName": "MiniBob",
    "version": "0.4.1",
    "endpoint": "http://minibob:8080",
    "shapes": ["file", "memo", "directoryTree", "gitDiff"]
  }'
```

### POST /heartbeat

Send heartbeat to extend registration TTL.

```bash
curl -X POST http://localhost:8080/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"vesselId": "minibob-pod-1"}'
```

### GET /health

Health check endpoint.

```bash
curl http://localhost:8080/health
```

## Integration with Other Vessels

### How Vessels Find Discovery Vessel (Bootstrap)

Discovery vessel is found via static configuration:

```bash
# Environment variable (recommended)
DISCOVERY_VESSEL_ENDPOINT=http://discovery.activity-system.svc.cluster.local:8080

# Or fixed DNS in Kubernetes
discovery.activity-system.svc.cluster.local
```

### How MiniBob Uses Discovery

```typescript
// 1. MiniBob needs to resolve "terminal_snapshot" impulse
const impulse = { type: "terminal_snapshot", terminalId: "term_123" }

// 2. MiniBob doesn't have a local resolver for this type
//    So it queries discovery vessel
const discoveryImpulse = {
  type: "vesselCapability",
  shape: "terminal_snapshot"
}

const response = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
  method: "POST",
  body: JSON.stringify({ pointer: discoveryImpulse })
})

const { content } = await response.json()
// → { vessels: [{ endpoint: "http://terminal-vessel:8080" }] }

// 3. MiniBob delegates to the discovered vessel
const result = await fetch(`${content.vessels[0].endpoint}/resolve`, {
  method: "POST",
  body: JSON.stringify({ pointer: impulse })
})
```

### Vessel Registration on Startup

Vessels should register on startup and send heartbeats:

```typescript
// On startup
await fetch(`${DISCOVERY_ENDPOINT}/register`, {
  method: "POST",
  body: JSON.stringify({
    vesselId: "my-vessel-001",
    vesselName: "My Vessel",
    version: "1.0.0",
    endpoint: "http://my-vessel:8080",
    shapes: ["my_custom_shape", "another_shape"]
  })
})

// Every 2 minutes
setInterval(async () => {
  await fetch(`${DISCOVERY_ENDPOINT}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ vesselId: "my-vessel-001" })
  })
}, 120_000)
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    DISCOVERY VESSEL                              │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────┐  │
│  │   Vessel         │    │        Resolvers                  │  │
│  │   Registry       │◄───┤                                   │  │
│  │                  │    │  vesselCapability  → findByShape  │  │
│  │  vesselId →      │    │  vesselEndpoint   → get           │  │
│  │  registration    │    │  vesselHealth     → healthCheck   │  │
│  │                  │    │  vesselRegistry   → list          │  │
│  │  shape →         │    │                                   │  │
│  │  vesselIds       │    └──────────────────────────────────┘  │
│  └──────────────────┘                                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     HTTP Server                           │  │
│  │  POST /resolve    - Resolve discovery impulses            │  │
│  │  POST /register   - Register vessel capabilities          │  │
│  │  POST /heartbeat  - Extend registration TTL               │  │
│  │  GET  /health     - Health check                          │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Self-Registration

Discovery vessel registers itself with the shapes it can resolve:
- `vesselCapability`
- `vesselEndpoint`
- `vesselHealth`
- `vesselRegistry`

This means discovery vessel can be discovered through itself (meta!).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `DISCOVERY_PORT` | `8080` | Alias for PORT |
| `DISCOVERY_HOST` | `0.0.0.0` | Server bind address |
| `DISCOVERY_VESSEL_ID` | `discovery-vessel` | ID for self-registration |
| `DISCOVERY_SELF_ENDPOINT` | `http://localhost:8080` | Endpoint for self-registration |

## TTL and Expiration

- Registrations expire after **5 minutes** without heartbeat
- Heartbeat interval should be **2 minutes** (returned in response)
- Expired registrations are automatically pruned

## Foundation Alignment

This vessel follows the Impulse-Activity Foundation:

1. **Impulses are data** - Discovery queries are impulse pointers
2. **Resolvers live where data lives** - Registry data lives here, so resolvers live here
3. **Vessels are composable** - Discovery vessel is just a vessel, can be swapped
4. **No special cases** - Discovery uses the same impulse resolution pattern as everything else

## License

MIT
