/**
 * The composer's credit badge — "WorkBuddy: 5,266" at the right of the composer
 * dock — and the per-account breakdown it opens.
 *
 * Why this seat: the composer dock is the row DSH already fills with what the
 * turn cost (the context meter, tokens, cache-hit rate, speed). A credit figure
 * answers the next question — "and how much of my quota is left" — so it belongs
 * in that row, and it is registered LAST in it, which puts it to the right of the
 * context readout instead of among the harness's own figures.
 *
 * Why the click expands: the badge states one pool's total, but an account is
 * what a user acts on. Expanding in place answers "which account, and how much is
 * left on it" without a trip to the settings page, and it is the same interaction
 * the harness's own context meter uses — an anchored panel above the trigger,
 * dismissed by an outside pointer or Escape, placed with the same primitives.
 *
 * Why it is conditional on the model: the figure describes the quota behind the
 * model about to answer. Showing it while another provider is selected would
 * attach a WorkBuddy number to a session that cannot spend it.
 *
 * Three seats are read, and all are checked before anything is rendered:
 *
 * 1. **the session's current model** — through the same `ModelDirectory` store
 *    the reasoning-probe control uses, read with `useSyncExternalStore` so a
 *    model switch re-renders this badge;
 * 2. **the credit itself** — from the panel store both the sidebar card and the
 *    dashboard already poll, so the three surfaces can never disagree about what
 *    is left;
 * 3. **whether the badge is wanted at all** — the plugin-wide preference carried
 *    on the same status documents, read through the panel projection so the
 *    switch and the sidebar card's switch answer a missing field identically.
 *
 * A host that supplies none of them (an older client, or a profile without the
 * composer dock) renders nothing: this is an annotation, never a requirement.
 *
 * @module dsh-workbuddy-connect/client/credit-badge
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkBuddyWebAccount } from '../status-paths.ts'
import { buildPanelView } from './panel.ts'
import type { PanelProductView } from './panel.ts'
import { cardVariantFor } from './WorkBuddyProbeControl.tsx'
import type { PanelTranslator } from './panel-copy.ts'
import type { WorkBuddyPanelStore } from './panel-store.ts'

/** Props the composer dock hands this entry. */
export interface WorkBuddyCreditBadgeProps {
  /** Resolves the session's current model selection. */
  directory: ModelDirectory['store']
  /** The shared status store the sidebar card and dashboard read. */
  panel: WorkBuddyPanelStore
  /** The dock's copy binder, for the panel namespace. */
  t: PanelTranslator
}

/** One credit figure, grouped the way every other surface in this plugin groups it. */
function formatCredit(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

/**
 * One account's line inside the expanded panel.
 *
 * An account that reported no balance says so rather than showing a zero: "not
 * read yet" and "this account is empty" are different facts, and only the second
 * is worth acting on. A benched account is named as such for the same reason —
 * the figure alone would look like an account that is simply not being used.
 */
function AccountRow({ account, t }: { account: WorkBuddyWebAccount, t: PanelTranslator }): React.ReactNode {
  const name = account.label ?? account.nickname ?? account.name
  const figure = account.credits === undefined
    ? t('accountCreditsPending')
    : account.creditsTotal === undefined
      ? t('accountCreditsOnly', { remaining: formatCredit(account.credits) })
      : t('accountCreditsRow', { remaining: formatCredit(account.credits), total: formatCredit(account.creditsTotal) })
  return (
    <li className="wbp-badgeAccount">
      <span className="wbp-badgeAccountName" title={name}>{name}</span>
      <span className="wbp-badgeAccountValue">{figure}</span>
    </li>
  )
}

/**
 * One product's block: its heading and one row per account it has.
 *
 * A product with no accounts renders nothing at all rather than an empty
 * heading: the panel is a statement about the pools the user actually has, and a
 * product nobody signed into has no figures to state. (The sidebar card's own
 * rule, applied here for the same reason.)
 */
function ProductBlock({ product, t }: { product: PanelProductView, t: PanelTranslator }): React.ReactNode {
  if (product.accounts.length === 0) return null
  return (
    <section className="wbp-badgeGroup">
      <h3 className="wbp-badgeGroupTitle">{product.name}</h3>
      <ul className="wbp-badgeAccounts">
        {product.accounts.map(account => <AccountRow key={account.id} account={account} t={t} />)}
      </ul>
    </section>
  )
}

/**
 * The badge and its panel.
 *
 * Both stores are read through `useSyncExternalStore` with the same
 * subscribe/snapshot pair the probe control uses, so a model switch and a landed
 * sweep each update the figure in place.
 */
export function WorkBuddyCreditBadge({ directory, panel, t }: WorkBuddyCreditBadgeProps): React.ReactNode {
  const subscribeDirectory = useCallback((listener: () => void) => directory.subscribe(listener), [directory])
  const readDirectory = useCallback(() => directory.getSnapshot(), [directory])
  const selection = useSyncExternalStore(subscribeDirectory, readDirectory, readDirectory).current
  const subscribePanel = useCallback((listener: () => void) => panel.subscribe(listener), [panel])
  const readPanel = useCallback(() => panel.getSnapshot(), [panel])
  const snapshot = useSyncExternalStore(subscribePanel, readPanel, readPanel)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const view = buildPanelView({ snapshot })
  // A model under any other provider is not this badge's subject: the quota it
  // would name cannot be spent by the turn about to run.
  const card = selection == null ? undefined : cardVariantFor(selection.provider)
  const product = card === undefined
    ? undefined
    : view.products.find(candidate => candidate.id === card.id)
  const remaining = product?.creditsRemaining
  // Signed out, or a balance not read yet: no figure rather than a zero, which
  // would read as "this account is empty".
  const available = card !== undefined
    && product !== undefined
    && product.state === 'signed-in'
    && remaining !== undefined

  // Placement and dismissal are the harness's own: the panel hangs above the
  // trigger, anchored to its trailing edge so it cannot run off the composer, and
  // closes on an outside pointer or Escape — the same pair ContextMeter uses.
  const position = useAnchoredPosition({
    open: open && available,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    align: 'end',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open && available, setOpen, panelRef)
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])
  useEffect(() => {
    // Guarded rather than assumed: this component renders wherever the composer
    // does, and a DOM-free render (a test renderer, an SSR-ish host) has no
    // document to attach to — the panel is open in neither, so nothing is lost.
    if (!open || !available || typeof document === 'undefined') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [available, open])

  // The switch is checked before the figure is: a badge the user turned off must
  // leave nothing at all in the row, not a dimmed or empty placeholder.
  if (!view.composerCreditVisible) return null
  if (!available) return null

  const label = t('creditBadgeLabel', { product: card.appName, remaining: formatCredit(remaining) })
  return (
    <span className="wbp-creditBadgeRoot" ref={rootRef} data-workbuddy-credit-badge="">
      <Tooltip label={label} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className="wbp-creditBadge"
          aria-expanded={open}
          aria-label={label}
          onClick={() => { setOpen(current => !current) }}
        >
          <span className="wbp-creditBadgeName">{card.appName}</span>
          <span className="wbp-creditBadgeValue">{formatCredit(remaining)}</span>
        </button>
      </Tooltip>
      {open ? (
        <div
          className="wbp-badgePanel"
          ref={panelRef}
          style={position ?? undefined}
          role="dialog"
          aria-label={t('creditBadgePanelTitle')}
        >
          <p className="wbp-badgePanelTitle">{t('creditBadgePanelTitle')}</p>
          {view.products.map(candidate => <ProductBlock key={candidate.id} product={candidate} t={t} />)}
        </div>
      ) : null}
    </span>
  )
}
