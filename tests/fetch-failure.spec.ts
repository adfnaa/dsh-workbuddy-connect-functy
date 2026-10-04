import { describe, expect, it } from 'vitest'
import { FETCH_FAILURE_LIMIT, describeFetchFailure } from '../src/fetch-failure.ts'

/**
 * The one line a transport failure is allowed to leave behind.
 *
 * `fetch` reports every network-level failure as the same `TypeError: fetch
 * failed` and hides the reason in `cause`, so this renderer is what turns an
 * undiagnosable report ("detection said fetch failed") into a fixable one (a
 * refused proxy port, a DNS answer nobody expected, a reset).
 */

/** Shape of what undici puts behind `fetch failed` for a refused connection. */
function connectionRefused() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7891'), { code: 'ECONNREFUSED' }),
  })
}

describe('describeFetchFailure', () => {
  it('renders the cause undici hides behind "fetch failed"', () => {
    expect(describeFetchFailure(connectionRefused()))
      .toBe('TypeError: fetch failed; cause: Error: connect ECONNREFUSED 127.0.0.1:7891')
  })

  it('lists the per-address attempts of an AggregateError cause', () => {
    // Happy-eyeballs reports one entry per address it tried and keeps every
    // reason in `errors`; without them the line reads as a bare
    // "AggregateError" and explains nothing.
    const aggregate = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ETIMEDOUT 198.18.0.8:443'), { code: 'ETIMEDOUT' }),
    ])
    const line = describeFetchFailure(new TypeError('fetch failed', { cause: aggregate }))
    expect(line).toContain('cause: AggregateError')
    expect(line).toContain('connect ECONNREFUSED ::1:443')
    expect(line).toContain('connect ETIMEDOUT 198.18.0.8:443')
  })

  it('summarises an AggregateError longer than the listing budget', () => {
    const aggregate = new AggregateError([
      new Error('a'), new Error('b'), new Error('c'), new Error('d'),
    ])
    expect(describeFetchFailure(aggregate)).toBe('AggregateError; errors: Error: a, Error: b, Error: c (+ 1 more)')
  })

  it('keeps the abort reason a deadline produces', () => {
    // The probe's own 30-second deadline aborts through the same path, and
    // "AbortError" alone would not say whether the upstream or our timer hung up.
    const line = describeFetchFailure(new DOMException('This operation was aborted due to timeout', 'TimeoutError'))
    expect(line).toBe('TimeoutError: This operation was aborted due to timeout')
  })

  it('adds a code the message omits, and never repeats one it spells out', () => {
    expect(describeFetchFailure(Object.assign(new Error('bad port'), { code: 'ERR_INVALID_URL' })))
      .toBe('Error: bad port (ERR_INVALID_URL)')
    expect(describeFetchFailure(Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' })))
      .toBe('Error: getaddrinfo ENOTFOUND host')
  })

  it('reports a failure it cannot read rather than returning nothing', () => {
    expect(describeFetchFailure(undefined)).toBe('unknown transport failure')
    expect(describeFetchFailure(null)).toBe('unknown transport failure')
    expect(describeFetchFailure('socket hang up')).toBe('socket hang up')
  })

  it('caps the line so one failure cannot flood a log', () => {
    const line = describeFetchFailure(new Error('x'.repeat(FETCH_FAILURE_LIMIT * 2)))
    expect(line).toHaveLength(FETCH_FAILURE_LIMIT)
    expect(line.endsWith('…')).toBe(true)
  })

  it('stops walking a cause chain that loops back on itself', () => {
    const error = new Error('a')
    Object.assign(error, { cause: error })
    expect(describeFetchFailure(error)).toBe('Error: a')
  })
})
