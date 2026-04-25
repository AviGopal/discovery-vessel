# Changelog

All notable changes to discovery-vessel.

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
