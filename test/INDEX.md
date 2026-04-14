# Discovery Vessel Test Suite - File Index

Complete index of all test files and documentation.

## Quick Start

📖 **Start here:** [QUICK_START.md](./QUICK_START.md)

## Test Files

### Unit Tests
- [`registry.test.ts`](./registry.test.ts) - Core registry logic (26 tests)
- [`endpoints.test.ts`](./endpoints.test.ts) - HTTP endpoint tests
- [`metrics.test.ts`](./metrics.test.ts) - Metrics tracking tests

### Integration Tests
- [`integration.test.ts`](./integration.test.ts) - End-to-end lifecycle tests (8 tests)

### Load Tests
- [`load/concurrent-registrations.test.ts`](./load/concurrent-registrations.test.ts) - Performance tests (6 tests)
  - 1000 concurrent registrations
  - Query performance @ 1000 vessels
  - Heartbeat throughput
  - TTL expiration accuracy
  - Mixed operations
  - Memory efficiency

### Chaos Tests
- [`chaos/discovery-crash.test.ts`](./chaos/discovery-crash.test.ts) - Crash recovery tests (5 tests)
  - Recovery after crash during registration
  - Registry state consistency
  - Heartbeat resilience during downtime
  - Partial registration failure recovery
  - Concurrent crashes and recovery

- [`chaos/network-partition.test.ts`](./chaos/network-partition.test.ts) - Network failure tests (6 tests)
  - Graceful degradation during partition
  - Heartbeat failures during partition
  - Split-brain prevention
  - Cascading failures prevention
  - Timeout handling with backoff
  - Partial network failure impact

### Security Tests
- [`security/security-audit.test.ts`](./security/security-audit.test.ts) - Security audit (11 tests)
  - Input validation
  - Injection attack prevention (SQL, NoSQL, Command, XSS)
  - DoS resilience
  - Authentication bypass attempts
  - Privilege escalation attempts
  - Data integrity and leakage

## Test Infrastructure

### Automation
- [`run-all-tests.sh`](./run-all-tests.sh) - Master test runner script
  - Supports selective execution (--unit, --integration, --load, --chaos, --security)
  - Generates colored output
  - Creates individual log files
  - Provides summary statistics
  - Optional HTML report generation

### Results
- `results/` - Test execution logs (created at runtime)
  - Individual log files per test suite
  - HTML report (when generated)
  - Performance metrics

## Documentation

### Primary Documentation
- [`README.md`](./README.md) - Comprehensive test suite guide
  - Test categories and usage
  - Performance targets
  - CI/CD integration examples
  - Development guidelines
  - Troubleshooting

- [`TEST_EXECUTION_REPORT.md`](./TEST_EXECUTION_REPORT.md) - Detailed test results
  - Executive summary
  - Test coverage by category
  - Performance baselines
  - Security audit findings
  - Test execution instructions
  - Recommendations

- [`QUICK_START.md`](./QUICK_START.md) - Quick reference guide
  - Command examples
  - Test summary table
  - Known issues
  - Performance baselines

### Phase Documentation
- `/openspec/changes/vessel-integration-standardization/specs/PHASE_6.2_COMPREHENSIVE_TESTING_SUMMARY.md`
  - Implementation summary
  - Deliverables checklist
  - Security findings
  - Performance benchmarks
  - Next steps

## Test Statistics

| Category | Files | Tests | Duration | Pass Rate |
|----------|-------|-------|----------|-----------|
| Unit | 3 | 26+ | ~5s | 100% |
| Integration | 1 | 8 | ~10s | 100% |
| Load | 1 | 6 | ~30-60s | 100% |
| Chaos | 2 | 11 | ~30-45s | 100% |
| Security | 1 | 11 | ~20-30s | 73% (8/11) |
| **Total** | **8** | **62+** | **~90-150s** | **95%** |

## Quick Commands

```bash
# Run all tests
./test/run-all-tests.sh --all

# Run fast tests only
./test/run-all-tests.sh --unit --integration

# Run specific category
./test/run-all-tests.sh --load
./test/run-all-tests.sh --chaos
./test/run-all-tests.sh --security

# Generate HTML report
./test/run-all-tests.sh --all --report

# Run individual test file
bun test test/registry.test.ts
bun test test/load/concurrent-registrations.test.ts
```

## CI/CD Integration

Recommended workflow: Run fast tests on all PRs, expensive tests on main branch only.

See [README.md#ci-cd-integration](./README.md#ci-cd-integration) for complete example.

## Security Findings

3 medium-severity findings identified:
1. Input validation - malformed payloads accepted
2. Oversized payloads - wrong HTTP status code
3. Memory exhaustion - exceeded 200MB limit

See [TEST_EXECUTION_REPORT.md#security-audit-findings](./TEST_EXECUTION_REPORT.md#security-audit-findings) for details.

## Performance Baselines

| Metric | Target | Achieved | Status |
|--------|--------|----------|--------|
| Registration | > 200/sec | ~1538/sec | ✅ |
| Query @ 1000 vessels | < 100ms | < 100ms | ✅ |
| Heartbeat | > 500/sec | > 500/sec | ✅ |
| Memory/vessel | < 10 KB | < 10 KB | ✅ |

## Next Steps

1. **Fix Security Issues** - Address 3 medium-severity findings
2. **CI/CD Integration** - Add tests to GitHub Actions workflow
3. **Production Monitoring** - Set up metrics and alerting
4. **Advanced Testing** - Integrate Chaos Mesh for real pod failures

## Contact

For questions or issues with the test suite, see the main repository documentation or create an issue.

---

**Phase 6.2 Status:** ✅ Complete - Ready for review and production deployment (after addressing security findings)
