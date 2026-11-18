/**
 * Discovery's own row
 *
 * Discovery is a vessel in its own registry, written as every vessel's /register writes one and kept fresh at the
 * cadence /heartbeat gives every vessel: a row written once and never refreshed lapsed at the TTL, so discovery was
 * listed for its first five minutes and then not at all. It serves every shape it resolves, and declares the three a
 * producer may call (a description and the fields it takes), the same way a vessel does, so a declared
 * shapeDescriptions read offers them. The others stay undeclared: they answer placements, for the vessels that dial.
 */
import { HEARTBEAT_INTERVAL_MS, registry } from "./registry"
import { getResolvableShapes, sanitizeShapeInputs } from "./resolvers"

export const SELF_DESCRIPTIONS: Record<string, string> = {
  vesselList: "Lists every vessel registered with discovery now: each one's id, the shapes it serves and its status, and how many there are (totalCount). Read it to count the vessels or to see which vessel serves a shape. Says nothing about where a vessel runs. Takes no fields.",
  shapeProducers: "Names the vessels that serve one shape now, healthy ones first, by id only. Read it before calling a shape to learn whether anything serves it.",
  shapeDescriptions: "Lists what each live shape produces, in its vessels' own words, with the inputs a caller fills and the answer each gives. Read it to choose a shape to call.",
}

export const SELF_INPUTS: Record<string, Record<string, unknown>> = {
  vesselList: { type: "object", additionalProperties: false, properties: {} },
  shapeProducers: {
    type: "object",
    required: ["shape"],
    additionalProperties: false,
    properties: { shape: { type: "string", minLength: 1, description: "The shape to find producers for." } },
  },
  shapeDescriptions: {
    type: "object",
    additionalProperties: false,
    properties: {
      shapes: { type: "array", items: { type: "string" }, description: "Only these shapes." },
      declared: { type: "boolean", description: "Only shapes whose inputs are declared." },
    },
  },
}

// What /register would write for discovery: every shape it resolves, its three declarations through the same
// sanitizer the handler applies, shared infrastructure for every tenant. No shape_answers: that names the row shape a
// call answers with, and these answer with no row; each description says what it answers.
export const selfRegistration = (vesselId: string, endpoint: string) => {
  const shapes = getResolvableShapes()
  return {
    vesselId,
    vesselName: "Discovery Vessel",
    version: "0.1.0",
    endpoint,
    shapes,
    shape_descriptions: SELF_DESCRIPTIONS,
    shape_inputs: sanitizeShapeInputs(SELF_INPUTS, shapes),
    protocol: "http" as const,
    systemVessel: true,
    metadata: { environment: (process.env.KUBERNETES_SERVICE_HOST ? "k8s-cluster" : "local") as "k8s-cluster" | "local", selfRegistered: true },
  }
}

// Written now, then refreshed every heartbeat interval; a refresh that finds the row gone (pruned) writes it again.
export const keepSelfRegistered = (vesselId: string, endpoint: string): { refresh: () => void; stop: () => void } => {
  const write = (): void => { registry.register(selfRegistration(vesselId, endpoint)) }
  const refresh = (): void => { if (!registry.heartbeat(vesselId)) write() }
  write()
  const timer = setInterval(refresh, HEARTBEAT_INTERVAL_MS)
  return { refresh, stop: () => clearInterval(timer) }
}
