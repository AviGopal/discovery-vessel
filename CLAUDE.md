# CLAUDE.md - Discovery Vessel

This file provides guidance to Claude Code (claude.ai/code) when working with the discovery-vessel repository.

## Overview

**Discovery-vessel** is a vessel that resolves discovery-related impulse types. It's not special infrastructure - it's **just another vessel** that happens to implement discovery capabilities.

**Core principle**: Resolvers live where data lives. Discovery-vessel stores the vessel registry, so it resolves discovery impulses.

## Canonical Documentation

**Primary reference**: [README.md](./README.md) - Complete vessel documentation

**External references**:
- [DISCOVERY_INTEGRATION.md](/home/avi/documents/work/exp-repo/metabob-devbob/DISCOVERY_INTEGRATION.md) - System-wide integration guide
- [IMPULSE_ACTIVITY_FOUNDATION.md](/home/avi/documents/work/exp-repo/metabob-devbob/docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md) - System foundation

## Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run start

# Run tests
bun test

# Run comprehensive test suite
./test/run-all-tests.sh --all
```

## Repository Structure

```
discovery-vessel/
├── README.md              # Primary documentation
├── CLAUDE.md              # This file
├── index.ts               # Server entry point
├── package.json
├── tsconfig.json
├── Dockerfile
├── src/
│   ├── index.ts           # HTTP server (Hono)
│   ├── registry.ts        # Vessel registry logic
│   ├── resolvers.ts       # Impulse resolvers
│   ├── metrics.ts         # Metrics tracking
│   └── types.ts           # TypeScript types
└── test/
    ├── README.md          # Test suite guide
    ├── INDEX.md           # Test file index
    ├── QUICK_START.md     # Quick reference
    ├── TEST_EXECUTION_REPORT.md
    ├── registry.test.ts   # Unit tests
    ├── endpoints.test.ts  # HTTP endpoint tests
    ├── integration.test.ts
    ├── load/              # Load tests
    ├── chaos/             # Chaos engineering tests
    └── security/          # Security audit tests
```

## Impulse Types Resolved

| Type | Purpose | Resolver |
|------|---------|----------|
| `vesselCapability` | Find vessels that can resolve a shape | `findByShape()` |
| `vesselEndpoint` | Get endpoint URL for a vessel | `get()` |
| `vesselHealth` | Check if vessel is responsive | `healthCheck()` |
| `vesselRegistry` | List all registered vessels | `list()` |

## Key Concepts

### 1. Vessel Registry

In-memory registry of vessels and their capabilities:

```typescript
// Registry entry structure
{
  vesselId: string
  vesselName: string
  endpoint: string
  shapes: string[]          // Impulse types this vessel can resolve
  version: string
  registeredAt: Date
  lastHeartbeat: Date
  expiresAt: Date          // TTL-based expiry
  orgId?: string           // Optional multi-tenant isolation
}
```

### 2. TTL-Based Expiry

Vessels are automatically removed if they miss heartbeats:
- **Registration**: 5 minute TTL
- **Heartbeat**: Resets TTL to 5 minutes
- **Recommended interval**: 2 minutes
- **Auto-cleanup**: Expired vessels removed automatically

### 3. Self-Registration

Discovery-vessel registers itself on startup with the shapes it can resolve. This enables discovery-through-discovery (meta!).

### 4. Bootstrap Problem

Discovery-vessel is found via static configuration (environment variable or DNS), not through discovery. All other vessels use discovery to find each other.

## Development Workflows

### Local Development

```bash
# Start discovery-vessel
cd repos/discovery-vessel
bun run dev

# In another terminal, test registration
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{
    "vesselId": "test-vessel",
    "vesselName": "Test Vessel",
    "version": "1.0.0",
    "endpoint": "http://localhost:9000",
    "shapes": ["testShape"]
  }'

# Query for vessels
curl -X POST http://localhost:8080/resolve \
  -H "Content-Type: application/json" \
  -d '{"pointer": {"type": "vesselCapability", "shape": "testShape"}}'
```

### Testing

See [test/README.md](./test/README.md) for comprehensive testing guide.

```bash
# Run all tests
./test/run-all-tests.sh --all

# Run specific test categories
./test/run-all-tests.sh --unit --integration    # Fast tests (~15s)
./test/run-all-tests.sh --load                  # Load tests (~30-60s)
./test/run-all-tests.sh --chaos                 # Chaos tests (~30-45s)
./test/run-all-tests.sh --security              # Security tests (~20-30s)

# Generate HTML report
./test/run-all-tests.sh --all --report
```

### Deployment

Discovery-vessel deploys via helmfile in the main deployment repository:

```bash
# Deploy to local cluster
cd repos/deployment
./scripts/deploy-local.sh

# Deploy to canary
git push origin dev  # Triggers CI/CD

