/** The bundle's configuration page on the sidebar's Plugins page. */

import type { CSSProperties, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `plugins.bundle.config` SlotMap entry, declared by the Plugins
// page. Cross-plugin collaboration goes through cordis services, so a value
// import would fail the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { CARD_VARIANTS, WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'

/** Props the Plugins page delivers to the bundle's configuration entry. */
export type WorkBuddyConfigPageProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.workbuddy'>

/** Cards stack with the section's own rhythm; the page supplies no chrome. */
const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }

/**
 * Render the bundle's configuration: one status card per WorkBuddy variant.
 *
 * Both variants share one page. DSH 0.1.6 replaced the settings section's
 * keyed `settings.plugin.item` slot — dispatched once per served settings
 * namespace, which is why the two variants used to be two cards — with the
 * Plugins page's `plugins.bundle.config`, keyed by the bundle's package name.
 * A bundle therefore carries exactly one configuration entry, so the cards are
 * stacked here instead of being dispatched separately. (The 0.1.5 settings tab
 * and its two dispatched cards still exist on 0.1.5 hosts; this page only
 * mounts where the Plugins page declares its slot.)
 */
export function WorkBuddyConfigPage({ view, t }: WorkBuddyConfigPageProps): ReactNode {
  // Only `view: 'page'` is asked for on this slot today; the one-liner answer
  // keeps the bundle legible if a summary seat ever renders it.
  if (view === 'summary') return t('intro')
  return (
    <div style={pageStyle}>
      {CARD_VARIANTS.map(variant => (
        <WorkBuddyPluginCard key={variant.id} t={t} variant={variant} />
      ))}
    </div>
  )
}
