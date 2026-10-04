import { describe, expect, it } from 'vitest'
import {
  PROBE_EFFORT_CANDIDATES,
  PROBE_TRANSPORT_RETRIES,
  probeModel,
  randomSentinel,
  type ProbeAttempt,
  type ProbeSender,
} from '../src/probe.ts'

/**
 * Offline tests for the probe protocol. The point of these is the *gating*,
 * not the sweep: a model that answers
 * 200 to a value that cannot exist must never produce a per-level result, and
 * anything non-decisive must degrade to `unknown` rather than to a negative
 * capability claim.
 */

const ACCEPTED: ProbeAttempt = { status: 200, streamed: true }
const REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }
/** The global endpoint's rejection, measured 2026-10-01: same 11133 envelope, generic code. */
const GLOBAL_REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'model_param_invalid' }

/** A sender that answers from a table keyed by effort, with `undefined` = baseline. */
function tableSender(table: Map<string | undefined, ProbeAttempt>): ProbeSender {
  return async effort => table.get(effort) ?? REJECTED
}

/** Count how many requests a sender saw, to assert the sweep stops early. */
function counting(inner: ProbeSender): { send: ProbeSender; count: () => number } {
  let count = 0
  return {
    count: () => count,
    send: async (effort, signal) => {
      count += 1
      return inner(effort, signal)
    },
  }
}

const SENTINEL = 'probe_sentinel_test'

describe('probeModel', () => {
  it('verifies the levels a validating model accepts', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', REJECTED],
      ['high', ACCEPTED],
      ['xhigh', REJECTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'high', 'max'])
    // Baseline + sentinel + one per candidate.
    expect(outcome.requests).toBe(2 + PROBE_EFFORT_CANDIDATES.length)
  })

  it('marks a model that accepts the sentinel as non-validating and stops early', async () => {
    // This is the measured `glm-5.2` shape: everything answers 200, including a
    // value that cannot exist. Any per-level answer would be a false positive.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, ACCEPTED],
    ])
    const sent = counting(tableSender(table))
    const outcome = await probeModel({ send: sent.send, sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('non-validating')
    expect(outcome.efforts).toEqual([])
    // Baseline + sentinel only: no candidate was ever tried.
    expect(outcome.requests).toBe(2)
    expect(sent.count()).toBe(2)
  })

  it('reports unknown when the baseline fails', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 401, streamed: false, errorCode: 'unauthorized' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
    // The sentinel was never sent: a broken baseline explains nothing otherwise.
    expect(outcome.requests).toBe(1)
  })

  it('reports unknown when the sentinel fails non-attributably', async () => {
    // A 429 is not a statement about the effort value, so it must not be read
    // as "validating" and must not be read as a capability answer either.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 429, streamed: false, errorCode: 'rate_limited' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.requests).toBe(2)
  })

  it('does not treat a bare 400 as an effort rejection', async () => {
    // Same status, no attributable code: the plan requires degrading to unknown
    // rather than guessing that the effort caused it.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 400, streamed: false, errorCode: 'something_else' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
  })

  it('reads the global endpoint\'s generic parameter rejection as an effort rejection', async () => {
    // Measured 2026-10-01 on www.workbuddy.ai: a value that cannot exist is
    // answered 400/11133 with `extError.code: model_param_invalid`, while the
    // identical request without the field — and every canonical spelling —
    // answers 200 and streams.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED],
      ['low', ACCEPTED],
      ['medium', ACCEPTED],
      ['high', ACCEPTED],
      ['xhigh', ACCEPTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('applies the global rejection code to the level sweep as well', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED],
      ['low', ACCEPTED],
      ['medium', GLOBAL_REJECTED],
      ['high', ACCEPTED],
      ['xhigh', GLOBAL_REJECTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'high', 'max'])
  })

  it('keeps the China endpoint degrading the global-only generic code to unknown', async () => {
    // `model_param_invalid` was measured only on the global endpoint. The China
    // endpoint was measured answering the specific `invalid_reasoning_effort`,
    // so a generic code there must not be read as an effort rejection — the
    // region split is what keeps each endpoint to its own vocabulary.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, GLOBAL_REJECTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'cn' })
    expect(outcome.validation).toBe('unknown')
  })

  it('keeps the China endpoint degrading the global-only generic code mid-sweep too', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', GLOBAL_REJECTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'cn' })
    // A non-decisive answer mid-sweep: no partial set may leak out.
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
  })

  it('still degrades a sibling code from the same envelope to unknown', async () => {
    // `integer_below_min_value` arrives in the same 11133 envelope but names
    // the `max_tokens` floor, so it says nothing about the effort value. Run on
    // the global region explicitly: that is where the envelope was measured and
    // where the widened code set could otherwise mistake a sibling for an
    // effort rejection.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 400, streamed: false, errorCode: 'integer_below_min_value' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL, region: 'global' })
    expect(outcome.validation).toBe('unknown')
  })

  it('does not count a 200 without a stream as acceptance', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 200, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
  })

  it('abandons a mid-sweep failure rather than reporting a partial set', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', { status: 500, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    // The accepted `low` must not leak out as a finding.
    expect(outcome.efforts).toEqual([])
  })

  it('never probes `off` or `minimal`', () => {
    expect(PROBE_EFFORT_CANDIDATES).not.toContain('off')
    expect(PROBE_EFFORT_CANDIDATES).not.toContain('minimal')
  })

  it('survives a throwing sender by reporting unknown', async () => {
    let count = 0
    const outcome = await probeModel({
      send: async () => {
        count += 1
        throw new Error('socket hang up')
      },
      sentinel: () => SENTINEL,
      // A thrown sender is a transport failure, so the retry budget applies.
      sleep: async () => {},
    })
    expect(outcome.validation).toBe('unknown')
    expect(count).toBe(1 + PROBE_TRANSPORT_RETRIES)
  })
})

