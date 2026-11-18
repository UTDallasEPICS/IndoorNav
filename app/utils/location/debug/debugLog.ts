// Debug log for the location module: a record of what went into the position filters and what they did with it,
// so a walk that went wrong on a phone can be read afterwards (or replayed into the filters on a desktop).
//
// Off by default: everything takes NO_DEBUG_LOG, which does nothing. The app turns it on with the
// NUXT_PUBLIC_LOCATION_DEBUG_LOG build flag (see README.md), and then writes JSON lines to a file on the phone
// (capacitorFileLog.ts). The file never leaves the phone unless a developer copies it off (C02).
//
// Each record is one JSON object: { at, kind, ...data }. `at` is when it was logged (ms since the epoch); the inputs
// also carry their own sensor `timestamp`. Kinds:
//   start       service started: filter choice and options
//   ble.readings  per-AP RSSI and floor vote each BLE fix is computed from (ble.noFix: none came out)
//   fix         provider fix as the fusion engine received it (BLE/GPS position, accuracy, error ellipse)
//   step        PDR step (length, heading, heading accuracy): exactly what the step filter was given
//   motion      motion sensor state (moving, heading)
//   baro        barometer reading (pressure, height, its floor vs the BLE vote)
//   status      provider status change
//   event       floor / building / indoor-outdoor event
//   out         fused position the app was shown, and which filter produced it
//   fusion.*    fusion decisions (seeding, dropping the step filter)
//   pf.*        particle filter internals (step spread, wall crossings, gate, resampling, relocalizing, wall snap)
//   kf.*        StepKalman internals (gate, relocalizing)

export interface DebugLog {
  /** False for the no-op log: lets callers skip building records nobody will read */
  readonly enabled: boolean
  log(kind: string, data?: object): void
}

/** Logs nothing. The default everywhere. */
export const NO_DEBUG_LOG: DebugLog = { enabled: false, log() {} }

export interface DebugRecord {
  at: number
  kind: string
  [key: string]: unknown
}

/** Keeps records in memory (tests). */
export class MemoryDebugLog implements DebugLog {
  readonly enabled = true
  readonly records: DebugRecord[] = []

  constructor(private now: () => number = Date.now) {}

  log(kind: string, data: object = {}) {
    this.records.push({ at: this.now(), kind, ...data })
  }

  /** Records of one kind */
  of(kind: string) {
    return this.records.filter((r) => r.kind === kind)
  }
}

export interface JsonlDebugLogOptions {
  /** Write buffered lines at least this often (ms) */
  flushMs: number
  /** ...or as soon as this many are buffered */
  maxBufferedLines: number
  /** Decimal places kept on non-integer numbers (4 = 0.1 mm), to keep the file small */
  decimals: number
}

export const DEFAULT_JSONL_DEBUG_LOG: JsonlDebugLogOptions = { flushMs: 2000, maxBufferedLines: 200, decimals: 4 }

/**
 * Buffers records as JSON lines and hands them to `write` in batches, one write at a time and in order.
 * A failed write is counted and dropped; logging never throws into the location code.
 */
export class JsonlDebugLog implements DebugLog {
  readonly enabled = true
  /** Lines lost to failed writes */
  failedLines = 0
  private options: JsonlDebugLogOptions
  private lines: string[] = []
  private writing: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null
  private closed = false
  private replacer: (key: string, value: unknown) => unknown

  constructor(private write: (text: string) => Promise<void>, options: Partial<JsonlDebugLogOptions> = {}, private now: () => number = Date.now) {
    this.options = { ...DEFAULT_JSONL_DEBUG_LOG, ...options }
    const factor = 10 ** this.options.decimals
    this.replacer = (_key, value) => typeof value === 'number' && !Number.isInteger(value) && Number.isFinite(value)
      ? Math.round(value * factor) / factor
      : value
    this.timer = setInterval(() => { void this.flush() }, this.options.flushMs)
  }

  log(kind: string, data: object = {}) {
    if (this.closed) return
    let line: string
    try {
      line = JSON.stringify({ at: this.now(), kind, ...data }, this.replacer)
    } catch {
      line = JSON.stringify({ at: this.now(), kind, unserializable: true })
    }
    this.lines.push(line)
    if (this.lines.length >= this.options.maxBufferedLines) void this.flush()
  }

  /** Writes whatever is buffered. Resolves once it (and every earlier write) has finished. */
  flush(): Promise<void> {
    if (this.lines.length) {
      const batch = this.lines
      this.lines = []
      this.writing = this.writing.then(() => this.write(batch.join('\n') + '\n')).catch(() => {
        this.failedLines += batch.length
      })
    }
    return this.writing
  }

  /** Stops the timer and writes the rest. Later records are ignored. */
  async close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.closed = true
    await this.flush()
  }
}
