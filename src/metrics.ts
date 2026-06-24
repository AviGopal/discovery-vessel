/**
 * Prometheus Metrics for Discovery Vessel
 *
 * Tracks vessel discovery operations for monitoring and alerting.
 */

export interface MetricLabels {
  [key: string]: string | number
}

export interface Metric {
  name: string
  type: "counter" | "gauge" | "histogram"
  help: string
  labels?: string[]
  value: number
  buckets?: number[]  // For histograms
}

/**
 * Metrics Registry
 */
class MetricsRegistry {
  private counters = new Map<string, number>()
  private gauges = new Map<string, number>()
  private histograms = new Map<string, { count: number; sum: number; buckets: Map<number, number> }>()

  private metadata = new Map<string, { type: string; help: string; labels?: string[] }>()

  /**
   * Register a metric's metadata
   */
  register(name: string, type: "counter" | "gauge" | "histogram", help: string, labels?: string[], buckets?: number[]) {
    this.metadata.set(name, { type, help, labels })

    if (type === "histogram" && buckets) {
      this.histograms.set(name, {
        count: 0,
        sum: 0,
        buckets: new Map(buckets.map(b => [b, 0]))
      })
    }
  }

  /**
   * Increment a counter
   */
  inc(name: string, value: number = 1, labels?: MetricLabels) {
    const key = this.makeKey(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + value)
  }

  /**
   * Set a gauge value
   */
  set(name: string, value: number, labels?: MetricLabels) {
    const key = this.makeKey(name, labels)
    this.gauges.set(key, value)
  }

  /**
   * Observe a histogram value
   */
  observe(name: string, value: number, labels?: MetricLabels) {
    const key = this.makeKey(name, labels)
    const hist = this.histograms.get(name)

    if (!hist) {
      throw new Error(`Histogram ${name} not registered`)
    }

    hist.count++
    hist.sum += value

    // Update buckets
    for (const [bucket, count] of hist.buckets) {
      if (value <= bucket) {
        hist.buckets.set(bucket, count + 1)
      }
    }
  }

  /**
   * Get all metrics in Prometheus exposition format
   */
  export(): string {
    const lines: string[] = []

    // Export counters
    for (const [key, value] of this.counters) {
      const [name, labelsStr] = this.parseKey(key)
      const meta = this.metadata.get(name)

      if (meta && !lines.includes(`# HELP ${name} ${meta.help}`)) {
        lines.push(`# HELP ${name} ${meta.help}`)
        lines.push(`# TYPE ${name} counter`)
      }

      lines.push(`${name}${labelsStr} ${value}`)
    }

    // Export gauges
    for (const [key, value] of this.gauges) {
      const [name, labelsStr] = this.parseKey(key)
      const meta = this.metadata.get(name)

      if (meta && !lines.includes(`# HELP ${name} ${meta.help}`)) {
        lines.push(`# HELP ${name} ${meta.help}`)
        lines.push(`# TYPE ${name} gauge`)
      }

      lines.push(`${name}${labelsStr} ${value}`)
    }

    // Export histograms
    for (const [name, hist] of this.histograms) {
      const meta = this.metadata.get(name)

      if (meta) {
        lines.push(`# HELP ${name} ${meta.help}`)
        lines.push(`# TYPE ${name} histogram`)
      }

      // Bucket counts
      for (const [bucket, count] of hist.buckets) {
        lines.push(`${name}_bucket{le="${bucket}"} ${count}`)
      }
      lines.push(`${name}_bucket{le="+Inf"} ${hist.count}`)

      // Sum and count
      lines.push(`${name}_sum ${hist.sum}`)
      lines.push(`${name}_count ${hist.count}`)
    }

    return lines.join('\n') + '\n'
  }

  /**
   * Get metrics as JSON (for testing/debugging)
   */
  exportJSON(): Record<string, any> {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        Array.from(this.histograms.entries()).map(([name, hist]) => [
          name,
          {
            count: hist.count,
            sum: hist.sum,
            buckets: Object.fromEntries(hist.buckets)
          }
        ])
      )
    }
  }

  /**
   * Reset all metrics (for testing)
   */
  reset() {
    this.counters.clear()
    this.gauges.clear()
    for (const hist of this.histograms.values()) {
      hist.count = 0
      hist.sum = 0
      for (const [bucket] of hist.buckets) {
        hist.buckets.set(bucket, 0)
      }
    }
  }

  private makeKey(name: string, labels?: MetricLabels): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name
    }

    const labelsStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',')

    return `${name}{${labelsStr}}`
  }

  private parseKey(key: string): [string, string] {
    const match = key.match(/^([^{]+)({.+})?$/)
    if (!match) return [key, '']

    const [, name = '', labels = ''] = match
    return [name, labels]
  }
}

