/**
 * The daily check-in's record of what happened, and the timer that makes it
 * happen.
 *
 * Two pieces, deliberately in one module because neither is useful without the
 * other: the store answers "which accounts already claimed today, and what did
 * the last few attempts say", and the scheduler is the only writer that
 * matters. The card reads the store; the timer drives it.
 *
 * **The record is per account, and that is the second half of the feature.**
 * A pool with several members has several daily benefits — the upstream grants
 * one per account — so a day is settled per account, and the timer's job is to
 * claim for every one of them. Storing a single day flag meant the first
 * account's success wrote the whole product off until tomorrow, which is
 * exactly the defect this shape exists to prevent. The log stays ONE timeline
 * per variant, with the account named on each row: "what happened today" is one
 * question, and splitting it per account would make the section a set of
 * fragments the user has to reassemble.
 *
 * The day boundary is UTC+8 for both products — see `checkin.ts` for why the
 * machine's own zone is not consulted.
 *
 * @module dsh-workbuddy-connect/checkin-scheduler
 */

import { readStoreDocument, writeStoreDocument } from './store-file.ts'
import { workbuddyStateDir } from './paths.ts'
import { isJsonObject } from './json-value.ts'
import { join } from 'node:path'
import {
  DEFAULT_CHECK_IN_MINUTE,
  isPastCheckInTime,
  msUntilCheckIn,
  normalizeCheckInMinute,
  utc8DateString,
} from './checkin.ts'
import type { WorkBuddyCheckInResult } from './checkin.ts'

/** Basename of the check-in log inside the plugin's state directory. */
export const WORKBUDDY_CHECKIN_FILENAME = '.workbuddy-checkin.json'

/**
 * Current on-disk format; readers reject others.
 *
 * Version 2 is the per-account record. Version 1 held one day flag per variant,
 * which cannot answer "which account claimed" for any day it recorded — so it
 * is dropped rather than reinterpreted, and the log restarts.
 */
const CHECKIN_FORMAT_VERSION = 2

/** How many log rows are kept per variant, across all of its accounts. */
const LOG_LIMIT = 30

/** State-file path for one variant's log, inside the plugin's state directory. */
export function workbuddyCheckInPath(filename: string = WORKBUDDY_CHECKIN_FILENAME): string {
  return join(workbuddyStateDir(), filename)
}

/** One account a variant may claim for. */
export interface WorkBuddyCheckInAccount {
  /** Pool identity (`uid:enterpriseId`); the key this account's record is stored under. */
  id: string
  /** Display name, so a log row says which account it was. */
  name: string
}

/** One logged attempt, as the card renders it. */
export interface WorkBuddyCheckInLogRow {
  /** Stable id, so a re-render does not duplicate a row. */
  id: string
  date: string
  timestamp: number
  status: WorkBuddyCheckInResult['status']
  amount?: number
  message?: string
  /** Which account the attempt was for, as the card names it. */
  account?: string
}

/** What the store remembers for one account of one variant. */
export interface WorkBuddyCheckInAccountState {
  /** The last UTC+8 day an attempt for THIS ACCOUNT settled, `YYYY-MM-DD`. */
  lastDate: string
  /** When that attempt ran, epoch ms. */
  lastAt: number
  status: WorkBuddyCheckInResult['status']
  amount?: number
  message?: string
}

/** One variant's record: its per-account state and its shared timeline. */
export interface WorkBuddyCheckInVariantState {
  /** Keyed by pool identity; an account absent here has never been attempted. */
  accounts: Record<string, WorkBuddyCheckInAccountState>
  /** Most recent first, across every account of this variant. */
  logs: readonly WorkBuddyCheckInLogRow[]
}

/** The four statuses a row may carry; anything else is a file this build did not write. */
function isCheckInStatus(value: unknown): value is WorkBuddyCheckInResult['status'] {
  return value === 'claimed' || value === 'already-claimed'
    || value === 'no-campaign' || value === 'error'
}

/** Whether a parsed value is a log row this reader can trust. */
function isLogRow(value: unknown): value is WorkBuddyCheckInLogRow {
  if (!isJsonObject(value)) return false
  if (typeof value['id'] !== 'string' || value['id'] === '') return false
  if (typeof value['date'] !== 'string') return false
  if (typeof value['timestamp'] !== 'number' || !Number.isFinite(value['timestamp'])) return false
  return isCheckInStatus(value['status'])
}

