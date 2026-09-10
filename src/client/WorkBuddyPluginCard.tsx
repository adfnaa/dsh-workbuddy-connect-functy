/** WorkBuddy status card contributed to Harness Plugin configuration. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddyWebModelBadge, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelOfferStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const modelBadgeChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  return badge
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }

/**
 * Inline confirmation box for a paid detection. Replaces the previous
 * `window.confirm`: the decision is one line plus two buttons, and a modal
 * alert for that is heavier than the action it guards.
 */
const confirmBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
}
const confirmRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }

/** Hover breakdown of the models that are not at the common capacity. */
const contextTipStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 'calc(100% + 6px)',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 200,
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'default',
}
const contextTipRowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16 }

/**
 * Primary action of the inline confirmation. Fill and text colour come from the
 * theme as a pair: `brand-primary` is a light accent here, so pairing it with a
 * hardcoded white would render white-on-white.
 */
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
}

function dotStyle(status: WorkBuddyWebStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

/** One billing package as a labeled progress bar. */
function CreditBar({ label, remain, size, t }: {
  label: string
  remain: number
  size: number
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  const detail = size > 0 ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) }) : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = size > 0 ? (remain / size) * 100 : 100
  const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{t('percentRemaining', { percent: display })}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div style={progressFillStyle(percent)} />
      </div>
      <p style={bodyStyle}>{detail}</p>
    </div>
  )
}

/**
 * One model offer row: name, promotional badges, and the billing rate.
 *
 * The rate sits under the name rather than beside it because the row already
 * spends its horizontal budget on badges; stacking keeps long model names and
 * several badges from squeezing the rate into an ellipsis.
 */
