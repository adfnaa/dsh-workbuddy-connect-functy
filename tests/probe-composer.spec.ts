import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyProbeControl, type WorkBuddyProbeControlProps } from '../src/client/WorkBuddyProbeControl.tsx'
import { en } from '../src/client/locales.ts'

/**
 * Composer-entry tests. The interaction these pin down:
 *
 * - the inline label is a *static* feature name, never a state readout (the
 *   verified levels belong to the model dropdown, not to composer chrome);
 * - a hover/focus tooltip carries the state and the click's purpose;
 * - the confirmation is an in-page bubble, not `window.confirm` — and cancelling
 *   it sends nothing, because probing spends the user's credit.
 */

describe('Composer model probe', () => {
  let view: ReactTestRenderer | undefined
  let provider: string
  let model: string
  let state: ReturnType<WorkBuddyProbeControlProps['directory']['getSnapshot']>
  let statusBody: Record<string, unknown>
  const listeners = new Set<() => void>()
  const request = vi.fn()
  const directory = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as WorkBuddyProbeControlProps['directory']
  const t: WorkBuddyProbeControlProps['t'] = (key, params = {}) =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  function select(nextProvider: string, nextModel: string) {
    provider = nextProvider
    model = nextModel
    state = { current: { provider, model }, status: 'ready', groups: [], failures: [], error: null, routable: true }
    listeners.forEach(listener => listener())
  }

  /** The status document, with the probe section's fields overridable. */
  function probeStatus(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      probeKey: 'test-key',
      probe: { consent: true, auto: false, running: false, candidates: ['glm-5.2', 'auto'], results: [], ...overrides },
    }
  }

  beforeEach(() => {
    probeStatus()
    select('workbuddy', 'glm-5.2')
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => init?.method === 'POST'
        ? { state: 'ok', validation: 'non-validating', efforts: [] }
        : statusBody,
    }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    })
  })
  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
    listeners.clear()
  })

  async function mount() {
    await act(async () => { view = create(createElement(WorkBuddyProbeControl, { directory, t })) })
  }

  const posts = () => request.mock.calls.filter(([, init]) => init?.method === 'POST')
  const button = () => view!.root.findAllByType('button')
  const buttonLabels = () => button().map(node => node.children.join(''))
  const tooltips = () => view!.root.findAllByProps({ role: 'tooltip' })

  it('does not read status or show an entry for another provider', async () => {
    select('other', 'glm-5.2')
    await mount()
    expect(view?.toJSON()).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('hides declared or non-candidate models', async () => {
    select('workbuddy', 'glm-5.3')
    await mount()
    expect(view?.toJSON()).toBeNull()
  })

  it('shows a static feature label that never carries state', async () => {
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    // A detection result must not turn the label into a state readout; the
    // entry stays visible for the detected model, label unchanged.
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await act(async () => { listeners.forEach(listener => listener()) })
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeLabel)
    expect(JSON.stringify(view!.toJSON())).not.toContain('low / high')
  })

  it('explains the click in a tooltip on hover, not a native title', async () => {
    await mount()
    expect(tooltips()).toHaveLength(0)
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.children.join('')).toContain('glm-5.2')
    // The tooltip is the accessible description; no `title` attribute is used.
    expect(button()[0]!.props.title).toBeUndefined()
    expect(button()[0]!.props['aria-describedby']).toBeTruthy()
  })

  it('suppresses the tooltip while the result note is open', async () => {
    // The note and the tooltip anchor to the same spot, so showing both would
    // overlap them. The note already states the outcome the tooltip would, so
    // it wins; hovering must not stack a second bubble on top of it.
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await mount()
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(0)
    // The outcome is still on screen — in the note, not silently dropped.
    expect(JSON.stringify(view!.toJSON())).toContain('low / high')
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
  })

  it('shows the tooltip again once the note is dismissed', async () => {
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await mount()
    const dismiss = button().find(node => node.children.join('') === en.probeNoteDismiss)!
    await act(async () => { dismiss.props.onClick() })
    const wrapper = view!.root.findAllByType('span')[0]!
    await act(async () => { wrapper.props.onMouseEnter() })
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.children.join('')).toContain('low / high')
  })

  it('opens an in-page confirmation instead of window.confirm', async () => {
    await mount()
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    await act(async () => { button()[0]!.props.onClick() })
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(buttonLabels()).toEqual(expect.arrayContaining([en.cancel, en.probeConfirmAction]))
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const cancel = button().find(node => node.children.join('') === en.cancel)!
    await act(async () => { cancel.props.onClick() })
    expect(posts()).toHaveLength(0)
    // The bubble is gone again, leaving only the trigger.
    expect(button()).toHaveLength(1)
  })

  it('confirms the newly selected model and sends only that id, without automatic consent', async () => {
    await mount()
    await act(async () => { select('workbuddy', 'auto') })
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0]![1].body)).toEqual({ action: 'probe', model: 'auto' })
    expect(posts()[0]![1].headers['X-WorkBuddy-Probe-Key']).toBe('test-key')
  })

  it('blocks double clicks before the request finishes', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick(); detect.props.onClick() })
    expect(posts()).toHaveLength(1)
  })

  it('closes the confirmation once the request completes', async () => {
    await mount()
    await act(async () => { button()[0]!.props.onClick() })
    const detect = button().find(node => node.children.join('') === en.probeConfirmAction)!
    await act(async () => { detect.props.onClick() })
    // The POST resolves `ok`; the bubble must not linger over the composer.
    expect(button()).toHaveLength(1)
  })

  it('announces a recorded result as a small dismissable note', async () => {
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low', 'high'], probedAt: Date.now() }],
    })
    await mount()
    // The note shows the verified levels and a "got it" button.
    const noteText = view!.toJSON()
    expect(JSON.stringify(noteText)).toContain('low / high')
    expect(buttonLabels()).toContain(en.probeNoteDismiss)
  })

  it('reports a non-validating outcome instead of verified levels', async () => {
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'non-validating', efforts: [], probedAt: Date.now() }],
    })
    await mount()
    expect(JSON.stringify(view!.toJSON())).toContain(en.probeNoteNotValidating)
  })

  it('hides the note and remembers the dismissal for the same probedAt', async () => {
    const probedAt = Date.now()
    probeStatus({
      candidates: [],
      results: [{ id: 'glm-5.2', name: 'GLM-5.2', validation: 'validating', efforts: ['low'], probedAt }],
    })
    await mount()
    const dismiss = button().find(node => node.children.join('') === en.probeNoteDismiss)!
    await act(async () => { dismiss.props.onClick() })
    // The note is gone and the bubble state has no button labelled "got it".
    expect(button().map(node => node.children.join(''))).not.toContain(en.probeNoteDismiss)
  })
})
