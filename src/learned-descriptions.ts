/**
 * LEARNED SHAPE DESCRIPTIONS: kept, persisted, and served for the shapes templates produce (A2's receiving end; I-T
 * structural, RUN 3).
 *
 * Measured: POST /registry/shape-descriptions stored into an in-memory map that a restart lost, nothing in the fleet
 * wrote to it, and a read dropped any learned description whose shape no live VESSEL lists in `shapes`. But a shape the
 * substrate MINTS (a learned template's output) is produced by a template, not advertised by a vessel, so its
 * description, the only way a goal can recall it by meaning, was filtered out by construction.
 *
 * Now:
 *   - an entry may name its producer (produced_by: the template id). Such an entry is CLAIMED by that producer and is
 *     served even when no vessel lists the shape; a plain learned entry still needs a live vessel to list its shape;
 *   - RETIRE is explicit: the producer's retirement (or anyone holding the key) posts {shape, retire: true}; a retired
 *     entry is kept, not served, and is restored by the next description written for the shape;
 *   - the store PERSISTS to the state volume and is reloaded at start, so a restart is not a loss.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface LearnedEntry { description: string; source: string; at: number; produced_by?: string; retired_at?: number }

/** The state-volume file (bootstrap location only; what is stored in it is the behaviour). */
export function learnedDescriptionsPath(): string {
  return process.env.DISCOVERY_LEARNED_DESCRIPTIONS_PATH ?? join(process.env.WORKSPACE_ROOT ?? "/workspace", "state", "discovery-learned-descriptions.json")
}

export class LearnedDescriptions {
  private map = new Map<string, LearnedEntry>()
  constructor(private readonly path: string | null = learnedDescriptionsPath()) { this.load() }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, LearnedEntry>
      for (const [k, v] of Object.entries(raw)) if (v && typeof v.description === "string" && v.description.trim()) this.map.set(k, v)
    } catch (err) {
      console.warn(`[discovery-vessel] learned shape descriptions unreadable at ${this.path} (${(err as Error).message}); starting empty`)
    }
  }
  private save(): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2))
      renameSync(tmp, this.path)
    } catch (err) {
      console.warn(`[discovery-vessel] could not persist learned shape descriptions to ${this.path}: ${(err as Error).message}`)
    }
  }

  set(shape: string, description: string, source = "auto", producedBy?: string): LearnedEntry | null {
    const s = typeof shape === "string" ? shape.trim() : ""
    const d = typeof description === "string" ? description.trim() : ""
    if (!s || !d) return null
    const prior = this.map.get(s)
    const entry: LearnedEntry = { description: d, source, at: Date.now(), ...(producedBy ? { produced_by: producedBy } : prior?.produced_by ? { produced_by: prior.produced_by } : {}) }
    this.map.set(s, entry)
    this.save()
    return entry
  }
  /** Soft retire: kept, no longer served; the next set() for the shape restores it. */
  retire(shape: string): LearnedEntry | null {
    const e = this.map.get(shape.trim())
    if (!e) return null
    e.retired_at = Date.now()
    this.save()
    return e
  }
  /** The entries to SERVE: not retired, and claimed (a producer named, or a live vessel lists the shape). */
  served(liveShapes: ReadonlySet<string>): Array<[string, LearnedEntry]> {
    return [...this.map.entries()].filter(([shape, e]) => !e.retired_at && (Boolean(e.produced_by) || liveShapes.has(shape)))
  }
  get size(): number { return this.map.size }
  get(shape: string): LearnedEntry | undefined { return this.map.get(shape) }
}