# Deploy to production
./scripts/promote-canary-to-production.sh
```

## API Endpoints

### POST /resolve
Resolve a discovery impulse.

```bash
curl -X POST http://localhost:8080/resolve \
  -H "Content-Type: application/json" \
  -d '{"pointer": {"type": "vesselCapability", "shape": "k8s_resource"}}'
```

### POST /register
Register a vessel's capabilities.

```bash
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{
    "vesselId": "my-vessel-001",
    "vesselName": "My Vessel",
    "version": "1.0.0",
    "endpoint": "http://my-vessel:8080",
    "shapes": ["shape1", "shape2"]
  }'
```

### POST /heartbeat
Extend registration TTL.

```bash
curl -X POST http://localhost:8080/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"vesselId": "my-vessel-001"}'
```

### GET /health
Health check endpoint.

```bash
curl http://localhost:8080/health
```

## Foundation Alignment

This vessel follows the Impulse-Activity Foundation:

1. **Impulses are data** - Discovery queries are impulse pointers
2. **Resolvers live where data lives** - Registry data lives here, so resolvers live here
3. **Vessels are composable** - Discovery vessel is just a vessel, can be swapped
4. **No special cases** - Discovery uses the same impulse resolution pattern as everything else

### Not Special Infrastructure

Discovery-vessel is NOT:
- A service mesh controller
- A universal service registry
- A DNS replacement
- A load balancer

Discovery-vessel IS:
- A vessel that resolves discovery impulses
- A registry of vessel capabilities
- Part of the impulse resolution chain
- Replaceable by any vessel that implements the same resolvers

## Common Operations

### Adding a New Impulse Type

1. Update `src/types.ts` with new pointer type
2. Add resolver in `src/resolvers.ts`
3. Update README.md documentation
4. Add tests in `test/endpoints.test.ts`

### Debugging Registration Issues

```bash
# Check vessel logs
kubectl logs -n activity-system deploy/discovery-vessel | grep -i register

# List all registered vessels
curl http://localhost:8080/vessels

# Query for specific shape
curl -X POST http://localhost:8080/resolve \
  -H "Content-Type: application/json" \
  -d '{"pointer": {"type": "vesselCapability", "shape": "YOUR_SHAPE"}}'
```

### Monitoring TTL Expiry

```bash
# Watch logs for expiry cleanup
kubectl logs -n activity-system deploy/discovery-vessel -f | grep -i expire

# Check vessel TTL status
curl http://localhost:8080/vessels | jq '.vessels[] | {vesselId, expiresAt}'
```

## Integration with Other Vessels

See [DISCOVERY_INTEGRATION.md](/home/avi/documents/work/exp-repo/metabob-devbob/DISCOVERY_INTEGRATION.md) for:
- Integration patterns (Standard, Bootstrap Delay, Self-Registration, Conditional)
- Configuration examples
- Troubleshooting guide
- End-to-end testing procedures

## Important Notes

1. **In-memory only** - Registry is not persisted. Vessels re-register on startup.
2. **Single replica recommended** - Multiple replicas would have separate registries (use Redis for multi-replica in future)
3. **No authentication** - Assumes trusted internal network (add auth in future if needed)
4. **TTL-based cleanup** - Vessels must send heartbeats or they expire
5. **Static bootstrap** - Discovery-vessel itself is found via environment variable, not discovery

## Performance Targets

From load tests (see test/TEST_EXECUTION_REPORT.md):

| Metric | Target | Status |
|--------|--------|--------|
| Registration throughput | > 200/sec | ✅ ~1538/sec |
| Query @ 1000 vessels | < 100ms | ✅ |
| Heartbeat throughput | > 500/sec | ✅ |
| Memory/vessel | < 10 KB | ✅ |

## Security Considerations

From security audit (see test/TEST_EXECUTION_REPORT.md):

**Medium severity findings** (3):
1. Input validation - Some malformed payloads accepted
2. Payload size limits - Wrong HTTP status code (400 vs 413)
3. Memory exhaustion - Exceeded 200MB with large metadata

**Recommendations**:
- Add strict schema validation
- Implement metadata size limits (100KB per vessel)
- Add rate limiting (100 reg/min per vessel)

## Next Steps / Future Improvements

1. **Persistent storage** - Use Redis or SurrealDB for multi-replica support
2. **Authentication** - Add API key validation for registration/heartbeat
3. **Rate limiting** - Prevent DoS attacks
4. **Health scoring** - Add health metrics from vessel responses
5. **Circuit breakers** - Automatically disable unhealthy vessels
6. **Thompson Sampling** - Probabilistic vessel selection for A/B testing

## Commit Practices

Follow standard commit practices:
- Commit early and often after features work
- Use conventional commit format: `<type>(<scope>): <subject>`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- Scope: `discovery-vessel`, `registry`, `resolvers`, `tests`
- Always include: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`

## Contact

For questions or issues:
- Check README.md and test documentation
- Review DISCOVERY_INTEGRATION.md for integration patterns
- Consult IMPULSE_ACTIVITY_FOUNDATION.md for architectural guidance