function ModelOfferRow({ model, t }: {
  model: WorkBuddyWebModelBadge
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  return (
    <div style={modelOfferStyle}>
      <div style={quotaLabelStyle}>
        <span>{model.name}</span>
        <span style={modelBadgeStyle}>
          {model.badges?.map(badge => (
            <span key={badge} style={modelBadgeChipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
          {model.free === true ? <span style={modelBadgeChipStyle}>{t('freeModel')}</span> : null}
        </span>
      </div>
      {model.credits === undefined ? null : <span style={modelRateStyle}>{t('rate', { rate: model.credits })}</span>}
    </div>
  )
}

/**
 * Context capacity, summarized.
 *
 * A per-model list would be mostly noise: seven of fifteen models sit at the
 * same 1M, so a fifteen-row block spends its height repeating one number. What
 * actually matters is *which models are not 1M*, because that is what silently
 * ends a long conversation (a 200k model looks identical in the picker to its
 * 1M siblings).
 *
 * So: one line stating the common case, with the full breakdown on hover —
 * the same disclosure pattern the Composer's probe entry uses. Purely a report
 * of the upstream's own number; the plugin offers no tier picker, because the
 * catalog declares one capacity per model and publishes no alternatives.
 */
function ContextSummary({ models, t }: {
  models: readonly WorkBuddyWebModelBadge[] | undefined
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const known = (models ?? []).filter(model => model.contextWindow !== undefined)
  if (known.length === 0) return null

  // The most common capacity is the "normal" case; everything else is the
  // exception worth naming.
  const counts = new Map<number, number>()
  for (const model of known) counts.set(model.contextWindow as number, (counts.get(model.contextWindow as number) ?? 0) + 1)
  const [common] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] as [number, number]
  const exceptions = known.filter(model => model.contextWindow !== common)
  const commonCount = counts.get(common) ?? 0
  const summary = exceptions.length === 0
    ? t('contextAllSame', { tokens: formatTokens(common) })
    : t('contextMixed', { tokens: formatTokens(common), count: commonCount, total: known.length })

  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('contextHeading')}</h3>
      <span
        style={{ ...quotaLabelStyle, position: 'relative', cursor: 'help' }}
        onMouseEnter={() => { setOpen(true) }}
        onMouseLeave={() => { setOpen(false) }}
      >
        <span>{summary}</span>
        <span style={{ ...modelRateStyle, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {t('contextHoverHint')}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-5M12 8h.01" />
          </svg>
        </span>
        {open ? (
          <span role="tooltip" style={contextTipStyle}>
            <span style={{ fontWeight: 600 }}>{t('contextTipHeading')}</span>
            {exceptions.map(model => (
              <span key={model.id} style={contextTipRowStyle}>
                <span>{model.name}</span>
                <span>{formatTokens(model.contextWindow as number)}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/**
 * Compact token count for display: the catalog's own round numbers (`200000`,
 * `1000000`) read better as `200K` / `1M`, and no precision is lost because
 * these values are always whole thousands.
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}

/**
 * Reasoning-effort detection section: consent switches, per-model detection,
 * and the recorded observations.
 *
 * Two deliberate UX rules from the plan (§3.1, §3.2):
 * - the confirmation is shown *before* any request, and its copy states the
 *   request count and the credit caveat rather than the auto-detect switch
 *   silently enrolling the user;
 * - a `non-validating` result is presented as an observation about the
 *   parameter ("this model does not check it"), never as a statement that a
 *   level is unsupported.
 */
function ProbeSection({ probe, t, onDetect, onClear, busy }: {
  probe: WorkBuddyWebProbeSection
  t: WorkBuddyPluginCardInjected['t']
  onDetect: (modelId: string) => void
  onClear: () => void
  busy: boolean
}): React.ReactNode {
  // Which model is awaiting confirmation. Confirmation is inline for the same
  // reason the Composer entry uses a bubble: a modal alert for a one-line
  // decision is heavier than the action it guards.
  const [pending, setPending] = useState<string>()
  // A sweep that finishes (or a catalogue change that removes the candidate)
  // must not leave a stale confirmation behind.
  useEffect(() => {
    if (pending !== undefined && !probe.candidates.includes(pending)) setPending(undefined)
  }, [pending, probe.candidates])
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('probeHeading')}</h3>
      <p style={bodyStyle}>{t('probeIntro')}</p>
      <p style={bodyStyle}>{t('probeConsentHint')}</p>
      {probe.auto ? <p style={bodyStyle}>{t('probeAutoHint')}</p> : null}
      {probe.running ? <p style={bodyStyle}>{t('probeRunningGeneric')}</p> : null}

      {probe.results.length === 0 ? null : (
        <div style={quotaGroupStyle}>
          {probe.results.map(result => (
            <div key={result.id} style={modelOfferStyle}>
              <div style={quotaLabelStyle}>
                <span>{result.name}</span>
                <span style={modelBadgeStyle}>
                  {result.validation === 'validating' && result.efforts.length > 0
                    ? <span style={modelBadgeChipStyle}>{result.efforts.join(' / ')}</span>
                    : <span style={modelBadgeChipStyle}>{t(result.validation === 'non-validating' ? 'probeResultNotValidating' : 'probeResultUnknown')}</span>}
                </span>
              </div>
              <span style={modelRateStyle}>{t('probeResultAt', { time: formatTime(result.probedAt) })}</span>
            </div>
          ))}
        </div>
      )}

      {probe.candidates.length === 0
        ? <p style={bodyStyle}>{t('probeResultEmpty')}</p>
        : (
          <div style={quotaGroupStyle}>
            <p style={bodyStyle}>{t('probeCandidates', { count: probe.candidates.length })}</p>
            <div style={modelBadgeStyle}>
              {probe.candidates.map(id => (
                <button
                  key={id}
                  type="button"
                  style={buttonStyle}
                  disabled={probe.running || busy}
                  onClick={() => { setPending(id) }}
                >
                  {busy ? t('probeRunning', { model: id }) : `${t('probeStart')}: ${id}`}
                </button>
              ))}
            </div>
          </div>
        )}

      {pending === undefined ? null : (
        <div style={confirmBoxStyle}>
          <p style={bodyStyle}>{t('probeConfirmBody', { model: pending })}</p>
          <div style={confirmRowStyle}>
            <button type="button" style={buttonStyle} onClick={() => { setPending(undefined) }}>
              {t('cancel')}
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={probe.running || busy}
              onClick={() => { setPending(undefined); onDetect(pending) }}
            >
              {t('probeConfirmAction')}
            </button>
          </div>
        </div>
      )}

      {probe.results.length === 0 ? null : (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { onClear() }}>
          {t('probeClear')}
        </button>
      )}
    </div>
  )
}

/** Render WorkBuddy sign-in state and credit as one expandable card. */
export function WorkBuddyPluginCard({ t }: WorkBuddyPluginCardProps) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<WorkBuddyWebStatus>({ status: 'signed-out' })
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(WORKBUDDY_STATUS_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (mounted.current && signal?.aborted !== true) setStatus(value as WorkBuddyWebStatus)
    } catch (error: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
      }
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [open, refresh])

  useEffect(() => {
    if (!open || status.status !== 'signed-in') return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh, status.status])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * Run one control action and refresh the card's state afterwards.
   *
   * The key travels in a header, not the body: it authorizes the write, and
   * the host never accepts a prompt, a sentinel, or a model outside its own
   * catalog from here.
   */
  const control = useCallback(async (action: { action: 'probe'; model: string } | { action: 'clear' }): Promise<void> => {
    const key = status.status === 'signed-in' ? status.probeKey : undefined
    if (key === undefined) return
    setBusy(true)
    try {
      const response = await fetch(WORKBUDDY_PROBE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
        credentials: 'same-origin',
        body: JSON.stringify(action),
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof value === 'object' && value !== null && 'error' in value
          ? String((value as Record<string, unknown>)['error'])
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      await refresh()
    } catch (error: unknown) {
      if (mounted.current) {
        setStatus(previous => ({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') }))
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [refresh, status, t])

  /**
   * Start a detection. Confirmation happens inline in the section, so this is
   * only ever called after the user has already agreed.
   */
  const confirmDetect = useCallback((modelId: string): void => {
    void control({ action: 'probe', model: modelId })
  }, [control])

  const title = t('title')
  const label = status.status === 'signed-in'
    ? status.nickname === undefined ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '') : t('signedInAs', { nickname: status.nickname })
    : status.status === 'error'
      ? t('requestFailed')
      : t('signedOut')

  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{title}</span>
          <span style={descriptionStyle}>{t('intro')}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open
        ? <div style={cardBodyStyle}>
            <h3 style={quotaTitleStyle}>{t('accountHeading')}</h3>
            <div style={rowStyle}>
              <div style={statusStyle} role="status">
                <span aria-hidden="true" style={dotStyle(status.status)} />
                <span>{label}</span>
              </div>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
                {busy ? t('refreshing') : t('refresh')}
              </button>
            </div>
            {status.status === 'signed-in'
              ? <>
                  {status.expiresAt === undefined ? null
                    : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>}
                  {status.credits === undefined ? null : (
                    <div style={quotaListStyle}>
                      <div style={rowStyle}>
                        <h3 style={quotaTitleStyle}>{t('creditsHeading')}</h3>
                        <span style={bodyStyle}>{t('creditsTotal', { total: formatNumber(status.credits.total) })}</span>
                      </div>
                      {status.credits.accounts
                        .filter(account => account.remain > 0)
                        .map((account, index) => (
                        <CreditBar
                          key={`${account.packageName}-${String(index)}`}
                          label={account.packageName}
                          remain={account.remain}
                          size={account.size}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                  {status.creditsError === undefined ? null
                    : <p style={errorStyle}>{t('creditsError', { message: status.creditsError })}</p>}
                  {status.models === undefined || status.models.length === 0 ? null : (
                    <div style={quotaListStyle}>
                      <h3 style={quotaTitleStyle}>{t('modelsHeading')}</h3>
                      {status.models
                        .filter(model => model.free === true || (model.badges?.length ?? 0) > 0)
                        .map(model => <ModelOfferRow key={model.id} model={model} t={t} />)}
                    </div>
                  )}
                  <ContextSummary models={status.models} t={t} />
                  {status.probe === undefined ? null : (
                    <ProbeSection
                      probe={status.probe}
                      t={t}
                      busy={busy}
                      onDetect={confirmDetect}
                      onClear={() => { void control({ action: 'clear' }) }}
                    />
                  )}
                </>
              : null}
            {status.status === 'signed-out' ? <p style={bodyStyle}>{t('signedOutHint')}</p> : null}
            {status.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
          </div>
        : null}
    </li>
  )
}
