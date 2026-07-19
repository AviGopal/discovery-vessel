# Changelog

All notable changes to discovery-vessel.

## [0.5.0] - 2026-07-19

### Added
- Public (pre-auth) `GET /bootstrap` — the single point-and-go door for federation. It
  returns `{relay_multiaddrs, identity_endpoint, discovery_endpoint, prefer_transport}`
  so a client/spoke joins a substrate with only a discovery endpoint plus an API key;
  the relay anchor, identity authority, and discovery endpoint are read here at use time
  instead of being pinned in env. `relay_multiaddrs` comes from `RELAY_MULTIADDR` when
  set, and is otherwise derived from the registered circuit multiaddrs. This supersedes
  the hand-set relay multiaddr, whose pinned relay peer-id went stale on every relay
  restart — a hand-set relay is now an optional override.

### Security
- `/bootstrap` is an intentional new `PUBLIC_PATHS` entry: it is auth-exempt so a fresh
  keyless client can read the join anchors before it holds a key. Its response contains
  only non-secret routing anchors (relay/identity/discovery addresses), no credentials.

## [0.4.1] - 2026-05-03

### Fixed
- Auth middleware now validates API keys via `POST /v1/auth/resolve` instead of `POST /v1/keys/validate`, matching the canonical pattern used by activity-api. The old path rejected `mb-{b64}-{hmac}` format keys, causing all vessel registrations to fail with `INVALID_API_KEY` and leaving the registry at `totalVessels: 0`.

## [0.4.0] - 2026-04-23

### Added
- Resolver contract advertisement on registration so vessels self-describe how to be called, replacing hardcoded per-vessel client conventions:
  - `resolve_endpoint` (default `/v2/impulses/resolve`)
  - `resolve_request_format`: `pointer` | `mcp-tool` (default `pointer`)
  - `auth_scheme`: `none` | `ApiKey` | `Bearer` (default `none`)
  - `resolve_timeout_ms` (no default; client policy)
- Auth delegation contract fields so vessels declare how to obtain tokens for downstream calls:
  - `auth_token_source`: `client` | `vessel` (default `client`) — who provides the credential
  - `auth_delegation_mode`: `forward` | `exchange` | `none` (default `none`) — how the vessel uses it
- Normalize-at-write in `registry.register()` fills enum defaults so all consumers see populated contract fields; legacy registrations without these keys keep working.

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