/** Whether a parsed value is one account's record. */
function isAccountState(value: unknown): value is WorkBuddyCheckInAccountState {
  if (!isJsonObject(value)) return false
  if (typeof value['lastDate'] !== 'string') return false
  if (typeof value['lastAt'] !== 'number' || !Number.isFinite(value['lastAt'])) return false
  return isCheckInStatus(value['status'])
}

/**
 * The check-in record: one JSON document holding every variant's state.
 *
 * One file rather than one per product, because the two products' check-ins are
 * driven by the same timer and read by the same card; two files would only add
 * a second failure mode (one readable, one not) for no separation the user
 * asked for. The document is per-variant *inside*, and per-account inside that,
 * so neither the two products' histories nor two accounts' settle flags ever
 * mix.
 */
export class WorkBuddyCheckInStore {
  private readonly path: string

  constructor(path: string = workbuddyCheckInPath()) {
    this.path = path
  }

  /** Resolved path, for the CLI and tests. */
  filePath(): string {
    return this.path
  }

  /**
   * Every variant's record, normalized to shapes callers may trust.
   *
   * Deliberately forgiving: a hand-edited or truncated file loses the entries
   * that do not parse rather than the whole document, because the cost of a
   * dropped record is one redundant check-in — the upstream answers
   * "already-claimed" — while the cost of an all-or-nothing read is a day's
   * benefit spent claiming again from scratch.
   */
  private load(): Record<string, WorkBuddyCheckInVariantState> {
    const picked = readStoreDocument(this.path, CHECKIN_FORMAT_VERSION, document => {
      const variants = document['variants']
      return isJsonObject(variants) ? variants : undefined
    })
    const all: Record<string, WorkBuddyCheckInVariantState> = {}
    for (const [variantId, value] of Object.entries(picked ?? {})) {
      if (variantId === '' || !isJsonObject(value)) continue
      const accounts: Record<string, WorkBuddyCheckInAccountState> = {}
      const raw = value['accounts']
      if (isJsonObject(raw)) {
        for (const [accountId, entry] of Object.entries(raw)) {
          if (accountId === '' || !isAccountState(entry)) continue
          accounts[accountId] = {
            lastDate: entry.lastDate,
            lastAt: entry.lastAt,
            status: entry.status,
            ...typeof entry.amount === 'number' ? { amount: entry.amount } : {},
            ...typeof entry.message === 'string' ? { message: entry.message } : {},
          }
        }
      }
      const logs = value['logs']
      all[variantId] = {
        accounts,
        logs: Array.isArray(logs) ? logs.filter(isLogRow).slice(0, LOG_LIMIT) : [],
      }
    }
    return all
  }

  /** One variant's record, when it has one. */
  read(variantId: string): WorkBuddyCheckInVariantState | undefined {
    const state = this.load()[variantId]
    if (state === undefined) return undefined
    return { accounts: { ...state.accounts }, logs: [...state.logs] }
  }

  /** One account's state within a variant, when it has been attempted. */
  readAccount(variantId: string, accountId: string): WorkBuddyCheckInAccountState | undefined {
    return this.load()[variantId]?.accounts[accountId]
  }

  /**
   * Whether one account's day is already SETTLED — claimed, already taken, or
   * not on offer.
   *
   * An `error` is deliberately not settled: the next sweep must retry, or one
   * transient failure would cost that account the whole day's benefit.
   */
  settledToday(variantId: string, accountId: string, session: string): boolean {
    const state = this.load()[variantId]?.accounts[accountId]
    if (state === undefined || state.lastDate !== session) return false
    return state.status === 'claimed' || state.status === 'already-claimed' || state.status === 'no-campaign'
  }

