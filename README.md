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

### GET /bootstrap

The single public (pre-auth) read a client needs to **point-and-go**. A vessel or
spoke pointed at a discovery endpoint fetches `/bootstrap` and learns the relay
anchor, identity authority, and canonical discovery endpoint — everything it needs
to join the overlay. No API key is required for this route (a fresh client can read
it before it holds a key); the response carries only non-secret routing anchors.

```bash
curl <discovery-endpoint>/bootstrap
```

Response:
```json
{
  "relay_multiaddrs": ["<relay-multiaddr>"],
  "identity_endpoint": "<identity-endpoint>",
  "discovery_endpoint": "<discovery-endpoint>",
  "prefer_transport": "libp2p"
}
```

- `relay_multiaddrs` comes from the `RELAY_MULTIADDR` env when set; when unset it is
  **derived** from the registered circuit multiaddrs, so bootstrap works even if this
  process was never handed a relay directly.
- `identity_endpoint` / `discovery_endpoint` are the public anchors, resolved from the
  public-URL / public-IP env vars (see [Environment Variables](#environment-variables)).
- `prefer_transport: "libp2p"` tells the client to reserve a circuit on the relay and
  dial vessels over the overlay, falling back to direct HTTP only when no circuit exists.

## Integration with Other Vessels

### The Point-and-Go Door

Discovery is the single door a client points at to join a substrate: a client/spoke
supplies **`<discovery-endpoint>` + `<api-key>` and nothing else**. It fetches
`<discovery-endpoint>/bootstrap`, takes the relay anchor, reserves a p2p circuit
(preferring the libp2p overlay), and registers itself. A valid API key is the sole
gate; the relay, identity authority, and discovery endpoint are all read from
`/bootstrap` at use time.

The federation transport / obsidian sidecar performs this automatically when no relay
is configured. A hand-set `RELAY_MULTIADDR` is now an **optional override** — it used
to go stale on every relay restart (the pinned relay peer-id drifted), which is exactly
the failure `/bootstrap` fixes by serving the current anchor on demand.

> Note: this "point-and-go" door is the `GET /bootstrap` route above — not to be
> confused with statically locating discovery itself. When a client already knows a
> fixed discovery address (e.g. a `DISCOVERY_VESSEL_ENDPOINT` env var or a fixed DNS
> name like `discovery.activity-system.svc.cluster.local`), it points there and reads
> everything else from `/bootstrap`.

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
│  │  GET  /bootstrap  - Public point-and-go anchors           │  │
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

The following are read only by `GET /bootstrap` to advertise the public join anchors.
All are optional and bootstrap-only (law 1: frozen at process start, they configure
what `/bootstrap` returns, they do not steer runtime behavior). When unset, the relay
list is derived from registered circuit multiaddrs.

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_MULTIADDR` | (derived) | Comma-separated relay multiaddr override; when unset, derived from registered circuit multiaddrs |
| `PUBLIC_IP` / `FED_PUBLIC_IP` | (unset) | Public IP used to compose identity/discovery anchors when explicit public URLs are absent |
| `IDENTITY_PUBLIC_URL` | (unset) | Explicit public identity-vessel URL returned as `identity_endpoint` |
| `IDENTITY_PUBLIC_PORT` | `18101` | Port paired with `PUBLIC_IP` to compose the identity anchor |
| `IDENTITY_VESSEL_URL` | (unset) | Fallback identity URL (also used by auth middleware) |
| `DISCOVERY_PUBLIC_URL` | (unset) | Explicit public discovery URL returned as `discovery_endpoint` |
| `DISCOVERY_PUBLIC_PORT` | `18100` | Port paired with `PUBLIC_IP` to compose the discovery anchor |

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
