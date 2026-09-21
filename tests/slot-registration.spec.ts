import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { CARD_VARIANTS } from '../src/client/WorkBuddyPluginCard.tsx'

/**
 * The bundle's configuration entry, registered into the Plugins page's keyed
 * `plugins.bundle.config` slot.
 *
 * DSH 0.1.6 moved plugin configuration off the settings section's keyed
 * `settings.plugin.item` — which the settings tab dispatched once per served
 * settings namespace, i.e. one key per card — onto the Plugins page, where a
 * bundle carries a single entry keyed by its package name. This file pins the
 * consequences of that shape against the real registry rather than trusting the
 * registration call: one entry, one key, both variants rendered from it.
 *
 * `plugins.bundle.config` is a keyed slot, so whether a key is accepted (and
 * whether a duplicate is rejected) is a property of the real slot registry
 * rather than of this plugin's code. These tests drive the actual `SlotCore` to
 * answer that, instead of trusting that the registration shape works.
 *
 * Only the variant ids are needed from the card module (the components
 * themselves cannot render in this Node environment), and the register calls
 * are typed loosely on purpose: the point under test is the registry's
 * behaviour, not the DSH client typings.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The key the bundle registers under; the page looks the entry up by name. */
const BUNDLE_KEY = 'dsh-workbuddy-connect'

/** Minimal component stand-in; the registry only stores the reference. */
const Component = (): null => null

const register = (core: SlotCore, options: Record<string, unknown>): unknown =>
  (core.register as any)(options, Component)

/**
 * Declare `plugins.bundle.config` the way the Plugins page does: an entry
 * contributes a `children` table. `SlotCore` has no standalone declare method —
 * the child spec is owned by the registering entry, which is also why a slot can
 * only be claimed once.
 */
function declareBundleConfig(core: SlotCore): void {
  register(core, {
    name: 'root',
    children: {
      'plugins.bundle.config': {
        kind: 'keyed',
        keyProps: { [BUNDLE_KEY]: {} },
      },
    },
  })
}

const entries = (core: SlotCore): any[] => (core.entries as any)('plugins.bundle.config')

describe('plugins.bundle.config carries the bundle', () => {
  it('accepts the bundle-keyed registration the client entry makes', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    expect(() => register(core, { name: 'plugins.bundle.config', key: BUNDLE_KEY })).not.toThrow()
    expect(entries(core)).toHaveLength(1)
  })

  it('renders both variants from that one entry', () => {
    // The regression this guards: the slot is keyed by BUNDLE, not by variant,
    // so "one card per variant" can no longer mean "one registration per
    // variant". Both variants have to be reachable from the single component the
    // entry mounts, which is what the page iterates.
    expect(CARD_VARIANTS.map(card => card.id)).toEqual(['workbuddy', 'workbuddy-ai'])
  })

  it('keeps one component mounting both cards, not one key per card', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    register(core, { name: 'plugins.bundle.config', key: BUNDLE_KEY })
    // The projection returns the winning ENTRY per key, so the key is read off
    // `options` — one cell keyed by the bundle, holding both cards inside it.
    const cells = (core.entriesOfSlot as any)('plugins.bundle.config') as { options: { key?: string } }[]
    expect(cells).toHaveLength(1)
    expect(cells[0]!.options.key).toBe(BUNDLE_KEY)
  })

  it('rejects a second registration under the same key', () => {
    // Two profiles referencing the bundle, or the browser half loaded twice,
    // collide here. The client entry's try/catch is what turns that collision
    // into a `console.error` instead of a failed-loader banner.
    const core = new SlotCore()
    declareBundleConfig(core)
    register(core, { name: 'plugins.bundle.config', key: BUNDLE_KEY })
    expect(() => register(core, { name: 'plugins.bundle.config', key: BUNDLE_KEY }))
      .toThrow(/already has an entry for key/)
  })

  it('requires an explicit key, which is why the entry passes one', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    // This is the kind of breakage the client entry's try/catch exists for.
    expect(() => register(core, { name: 'plugins.bundle.config' }))
      .toThrow(/requires options.key/)
  })

  it('rejects registering into an undeclared slot', () => {
    const core = new SlotCore()
    expect(() => register(core, { name: 'plugins.bundle.config', key: BUNDLE_KEY }))
      .toThrow(/not declared/)
  })
})