  /**
   * Record one attempt for one account.
   *
   * @param session - the day this run belongs to, which is NOT the attempt's own
   *   date when a catch-up sweep settles a run scheduled for a moment that has
   *   since passed. Storing the attempt's date would make the next sweep read
   *   "not settled yet" for the day it just settled.
   * @param accountName - what the row says about which account, when the pool
   *   had a name for it.
   */
  write(
    variantId: string,
    accountId: string,
    accountName: string,
    result: WorkBuddyCheckInResult,
    session: string,
  ): void {
    const all = this.load()
    const previous = all[variantId]
    const row: WorkBuddyCheckInLogRow = {
      id: `${session}-${accountId}-${String(result.timestamp)}`,
      date: result.date,
      timestamp: result.timestamp,
      status: result.status,
      ...result.amount === undefined ? {} : { amount: result.amount },
      ...result.message === undefined ? {} : { message: result.message },
      ...accountName === '' ? {} : { account: accountName },
    }
    const logs = [row, ...(previous?.logs ?? []).filter(existing => existing.id !== row.id)].slice(0, LOG_LIMIT)
    all[variantId] = {
      accounts: {
        ...previous?.accounts,
        [accountId]: {
          lastDate: session,
          lastAt: result.timestamp,
          status: result.status,
          ...result.amount === undefined ? {} : { amount: result.amount },
          ...result.message === undefined ? {} : { message: result.message },
        },
      },
      logs,
    }
    writeStoreDocument(this.path, { version: CHECKIN_FORMAT_VERSION, variants: all })
  }

  /** Drop one variant's timeline, keeping every account's settle flag. */
  clearLogs(variantId: string): void {
    const all = this.load()
    const previous = all[variantId]
    if (previous === undefined) return
    all[variantId] = { accounts: previous.accounts, logs: [] }
    writeStoreDocument(this.path, { version: CHECKIN_FORMAT_VERSION, variants: all })
  }
}

/** One variant's check-in, as the scheduler needs it. */
export interface WorkBuddyCheckInTarget {
  variantId: string
  /**
   * Make the pool answerable, before {@link accounts} is asked.
   *
   * The sweep calls this once per variant per run. It exists because the pool
   * is not necessarily populated yet when the timer fires: a host that has just
   * started (or one whose desktop sign-in was only just adopted) has an empty
   * pool until something captures it, and `accounts()` is a plain synchronous
   * read that cannot do that itself.
   *
   * This is not theoretical. A catch-up sweep runs at startup, and at startup
   * the pool can be empty — so without this hook the very first check-in of a
   * fresh host would find nobody to claim for and quietly record nothing, which
   * is the day's benefit lost until the next start. The card's manual refresh
   * performs the same preparation for the same reason.
   *
   * A rejection is logged as that variant's failure and does not stop the other
   * variant: a pool that cannot be prepared may still be usable, and the
   * per-account attempt reports whatever is wrong with it anyway.
   */
  prepare?: () => Promise<void>
  /**
   * The accounts to claim for, in the order they should be tried.
   *
   * Read at each sweep rather than captured, so an account added — or signed in
   * through the desktop app — while the host is running is claimed for on the
   * very next run instead of after a restart.
   */
  accounts: () => readonly WorkBuddyCheckInAccount[]
  /** Claim today's benefit for ONE account of this variant. */
  checkIn: (session: string, account: WorkBuddyCheckInAccount, signal?: AbortSignal) => Promise<WorkBuddyCheckInResult>
  /** Whether the user has switched automatic check-in on for this variant. */
  enabled: () => boolean
  /** The moment to check in, as minutes past midnight UTC+8. */
  minuteOfDay: () => number
  /** Called after a claim landed, so the caller can re-read credit. */
  onClaimed?: () => void
}

/** Constructor dependencies. */
export interface WorkBuddyCheckInSchedulerOptions {
  targets: readonly WorkBuddyCheckInTarget[]
  store?: WorkBuddyCheckInStore
  /** Clock, injectable so the schedule is testable without waiting. */
  now?: () => number
  /** Where a settle is reported; defaults to nothing. */
  onResult?: (result: WorkBuddyCheckInResult) => void
}

/**
 * Runs each variant's check-in once a day, for every account in its pool, and
 * catches up a day the host was not running for.
 *
 * The catch-up rule is the reason this is not a bare `setTimeout`: a host that
 * is only started at 20:00 would otherwise never check in at all, because the
 * scheduled moment passed while it was down. A sweep therefore runs once at
 * startup, and it runs a variant only when the configured moment has ALREADY
 * passed and today is not settled — a host started before 10:00 waits for its
 * timer, exactly as the user asked it to. The per-account gate is the finer
 * one: a sweep claims for the accounts that are not settled and leaves the rest
 * alone, so a mid-day restart costs nothing and an account added in the
 * afternoon still gets that day's benefit.
 */
