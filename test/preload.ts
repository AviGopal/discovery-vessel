/**
 * Test preload (bunfig.toml): every test run keeps discovery's learned-description store in a temp file.
 *
 * The registry is a module singleton, and its store reads DISCOVERY_LEARNED_DESCRIPTIONS_PATH once, when the first test
 * file imports it. A file that set the variable after another file had imported the registry wrote its fixtures to
 * ${WORKSPACE_ROOT:-/workspace}/state, the live store a running discovery loads. Set here, before any import, it holds
 * for the whole run. It is set unconditionally, so a shell that points it at live state cannot carry that into tests.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH = join(mkdtempSync(join(tmpdir(), "discovery-learned-")), "learned.json")

// The published-port set (resolvers.ts publishedPorts) is the node's launch manifest. A test run on a node would read
// that node's manifest and withhold public endpoints its fixtures expect; tests that exercise the set pass their own.
// Unset here, for the same reason as above, so no test depends on the host it runs on.
process.env.SUBSTRATE_MANIFEST = join(mkdtempSync(join(tmpdir(), "discovery-manifest-")), "absent.yml")
delete process.env.SUBSTRATE_PUBLISHED_PORTS
