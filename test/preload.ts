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
