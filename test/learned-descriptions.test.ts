// LEARNED SHAPE DESCRIPTIONS: persisted across a restart, soft-retired and restored, and served only while a live vessel
// lists the shape. A produced_by claim (an activity-api template) used to serve an entry no vessel lists; those templates
// left with activity-api, so a claim is kept as data and serves nothing.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ld from "../src/learned-descriptions"

const Store = (ld as unknown as { LearnedDescriptions?: new (p: string | null) => any }).LearnedDescriptions
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "learned-desc-")); return { dir: d, path: join(d, "state", "learned.json") } }

describe("learned shape descriptions", () => {
  it("[MUST-FAIL] a produced_by claim does not serve an entry no live vessel lists", () => {
    const { dir, path } = fresh()
    try {
      const s = new Store!(path)
      s.set("s_minted7", "Totals parcels per region, minted from a reached trace.", "mint", "learned-parcel-totals")
      expect(s.served(new Set<string>())).toEqual([])
      expect(s.served(new Set(["s_minted7"])).map(([k]: [string]) => k)).toEqual(["s_minted7"])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("[MUST-FAIL] the store survives a restart (persisted to the state volume, reloaded)", () => {
    const { dir, path } = fresh()
    try {
      new Store!(path).set("s_minted7", "A minted shape.", "mint", "tpl-1")
      const again = new Store!(path)
      expect(again.get("s_minted7")?.description).toBe("A minted shape.")
      expect(again.get("s_minted7")?.produced_by).toBe("tpl-1")
      expect(JSON.parse(readFileSync(path, "utf8"))["s_minted7"].description).toBe("A minted shape.")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("[MUST-FAIL] retire is soft: kept, not served; a new description restores it", () => {
    const { dir, path } = fresh()
    try {
      const s = new Store!(path)
      const live = new Set(["s_old"])
      s.set("s_old", "Old.", "mint", "tpl-2")
      s.retire("s_old")
      expect(s.served(live)).toEqual([])
      expect(s.get("s_old")).toBeDefined()
      s.set("s_old", "Back again.", "mint")
      expect(s.served(live).map(([k]: [string]) => k)).toEqual(["s_old"])
      expect(s.get("s_old")?.produced_by).toBe("tpl-2") // the producer is kept across a re-description
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("[CONTROL] a plain learned description (no producer) still needs a live vessel to list its shape", () => {
    const s = new Store!(null)
    s.set("vessel_shape", "Described by the auto-describe path.", "auto")
    expect(s.served(new Set<string>())).toEqual([])
    expect(s.served(new Set(["vessel_shape"])).map(([k]: [string]) => k)).toEqual(["vessel_shape"])
  })
  it("[HELD-OUT] an unreadable store starts empty instead of failing the vessel", () => {
    const { dir, path } = fresh()
    try {
      require("node:fs").mkdirSync(join(dir, "state"), { recursive: true })
      require("node:fs").writeFileSync(path, "{ not json")
      expect(new Store!(path).size).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("[WIRING] the registry serves learned entries for live shapes (advertised still wins); the POST refuses produced_by and takes retire", () => {
    const reg = readFileSync(join(import.meta.dir, "..", "src", "registry.ts"), "utf8")
    expect(reg).toContain("for (const [shape, entry] of this.learnedDescriptions.served(liveShapes)) {")
    expect(reg).toContain("if (merged[shape]) continue // advertised wins")
    expect(reg).toContain("private learnedDescriptions = new LearnedDescriptions()")
    const idx = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
    expect(idx).toContain("registry.setLearnedDescription(shape, description, source)")
    expect(idx).toContain("produced_by is no longer accepted")
    expect(idx).toContain("registry.retireLearnedDescription(shape)")
  })
})
