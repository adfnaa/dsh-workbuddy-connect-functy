import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CARD_VARIANT, CN_CARD_VARIANT, WorkBuddyPluginCard } from '../src/client/WorkBuddyPluginCard.tsx'
import { en } from '../src/client/locales.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * Issue #36 card wiring: the visibility checkboxes inside the shared
 * `WorkBuddyPluginCard`. Because both DSH surfaces (0.1.5 settings cards and
 * the 0.1.6+ bundle configuration page) mount this one component, these tests
 * cover the feature on both; the seam dispatch itself is pinned by
 * `slot-registration.spec.ts`. Host-side semantics (store, filter boundary,
 * routes) live in `tests/model-visibility.spec.ts`.
 */

const MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 32_000, supportsImages: true, billing: { free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 1_000, maxTokens: 32_000, supportsImages: true, billing: { free: false } },
  { id: 'auto', name: 'Auto', contextWindow: 1_000, maxTokens: 32_000, supportsImages: true, billing: { free: false } },
]

describe('model visibility card controls', () => {
  let view: ReactTestRenderer | undefined
  /** The mutable status body every GET answers with (the simulated host truth). */
  let statusBody: Record<string, unknown>
  /** The response every POST answers with; `{ state: 'updated' }` saves. */
  let postResponse: Record<string, unknown>
  const posts: { body: Record<string, unknown>; headers: unknown }[] = []
  const request = vi.fn()

  const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  function signedIn(overrides: Record<string, unknown> = {}): void {
    statusBody = {
      status: 'signed-in',
      nickname: '昵称',
      probeKey: 'test-key',
      models: MODELS.map(model => ({ id: model.id, name: model.name })),
      visibility: { account: 'u1:', disabled: ['hy3'] },
      ...overrides,
    }
  }

  /** Apply one toggle to the simulated host truth, as the host would on success. */
  function applyToggle(body: Record<string, unknown>): void {
    if (body['action'] !== 'set-model-visibility') return
    const visibility = statusBody['visibility'] as { disabled: string[] } | undefined
    if (visibility === undefined) return
    const id = String(body['model'])
    visibility.disabled = body['visible'] === true
      ? visibility.disabled.filter(entry => entry !== id)
      : [...new Set([...visibility.disabled, id])]
  }

  /** The visibility checkboxes' checked states, in catalog order. */
  function checkboxStates(): boolean[] {
    return view!.root.findAll(node => {
      if (node.type !== 'input') return false
      return (node.props as Record<string, unknown>)['type'] === 'checkbox'
    }).map(node => (node.props as Record<string, unknown>)['checked'] === true)
  }

  /** Mount, expand, and switch to the context tab where the controls live. */
  async function mount(variant = CN_CARD_VARIANT): Promise<void> {
    const props = { t, variant } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
    await act(async () => { view = create(createElement(WorkBuddyPluginCard, props)) })
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    const tab = view!.root.findAllByType('button').find(node => node.children.join('') === en.tabContext)
    if (tab === undefined) throw new Error('context tab not found')
    await act(async () => { tab.props.onClick() })
  }

  /** Toggle the checkbox at one index and let the POST + follow-up read settle. */
  async function toggle(index: number, checked: boolean): Promise<void> {
    const boxes = view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['type'] === 'checkbox')
    const node = boxes[index]
    if (node === undefined) throw new Error(`no checkbox #${index}`)
    const onChange = (node.props as Record<string, unknown>)['onChange'] as (event: unknown) => void
    await act(async () => { onChange({ currentTarget: { checked } }) })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  }

  beforeEach(() => {
    signedIn()
    postResponse = { state: 'updated' }
    posts.length = 0
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return { ok: true, json: async () => statusBody }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ body, headers: init.headers })
      // A save the host confirms rewrites its truth before the card re-reads;
      // a refused one (state !== 'updated') leaves the truth untouched.
      if (postResponse['state'] === 'updated') applyToggle(body)
      return { ok: true, json: async () => postResponse }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  it('renders the checked state of the current account hidden list', async () => {
    await mount()
    // Catalog order glm-5.3 / hy3 / auto; only hy3 is hidden for u1.
    expect(checkboxStates()).toEqual([true, false, true])
  })

  it('unchecking sends the hide action and flips the box once the host confirms', async () => {
    await mount()
    await toggle(0, false)
    expect(posts[0]!.body).toEqual({ action: 'set-model-visibility', model: 'glm-5.3', visible: false })
    // The write is authorized the same way every control action is.
    expect((posts[0]!.headers as Record<string, string>)['X-Workbuddy-Probe-Key']).toBe('test-key')
    expect(checkboxStates()).toEqual([false, false, true])
  })

  it('re-checking sends the show action and restores the box', async () => {
    await mount()
    await toggle(1, true)
    expect(posts[0]!.body).toEqual({ action: 'set-model-visibility', model: 'hy3', visible: true })
    expect(checkboxStates()).toEqual([true, true, true])
  })

  it('a refused save neither flips the box nor claims success', async () => {
    postResponse = { state: 'failed', reason: 'model visibility needs a signed-in account with a stable user id' }
    await mount()
    await toggle(1, true)
    // The action was sent…
    expect(posts[0]!.body['model']).toBe('hy3')
    // …but the box still reports the host's truth, and the reason is on screen.
    expect(checkboxStates()).toEqual([true, false, true])
    expect(JSON.stringify(view!.toJSON())).toContain('stable user id')
  })

  it('renders no controls when the account has no stable uid', async () => {
    signedIn({ visibility: undefined })
    await mount()
    expect(checkboxStates()).toEqual([])
    expect(JSON.stringify(view!.toJSON())).not.toContain(en.visibilityHeading)
  })

  it('refreshing re-reads the section, so an account switch swaps the whole list', async () => {
    await mount()
    expect(checkboxStates()).toEqual([true, false, true])
    // The sweep adopted account u2 (or the user pressed Refresh): the same GET
    // now answers u2's section.
    signedIn({ visibility: { account: 'u2:', disabled: [] } })
    const refresh = view!.root.findAllByType('button').find(node => node.children.join('') === en.refresh)
    if (refresh === undefined) throw new Error('refresh button not found')
    await act(async () => { refresh.props.onClick() })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
    expect(checkboxStates()).toEqual([true, true, true])
  })

  it('the international card renders the same controls (shared component, both DSH surfaces)', async () => {
    await mount(AI_CARD_VARIANT)
    expect(checkboxStates()).toEqual([true, false, true])
  })
})