describe('transport failures', () => {
  /**
   * A sender that drops the attempts whose 1-based index is in `drops`.
   *
   * Transport drops are the one failure a probe must not read as evidence:
   * nothing about `reasoning_effort` was answered, because nothing arrived.
   */
  function dropping(drops: ReadonlySet<number>, inner: ProbeSender): { send: ProbeSender, count: () => number } {
    let count = 0
    return {
      count: () => count,
      send: async (effort, signal) => {
        count += 1
        if (drops.has(count)) return { status: 0, streamed: false, detail: 'transport error: TypeError: fetch failed' }
        return inner(effort, signal)
      },
    }
  }

  /** Every attempt drops. */
  const allDropped = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  /** Retrying must never spend real time in a test. */
  const noSleep = async (): Promise<void> => {}

  it('retries a dropped baseline instead of calling the model undetected', async () => {
    // The measured shape of the 2026-10-04 report: the sweep died on
    // `baseline status 0: transport error: TypeError: fetch failed` twice in
    // half a minute, and the identical request answered 200 moments later.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
    ])
    const sender = dropping(new Set([1, 2]), tableSender(table))
    const outcome = await probeModel({
      send: sender.send,
      sentinel: () => SENTINEL,
      sleep: noSleep,
      candidates: ['low'],
    })
    expect(outcome).toEqual({ validation: 'validating', efforts: ['low'], requests: 5 })
    // Two dropped baseline attempts, then baseline, sentinel and one level.
    expect(sender.count()).toBe(5)
  })

  it('retries a dropped level mid-sweep and still reports the full set', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', ACCEPTED],
    ])
    const sender = dropping(new Set([4]), tableSender(table))
    const outcome = await probeModel({
      send: sender.send,
      sentinel: () => SENTINEL,
      sleep: noSleep,
      candidates: ['low', 'medium'],
    })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'medium'])
    expect(sender.count()).toBe(5)
  })

  it('gives up after the configured retries and names the cause', async () => {
    const sender = dropping(allDropped, tableSender(new Map()))
    const outcome = await probeModel({ send: sender.send, sentinel: () => SENTINEL, sleep: noSleep })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
    expect(outcome.requests).toBe(1 + PROBE_TRANSPORT_RETRIES)
    if (outcome.validation !== 'unknown') throw new Error('unreachable')
    // The line the settings page shows must say how often it tried and why the
    // request never arrived; a bare "fetch failed" is what made the report
    // undiagnosable.
    expect(outcome.reason).toContain('baseline status 0')
    expect(outcome.reason).toContain(`(${1 + PROBE_TRANSPORT_RETRIES} attempts)`)
    expect(outcome.reason).toContain('transport error: TypeError: fetch failed')
  })

  it('honours a retry budget of zero', async () => {
    const sender = dropping(allDropped, tableSender(new Map()))
    const outcome = await probeModel({
      send: sender.send,
      sentinel: () => SENTINEL,
      sleep: noSleep,
      transportRetries: 0,
    })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.requests).toBe(1)
    expect(sender.count()).toBe(1)
  })

  it('never retries an HTTP answer', async () => {
    // A 401 is the upstream talking about this request: repeating it would only
    // repeat a conclusive answer.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 401, streamed: false, errorCode: 'unauthorized' }],
    ])
    // Nothing is dropped: the first attempt gets the upstream's own answer.
    const sender = dropping(new Set<number>(), tableSender(table))
    const outcome = await probeModel({ send: sender.send, sentinel: () => SENTINEL, sleep: noSleep })
    expect(outcome.validation).toBe('unknown')
    expect(sender.count()).toBe(1)
  })

  it('does not retry a step whose own deadline already expired', async () => {
    // A request that just spent its whole budget will spend it again, so the
    // retry would only triple the stall before reporting the same unknown. The
    // sender here answers only once its signal fires, which is what the
    // deadline does to a genuinely hung request.
    let count = 0
    const outcome = await probeModel({
      sentinel: () => SENTINEL,
      sleep: noSleep,
      timeoutMs: 5,
      send: async (effort, signal) => {
        count += 1
        await new Promise<void>(resolve => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return { status: 0, streamed: false, detail: 'transport error: AbortError: This operation was aborted' }
      },
    })
    expect(outcome.validation).toBe('unknown')
    expect(count).toBe(1)
  })
})


describe('randomSentinel', () => {
  it('is not a canonical effort spelling and varies per call', () => {
    const first = randomSentinel()
    const second = randomSentinel()
    expect(first).not.toBe(second)
    expect(first.startsWith('probe_sentinel_')).toBe(true)
    for (const effort of PROBE_EFFORT_CANDIDATES) expect(first).not.toBe(effort)
    expect(first).not.toBe('off')
  })
})
