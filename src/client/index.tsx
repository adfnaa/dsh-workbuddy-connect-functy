/** Browser half: the bundle's WorkBuddy account cards on the Plugins page. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.tsx'
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
 * `@deepseek-ai/dsh-client-ui-renderer`, `locale` in
 * `@deepseek-ai/dsh-client-locale`, and the `plugins.bundle.config` slot is
 * declared by `@deepseek-ai/dsh-client-ui-plugin-manager`. That last one is
 * named in the package's `dsh.client.inject` list, so cordis has activated the
 * Plugins page before this plugin's fiber starts.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency at the client entry is required by the Desktop
// renderer; without it Cordis rejects `directoryFor()` before this bundle can
// finish registering its contributions.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * Register the card copy and the bundle's configuration page.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the 0.1.6 move from the settings section's keyed
 * `settings.plugin.item` to the Plugins page's `plugins.bundle.config`)
 * degrades to a `console.error` instead of throwing into the DSH loader and
 * raising the red "Failed to load plugins" banner. The host provider keeps
 * working: the `workbuddy` model channel is unaffected, and
 * `dsh-workbuddy-connect status` reports host health via the heartbeat file.
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
    // One configuration entry for the whole bundle, keyed by its package name
    // as the Plugins page dispatches it. It renders one card per variant — they
    // show different accounts, balances, and model sets, so a single merged
    // card could not say which account a number belongs to.
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
