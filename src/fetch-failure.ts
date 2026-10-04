/**
 * Why a `fetch` never reached the upstream, rendered as one line.
 *
 * Node reports every network-level failure as the same `TypeError: fetch
 * failed` and keeps the only useful part — the DNS, connect, TLS, or abort
 * reason — inside `error.cause`, sometimes one link further down again
 * (happy-eyeballs reports an `AggregateError` whose `errors` hold one entry
 * per address it tried). A plain `String(error)` therefore says nothing about
 * a request that never left the machine, which is exactly the question a
 * "detection incomplete" line and a failed message have to answer.
 *
 * Reads the fields rather than testing `instanceof Error`: the failures worth
 * describing arrive from a different realm as often as not (a `DOMException`
 * abort, an `AggregateError` built by the socket layer, an error that crossed
 * a worker boundary), and every one of them spells `name` and `message` the
 * same way.
 *
 * Pure and dependency-free: the transport client and the probe protocol both
 * format their own failures with it, so one occurrence reads the same wherever
 * it surfaced.
 *
 * @module dsh-workbuddy-connect/fetch-failure
 */

/** Longest rendered chain; this is a log line, not a stack trace. */
export const FETCH_FAILURE_LIMIT = 240

/** Deepest `cause` chain followed before the walk gives up. */
const MAX_DEPTH = 4

/** Most `AggregateError.errors` members listed; the rest are summarised. */
const MAX_AGGREGATE_MEMBERS = 3

/** One link of the chain, as `Name: message` plus a code the message omits. */
function describeOne(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as { name?: unknown, message?: unknown, code?: unknown }
    const message = typeof record.message === 'string' ? record.message.trim() : ''
    const name = typeof record.name === 'string' && record.name !== '' ? record.name : 'Error'
    const named = message === '' ? name : `${name}: ${message}`
    // A code the message already spells out (Node writes `connect ECONNREFUSED
    // 127.0.0.1:7890`) is not repeated; one it omits adds the machine-readable
    // half that greps well.
    return typeof record.code === 'string' && record.code !== '' && !named.includes(record.code)
      ? `${named} (${record.code})`
      : named
  }
  if (typeof value === 'string') return value
  return Object.prototype.toString.call(value)
}

/**
 * Render a thrown fetch failure, including the cause chain behind it.
 *
 * Never throws and never returns an empty string: an unreadable value still
 * yields a line that says so, because the caller is already reporting a
 * failure it could not explain.
 */
export function describeFetchFailure(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (current === undefined || current === null || seen.has(current)) break
    seen.add(current)
    const link = describeOne(current)
    if (link !== '') parts.push(depth === 0 ? link : `cause: ${link}`)
    // Happy-eyeballs hides every per-address attempt in here; without it a
    // failure reads as a bare `AggregateError` with no reason at all.
    const aggregate: unknown = (current as { errors?: unknown }).errors
    if (Array.isArray(aggregate) && aggregate.length > 0) {
      const members = aggregate.slice(0, MAX_AGGREGATE_MEMBERS).map(describeOne).filter(text => text !== '')
      if (members.length > 0) {
        const omitted = aggregate.length - members.length
        parts.push(`errors: ${members.join(', ')}${omitted > 0 ? ` (+ ${omitted} more)` : ''}`)
      }
    }
    current = (current as { cause?: unknown }).cause
  }
  const line = parts.length === 0 ? 'unknown transport failure' : parts.join('; ')
  return line.length <= FETCH_FAILURE_LIMIT ? line : `${line.slice(0, FETCH_FAILURE_LIMIT - 1)}…`
}
