#!/bin/bash
# Run all discovery vessel tests
# Usage: ./test/run-all-tests.sh [options]
#
# Options:
#   --load       Run only load tests
#   --chaos      Run only chaos tests
#   --security   Run only security tests
#   --unit       Run only unit tests
#   --integration Run only integration tests
#   --all        Run all tests (default)
#   --report     Generate HTML test report

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results directory
RESULTS_DIR="test/results"
mkdir -p "$RESULTS_DIR"

# Default: run all tests
RUN_UNIT=false
RUN_INTEGRATION=false
RUN_LOAD=false
RUN_CHAOS=false
RUN_SECURITY=false
GENERATE_REPORT=false

# Parse arguments
if [ $# -eq 0 ]; then
  RUN_UNIT=true
  RUN_INTEGRATION=true
  RUN_LOAD=true
  RUN_CHAOS=true
  RUN_SECURITY=true
else
  for arg in "$@"; do
    case $arg in
      --unit)
        RUN_UNIT=true
        ;;
      --integration)
        RUN_INTEGRATION=true
        ;;
      --load)
        RUN_LOAD=true
        ;;
      --chaos)
        RUN_CHAOS=true
        ;;
      --security)
        RUN_SECURITY=true
        ;;
      --all)
        RUN_UNIT=true
        RUN_INTEGRATION=true
        RUN_LOAD=true
        RUN_CHAOS=true
        RUN_SECURITY=true
        ;;
      --report)
        GENERATE_REPORT=true
        ;;
      *)
        echo "Unknown option: $arg"
        exit 1
        ;;
    esac
  done
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Discovery Vessel Test Suite                       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Track results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
START_TIME=$(date +%s)

# Helper function to run tests
run_test_suite() {
  local suite_name=$1
  local test_pattern=$2

  echo -e "${YELLOW}Running $suite_name...${NC}"

  if bun test "$test_pattern" > "$RESULTS_DIR/${suite_name}.log" 2>&1; then
    echo -e "${GREEN}✓ $suite_name passed${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
  else
    echo -e "${RED}✗ $suite_name failed${NC}"
    echo -e "${RED}  See $RESULTS_DIR/${suite_name}.log for details${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
  fi

  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  echo ""
}

# Run unit tests
if [ "$RUN_UNIT" = true ]; then
  echo -e "${BLUE}═══ Unit Tests ═══${NC}"
  run_test_suite "registry-unit" "test/registry.test.ts"
  run_test_suite "endpoints-unit" "test/endpoints.test.ts"
fi

# Run integration tests
if [ "$RUN_INTEGRATION" = true ]; then
  echo -e "${BLUE}═══ Integration Tests ═══${NC}"
  run_test_suite "integration" "test/integration.test.ts"
fi

# Run load tests
if [ "$RUN_LOAD" = true ]; then
  echo -e "${BLUE}═══ Load Tests ═══${NC}"
  echo -e "${YELLOW}WARNING: Load tests may take several minutes${NC}"
  run_test_suite "load-concurrent" "test/load/concurrent-registrations.test.ts"
fi

# Run chaos tests
if [ "$RUN_CHAOS" = true ]; then
  echo -e "${BLUE}═══ Chaos Tests ═══${NC}"
  echo -e "${YELLOW}WARNING: Chaos tests simulate failures${NC}"
  run_test_suite "chaos-crash" "test/chaos/discovery-crash.test.ts"
  run_test_suite "chaos-network" "test/chaos/network-partition.test.ts"
fi

# Run security tests
if [ "$RUN_SECURITY" = true ]; then
  echo -e "${BLUE}═══ Security Audit Tests ═══${NC}"
  echo -e "${YELLOW}WARNING: Security tests include attack simulations${NC}"
  run_test_suite "security-audit" "test/security/security-audit.test.ts"
fi

# Calculate duration
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Print summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                   Test Summary                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Total Suites: $TOTAL_TESTS"
echo -e "${GREEN}Passed:       $PASSED_TESTS${NC}"
if [ $FAILED_TESTS -gt 0 ]; then
  echo -e "${RED}Failed:       $FAILED_TESTS${NC}"
else
  echo -e "Failed:       $FAILED_TESTS"
fi
echo -e "Duration:     ${DURATION}s"
echo ""

# Generate report if requested
if [ "$GENERATE_REPORT" = true ]; then
  echo -e "${BLUE}Generating HTML report...${NC}"
  node test/generate-report.js
  echo -e "${GREEN}Report generated: $RESULTS_DIR/test-report.html${NC}"
fi

# Exit with error if any tests failed
if [ $FAILED_TESTS -gt 0 ]; then
  echo -e "${RED}Some tests failed. See logs in $RESULTS_DIR/${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
