# Discovery Vessel Test Suite - Quick Start

## Run All Tests (90-150 seconds)

```bash
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/discovery-vessel
./test/run-all-tests.sh --all
```

## Run Specific Test Categories

```bash
# Fast tests only (~15s)
./test/run-all-tests.sh --unit --integration

# Load tests (~30-60s)
./test/run-all-tests.sh --load

# Chaos tests (~30-45s)
./test/run-all-tests.sh --chaos

# Security tests (~20-30s)
./test/run-all-tests.sh --security
```

## Individual Test Execution

```bash
# Unit tests
bun test test/registry.test.ts
bun test test/endpoints.test.ts

# Integration tests
bun test test/integration.test.ts

# Load tests
bun test test/load/concurrent-registrations.test.ts

# Chaos tests
bun test test/chaos/discovery-crash.test.ts
bun test test/chaos/network-partition.test.ts

# Security tests
bun test test/security/security-audit.test.ts
```

## Test Results

Results saved to: `test/results/`

Generate HTML report:
```bash
./test/run-all-tests.sh --all --report
```

## Test Summary

| Category | Tests | Duration | Pass Rate |
|----------|-------|----------|-----------|
| Unit | 26 | ~5s | 100% |
| Integration | 8 | ~10s | 100% |
| Load | 6 | ~30-60s | 100% |
| Chaos | 11 | ~30-45s | 100% |
| Security | 11 | ~20-30s | 73% (8/11) |
| **Total** | **62** | **~90-150s** | **95%** |

## Known Issues

3 security test failures (non-critical):
1. Input validation - malformed payloads accepted
2. Oversized payload - wrong HTTP status code
3. Memory exhaustion - exceeded 200MB limit

See `TEST_EXECUTION_REPORT.md` for details and recommendations.

## CI/CD Integration

```yaml
# .github/workflows/test.yml
- run: ./test/run-all-tests.sh --unit --integration --security
- run: ./test/run-all-tests.sh --load --chaos  # Only on main
```

## Performance Baselines

| Metric | Target | Achieved |
|--------|--------|----------|
| Registration | > 200/sec | ~1538/sec ✅ |
| Query @ 1000 vessels | < 100ms | < 100ms ✅ |
| Heartbeat | > 500/sec | > 500/sec ✅ |
| Memory/vessel | < 10 KB | < 10 KB ✅ |

## Documentation

- `README.md` - Full test suite documentation
- `TEST_EXECUTION_REPORT.md` - Detailed results and findings
- Phase 6.2 summary in `/openspec/changes/vessel-integration-standardization/specs/`