// Singleton registry
export const metricsRegistry = new MetricsRegistry()

/**
 * Discovery Vessel Metrics
 */
export class DiscoveryMetrics {
  constructor() {
    // Registration metrics
    metricsRegistry.register(
      'vessel_registration_total',
      'counter',
      'Total number of vessel registrations',
      ['vessel_id', 'status']
    )

    metricsRegistry.register(
      'vessel_registration_duration_ms',
      'histogram',
      'Duration of vessel registration in milliseconds',
      ['vessel_id'],
      [10, 50, 100, 250, 500, 1000, 2500, 5000]
    )

    // Heartbeat metrics
    metricsRegistry.register(
      'vessel_heartbeat_total',
      'counter',
      'Total number of vessel heartbeats',
      ['vessel_id', 'status']
    )

    metricsRegistry.register(
      'vessel_heartbeat_failure_rate',
      'gauge',
      'Failure rate of vessel heartbeats (0.0 to 1.0)',
      ['vessel_id']
    )

    // Deregistration metrics
    metricsRegistry.register(
      'vessel_deregistration_total',
      'counter',
      'Total number of vessel deregistrations',
      ['vessel_id', 'reason']
    )

    // TTL expiration metrics
    metricsRegistry.register(
      'vessel_ttl_expired_total',
      'counter',
      'Total number of vessels expired due to TTL',
      ['vessel_id']
    )

    // Registry state metrics
    metricsRegistry.register(
      'discovery_registry_size',
      'gauge',
      'Number of vessels currently registered'
    )

    metricsRegistry.register(
      'discovery_shapes_count',
      'gauge',
      'Number of unique shapes in the registry'
    )

    // Circuit breaker metrics (from vessel-router)
    metricsRegistry.register(
      'circuit_breaker_state',
      'gauge',
      'Circuit breaker state (0=closed, 1=open, 2=half_open)',
      ['vessel_id']
    )

    // Resolution metrics
    metricsRegistry.register(
      'impulse_resolution_total',
      'counter',
      'Total number of impulse resolutions',
      ['shape', 'status']
    )

    metricsRegistry.register(
      'impulse_resolution_duration_ms',
      'histogram',
      'Duration of impulse resolution in milliseconds',
      ['shape'],
      [10, 50, 100, 250, 500, 1000, 2500, 5000]
    )
  }

  /**
   * Record a vessel registration
   */
  recordRegistration(vesselId: string, durationMs: number, success: boolean = true) {
    metricsRegistry.inc('vessel_registration_total', 1, {
      vessel_id: vesselId,
      status: success ? 'success' : 'failure'
    })

    if (success) {
      metricsRegistry.observe('vessel_registration_duration_ms', durationMs, {
        vessel_id: vesselId
      })
    }
  }

  /**
   * Record a vessel heartbeat
   */
  recordHeartbeat(vesselId: string, success: boolean = true) {
    metricsRegistry.inc('vessel_heartbeat_total', 1, {
      vessel_id: vesselId,
      status: success ? 'success' : 'failure'
    })
  }

  /**
   * Update heartbeat failure rate for a vessel
   */
  updateHeartbeatFailureRate(vesselId: string, failureRate: number) {
    metricsRegistry.set('vessel_heartbeat_failure_rate', failureRate, {
      vessel_id: vesselId
    })
  }

  /**
   * Record a vessel deregistration
   */
  recordDeregistration(vesselId: string, reason: 'manual' | 'expired' | 'error' = 'manual') {
    metricsRegistry.inc('vessel_deregistration_total', 1, {
      vessel_id: vesselId,
      reason
    })

    if (reason === 'expired') {
      metricsRegistry.inc('vessel_ttl_expired_total', 1, {
        vessel_id: vesselId
      })
    }
  }

  /**
   * Update registry state metrics
   */
  updateRegistryStats(totalVessels: number, totalShapes: number) {
    metricsRegistry.set('discovery_registry_size', totalVessels)
    metricsRegistry.set('discovery_shapes_count', totalShapes)
  }

  /**
   * Update circuit breaker state
   */
  updateCircuitBreakerState(vesselId: string, state: 'closed' | 'open' | 'half_open') {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2
    metricsRegistry.set('circuit_breaker_state', stateValue, {
      vessel_id: vesselId
    })
  }

  /**
   * Record an impulse resolution
   */
  recordResolution(shape: string, durationMs: number, success: boolean = true) {
    metricsRegistry.inc('impulse_resolution_total', 1, {
      shape,
      status: success ? 'success' : 'failure'
    })

    if (success) {
      metricsRegistry.observe('impulse_resolution_duration_ms', durationMs, {
        shape
      })
    }
  }
}

// Singleton metrics instance
export const discoveryMetrics = new DiscoveryMetrics()
