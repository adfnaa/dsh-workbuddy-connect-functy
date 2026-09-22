/**
 * Browser half: the WorkBuddy account cards, on whichever settings surface the
 * host provides.
 *
 * One bundle serves two DSH generations. DSH 0.1.5 renders plugin cards in the
 * settings Plugins tab, which dispatches the keyed `settings.plugin.item` slot
 * once per served settings namespace (one card per WorkBuddy variant). DSH
 * 0.1.6 moved plugin configuration to the Plugins page, whose
 * `plugins.bundle.config` slot carries one bundle-keyed entry that renders both
 * variants itself. `ctx.slots.inject` follows the slot's declaration lifetime —
 * the callback runs where the slot is declared and simply never runs where it
 * is not — so registering BOTH seams needs no host-version check: each host
 * materializes exactly the seam it ships.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the two slot declarations this bundle registers into. The 0.1.5
// settings tab declares `settings.plugin.item`; the 0.1.6+ Plugins page
// declares `plugins.bundle.config`. Cross-plugin collaboration goes through
// cordis services, so value imports would fail the client bundle-purity gate;
// at runtime each host declares only the slot it ships.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.tsx'
import { CARD_VARIANTS, WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-connect-client'

/**
 * The bundle's package name, which is also this half's configuration key.
 *
 * The Plugins page dispatches `plugins.bundle.config` by the bundle's package
 * name, so the key has to spell exactly what the profile installs.
 */
export const BUNDLE_NAME = 'dsh-workbuddy-connect'

/**
 * Client services required by this browser half.
 *
 * DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
 * hold the browser `ClientContext` alias and the `slots` service), so the
 * services come from narrower packages: the `slots` registry lives in
 * `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
 * `@deepseek-ai/dsh-client-locale`. Neither slot owner is named here on
 * purpose: `settings.plugin.item`'s declarer (`…-ui-settings-plugins`) is
 * absent from 0.1.6+ hosts and `plugins.bundle.config`'s declarer
 * (`…-ui-plugin-manager`) is absent from 0.1.5 hosts, and the seam choice is
 * made by slot-declaration lifetime, not by activation order — `ctx.slots.inject`
 * fires whenever the declaring package commits the slot, before or after this
 * fiber starts.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * Register the card copy and both settings-surface seams.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` rename that once raised the red "Failed to
 * load plugins" banner) degrades to a `console.error` instead of throwing into
 * the DSH loader. The host provider keeps working: the `workbuddy` model
 * channel is unaffected, and `dsh-workbuddy-connect status` reports host
 * health via the heartbeat file.
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, because the real client entry imports
 * browser-only DSH packages that cannot load in the Node test environment.
 * That test therefore does not import this function — it replicates its
 * shape. If you change the guarded body or the `console.error` message here,
 * update the mirrored `apply()` in that spec too, or the fallback test will
 * silently diverge from this real implementation.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-connect: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
    // SEAM ONE — DSH 0.1.5's settings Plugins tab. One card per variant: they
    // show different accounts, balances, and model sets, so a single merged
    // card could not say which account a number belongs to. The slot is
    // key-dispatched (two keys, one component), and on 0.1.6+ hosts nothing
    // declares it, so these registrations simply never run there.
    for (const [index, variant] of CARD_VARIANTS.entries()) {
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: variant.id,
        priority: 30 - index,
        inject: (): WorkBuddyPluginCardInjected => ({ t, variant }),
      }, WorkBuddyPluginCard))
    }
    // SEAM TWO — DSH 0.1.6+'s Plugins page. One configuration entry for the
    // whole bundle, keyed by its package name as the page dispatches it; the
    // entry mounts both variants' cards itself. On 0.1.5 hosts nothing
    // declares this slot, so it never runs there.
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
      locale: namespace,
    }, WorkBuddyConfigPage))
    ctx.inject(['modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'workbuddy-probe',
        order: 10,
        inject: sessionId => ({
          directory: scope.modelDirectories.directoryFor(
            sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
          ).store,
          t,
        }),
      }, WorkBuddyProbeControl))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddy-connect] client card failed to load (host provider unaffected):', error)
  }
}
