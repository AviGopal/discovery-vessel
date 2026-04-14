# Discovery Vessel Test Suite

Comprehensive testing infrastructure for the discovery vessel system covering load, chaos, security, integration, and unit tests.

## Quick Start

```bash
# Run all tests
./test/run-all-tests.sh --all

# Run specific test category
./test/run-all-tests.sh --load
./test/run-all-tests.sh --chaos
./test/run-all-tests.sh --security
./test/run-all-tests.sh --unit --integration

# Generate HTML report
./test/run-all-tests.sh --all --report
```

## Test Categories

### 1. Unit Tests
**Files:** `test/registry.test.ts`, `test/endpoints.test.ts`
**Duration:** ~5 seconds
**Coverage:** Core registry logic, shape indexing, TTL management

```bash
bun test test/registry.test.ts
bun test test/endpoints.test.ts
```

### 2. Integration Tests
**File:** `test/integration.test.ts`
**Duration:** ~10 seconds
**Coverage:** Complete vessel lifecycle, multi-vessel scenarios, multi-tenant isolation

```bash
bun test test/integration.test.ts
```

### 3. Load Tests
**File:** `test/load/concurrent-registrations.test.ts`
**Duration:** ~30-60 seconds
**Coverage:**
- 1000 concurrent registrations
- Query performance under load
- Heartbeat throughput
- Memory efficiency
- Mixed operations

```bash
bun test test/load/concurrent-registrations.test.ts
```

**Performance Targets:**
- Registration: > 200 vessels/sec
- Query latency: < 100ms @ 1000 vessels
- Heartbeat: > 500 heartbeats/sec
- Memory: < 10 KB per vessel

### 4. Chaos Tests
**Files:** `test/chaos/discovery-crash.test.ts`, `test/chaos/network-partition.test.ts`
**Duration:** ~30-45 seconds
**Coverage:**
- Recovery after crash
- Network partition handling
- Split-brain prevention
- Cascading failure prevention
- Exponential backoff retry

```bash
bun test test/chaos/discovery-crash.test.ts
bun test test/chaos/network-partition.test.ts
```

**Resilience Scenarios:**
- Discovery pod crash during registration
- Network partition (vessels isolated from discovery)
- Heartbeat failures and recovery
- State consistency after failures

### 5. Security Tests
**File:** `test/security/security-audit.test.ts`
**Duration:** ~20-30 seconds
**Coverage:**
- Input validation (malformed payloads)
- Injection attacks (SQL, NoSQL, Command, XSS, Path Traversal)
- DoS resilience (flooding, memory exhaustion)
- Authentication bypass attempts
- Privilege escalation attempts
- Data integrity and leakage prevention

```bash
bun test test/security/security-audit.test.ts
```

**Attack Vectors Tested:**
- 15+ malformed payload patterns
- 20+ injection attack types
- 3 DoS scenarios
- 6+ auth bypass attempts
- Multi-tenant isolation

## Test Results

Results are saved to `test/results/` directory:
- Individual log files per test suite
- HTML report (with `--report` flag)
- Performance metrics
- Pass/fail statistics

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Discovery Vessel Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - name: Unit & Integration Tests
        run: ./test/run-all-tests.sh --unit --integration
      - name: Security Tests
        run: ./test/run-all-tests.sh --security
      - name: Load & Chaos Tests (main only)
        if: github.ref == 'refs/heads/main'
        run: ./test/run-all-tests.sh --load --chaos
      - uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test/results/
```

## Test Development Guidelines

### Adding New Tests

1. **Unit tests** - Add to `test/registry.test.ts` or `test/endpoints.test.ts`
2. **Integration tests** - Add to `test/integration.test.ts`
3. **Load tests** - Add to `test/load/concurrent-registrations.test.ts` or create new file
4. **Chaos tests** - Create new file in `test/chaos/`
5. **Security tests** - Add to `test/security/security-audit.test.ts`

### Test Structure

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createServer, registry } from "../src/index"

describe("Feature Name", () => {
  let app: Hono

  beforeEach(() => {
    app = createServer()
    // Clear registry
    const allVessels = registry.list()
    allVessels.forEach(v => registry.unregister(v.vesselId))
  })

  afterEach(() => {
    registry.stop()
  })

  test("specific behavior", async () => {
    // Test implementation
  })
})
```

### Performance Testing Best Practices

1. **Use timeouts** - Set appropriate timeouts for long-running tests
2. **Measure metrics** - Log performance metrics to console
3. **Set baselines** - Assert against performance targets
4. **Clean up** - Always clean registry between tests

Example:
```typescript
test("performance test", async () => {
  const startTime = Date.now()

  // ... test implementation

  const duration = Date.now() - startTime

  console.log(`\n✅ Performance:`)
  console.log(`   - Duration: ${duration}ms`)

  expect(duration).toBeLessThan(5000)
}, { timeout: 10000 })
```

### Chaos Testing Best Practices

1. **Simulate failures** - Use controlled failure injection
2. **Verify recovery** - Assert on recovery metrics
3. **Test resilience patterns** - Exponential backoff, retry logic
4. **Document scenarios** - Clear comments on what's being tested

### Security Testing Best Practices

1. **Test attack vectors** - Cover common attack patterns
2. **Don't execute attacks** - Simulate, don't actually exploit
3. **Verify boundaries** - Assert that isolation works
4. **Document findings** - Log security test results

## Troubleshooting

### Tests Timing Out

- Increase timeout: `test("...", async () => {...}, { timeout: 30000 })`
- Check for async operations not being awaited
- Verify registry cleanup in `afterEach`

### Memory Issues

- Ensure registry is cleared between tests
- Check for memory leaks in test setup
- Run tests individually to isolate issues

### Flaky Tests

- Add explicit waits for async operations
- Check for race conditions
- Use deterministic test data

### CI/CD Failures

- Check environment differences (memory, CPU)
- Verify dependencies are installed
- Review CI logs in `test/results/`

## Performance Baselines

Update these baselines as system improves:

| Metric | Current Baseline | Target |
|--------|-----------------|--------|
| Registration (1000 vessels) | < 5s | < 3s |
| Query @ 1000 vessels | < 100ms | < 50ms |
| Heartbeat (1000 vessels) | < 2s | < 1s |
| Memory per vessel | < 10 KB | < 5 KB |

## Security Audit Schedule

- **Daily:** Input validation tests (in CI/CD)
- **Weekly:** Full security audit in staging
- **Monthly:** Penetration testing review
- **Quarterly:** Security assessment report

## References

- [Test Execution Report](./TEST_EXECUTION_REPORT.md) - Detailed test results and findings
- [Discovery Vessel README](../README.md) - System overview and architecture
- [Bun Test Documentation](https://bun.sh/docs/cli/test) - Test framework reference

## Contact

Questions or issues with tests? See the main repository documentation or create an issue.
