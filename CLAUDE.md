# CLAUDE.md - Discovery Vessel

Agent guidance for working with discovery-vessel.

## Overview

Discovery-vessel resolves discovery-related impulse types. It's not special infrastructure - it's **just another vessel** that happens to implement discovery capabilities.

**Core principle**: Resolvers live where data lives.

**Point-and-go door**: discovery is also the single federation door. It serves a
public (pre-auth) `GET /bootstrap` returning the relay anchor, identity authority, and
canonical discovery endpoint (`{relay_multiaddrs, identity_endpoint, discovery_endpoint,
prefer_transport: "libp2p"}`), so a client/spoke joins with only `<discovery-endpoint>`
+ `<api-key>` — everything else is read from `/bootstrap` at use time, not pinned in
env. The handler lives in `src/index.ts`; the route is exempted from auth via
`PUBLIC_PATHS` in `src/middleware/auth.ts`.

## Quick Reference

```bash
bun install          # Install dependencies
bun run start        # Start server (port 8080)
bun run dev          # Start with hot reload
bun test             # Run tests
bun run typecheck    # Type check
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | HTTP server (Hono) |
| `src/registry.ts` | Vessel registry with TTL |
| `src/resolvers.ts` | Impulse type resolvers |
| `src/types.ts` | TypeScript types |

## Impulse Types

| Type | Purpose |
|------|---------|
| `vesselCapability` | Find vessels by shape |
| `vesselEndpoint` | Get vessel URL |
| `vesselHealth` | Check vessel status |
| `vesselRegistry` | List all vessels |

## HTTP Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /resolve` | required | Resolve a discovery impulse |
| `POST /register` | required | Register vessel capabilities |
| `POST /heartbeat` | required | Extend registration TTL |
| `GET /health` | public | Health check |
| `GET /bootstrap` | public | Point-and-go anchors (relay + identity + discovery) |

## Key Behaviors

- **TTL**: Registrations expire after 5 minutes without heartbeat
- **Heartbeat**: Recommended every 2 minutes
- **Self-registration**: Registers itself on startup
- **In-memory**: No persistence (vessels re-register on restart)
- **Single replica**: Multiple replicas have separate registries

## Adding Features

1. Update types in `src/types.ts`
2. Add resolver in `src/resolvers.ts`
3. Add endpoint in `src/index.ts`
4. Add tests in `test/`
5. Update README.md

## See Also

- [README.md](./README.md) - Full documentation
- [CHANGELOG.md](./CHANGELOG.md) - Version history
