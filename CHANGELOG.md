# Changelog

All notable changes to discovery-vessel.

## [0.3.0] - 2026-04-25

### Security
- All mutation endpoints (POST /register, POST /resolve, POST /heartbeat, DELETE /vessels/:id) now require `Authorization: ApiKey` validated against identity-vessel; unauthenticated callers receive 401
- Vessel `orgId` on registration is now bound to the validated caller's org — request body `orgId` is ignored, preventing cross-tenant spoofing
- DELETE /vessels/:id enforces vessel ownership; mismatched org returns 403
- Fixed tenant isolation leak: vessels with null `orgId` no longer visible to all tenants
- Added `systemVessel: boolean` flag for explicitly cross-tenant platform vessels

### Added
- `src/middleware/auth.ts` — `authMiddleware`, `getAuthContext()`, configurable via `IDENTITY_VESSEL_URL` env var

## [0.2.0] - 2026-04-25

### Added
- Resolver contract advertisement (endpoint, format, auth, timeout)
- Vessel version tracking in registry
- Stateful vessel support with state metadata
- Comprehensive test suite (unit, integration, load, chaos, security)
- Metrics tracking for registry operations
- Docker deployment support

### Changed
- Registration now accepts resolver contract fields
- Health endpoint includes registry statistics

## [0.1.0] - 2026-04-10

### Added
- Initial discovery vessel implementation
- Vessel registration with TTL-based expiry
- Heartbeat mechanism for registration renewal
- Impulse resolvers: vesselCapability, vesselEndpoint, vesselHealth, vesselRegistry
- Self-registration on startup
- Hono HTTP server