export class WorkBuddyCheckInScheduler {
  private readonly targets: readonly WorkBuddyCheckInTarget[]
  private readonly store: WorkBuddyCheckInStore
  private readonly now: () => number
  private readonly onResult: ((result: WorkBuddyCheckInResult) => void) | undefined
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** Variants with a run in flight, so a timer and a sweep cannot both spend. */
  private readonly inFlight = new Set<string>()
  private nextRuns = new Map<string, number>()
  private stopped = false

  constructor(options: WorkBuddyCheckInSchedulerOptions) {
    this.targets = options.targets
    this.store = options.store ?? new WorkBuddyCheckInStore()
    this.now = options.now ?? (() => Date.now())
    this.onResult = options.onResult
  }

  /** Start the timers, after one catch-up sweep. */
  start(): void {
    if (this.stopped) return
    void this.sweep(true)
    this.rearm()
  }

  /** Stop every timer; a run already in flight is left to finish. */
  dispose(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Re-arm every timer from the current configuration.
   *
   * Called after a settings write, so a moment the user has just changed takes
   * effect now rather than at the next firing of the old one.
   */
  rearm(): void {
    if (this.stopped) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.nextRuns = new Map()
    const nowMs = this.now()
    for (const target of this.targets) {
      const delay = msUntilCheckIn(target.minuteOfDay(), nowMs)
      this.nextRuns.set(target.variantId, nowMs + delay)
      const timer = setTimeout(() => {
        this.timers.delete(target.variantId)
        void this.sweep(false, target.variantId).finally(() => { this.rearm() })
      }, delay)
      // Never hold the host open: a pending check-in is not a reason to keep
      // DSH running, and the next start catches up anyway.
      timer.unref?.()
      this.timers.set(target.variantId, timer)
    }
  }

  /** When this variant's next run is due, epoch ms, when one is armed. */
  nextRunAt(variantId: string): number | undefined {
    return this.nextRuns.get(variantId)
  }

  /**
   * Sweep every variant (or one), claiming for each variant's unsettled
   * accounts.
   *
   * @param catchUp - true for the startup sweep, which also runs a variant whose
   *   scheduled moment has passed; false for a timer firing, which runs whatever
   *   it is told to.
   * @param only - restrict the sweep to one variant.
   */
  async sweep(catchUp: boolean, only?: string): Promise<void> {
    if (this.stopped) return
    const nowMs = this.now()
    const session = utc8DateString(nowMs)
    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!target.enabled()) continue
      if (this.inFlight.has(target.variantId)) continue
      if (catchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) continue
      this.inFlight.add(target.variantId)
      try {
        // Before asking who to claim for, let the target make its pool
        // answerable — a startup catch-up otherwise races the very capture that
        // signs the desktop account in (see {@link WorkBuddyCheckInTarget.prepare}).
        // A failure here is not fatal: the accounts that ARE known are still
        // worth claiming for, and each attempt reports its own problem.
        await target.prepare?.().catch((error: unknown) => {
          this.onResult?.({
            variantId: target.variantId,
            date: session,
            timestamp: nowMs,
            status: 'error',
            message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          })
        })
        if (this.stopped) return
        for (const account of target.accounts()) {
          if (this.stopped) return
          // Already settled today, and settled SUCCESSFULLY: a failed attempt is
          // retried by the next sweep rather than being written off for the day.
          if (this.store.settledToday(target.variantId, account.id, session)) continue
          await this.attempt(target, account, session, nowMs)
        }
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
  }

  /**
   * One account's attempt, reported as a result whatever happens.
   *
   * A throwing target must not stop the accounts behind it in the same pool,
   * and the failure is worth a log row: "nothing happened" is otherwise
   * indistinguishable from "it never ran".
   */
  private async attempt(
    target: WorkBuddyCheckInTarget,
    account: WorkBuddyCheckInAccount,
    session: string,
    nowMs: number,
  ): Promise<void> {
    try {
      const result = await target.checkIn(session, account)
      if (this.stopped) return
      this.store.write(target.variantId, account.id, account.name, result, session)
      if (result.status === 'claimed') target.onClaimed?.()
      this.onResult?.(result)
    } catch (error: unknown) {
      const failed: WorkBuddyCheckInResult = {
        variantId: target.variantId,
        date: utc8DateString(nowMs),
        timestamp: nowMs,
        status: 'error',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      }
      this.store.write(target.variantId, account.id, account.name, failed, session)
      this.onResult?.(failed)
    }
  }
}

export { DEFAULT_CHECK_IN_MINUTE, normalizeCheckInMinute }
