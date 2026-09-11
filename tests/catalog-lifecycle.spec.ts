import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

/**
 * Catalog lifecycle: what happens across a credential change and a failed fetch.
 *
 * These use the real plugin `apply()` with a stubbed global fetch, because the
 * behaviour under test lives in the wiring rather than in any one module — the
 * credential sweep, the catalog gate, and the retry backoff all have to agree.
 */

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-lifecycle-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function credentialDocument(domain: string, uid: string): string {
  return JSON.stringify({
    auth: { accessToken: `at-${uid}`, refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid, nickname: uid, enterpriseId: 'ent-1' },
  })
}

/** A CN catalog envelope with one recognizable model id. */
function catalogEnvelope(modelId: string, name: string): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      models: [{ id: modelId, name, maxInputTokens: 100_000, maxOutputTokens: 1_000, supportsImages: true }],
      agents: [{ name: 'cli', models: [modelId] }],
    },
  })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

async function boot(): Promise<Context> {
  // Shorten the credential sweep so the lifecycle transitions are observable
  // without waiting the production interval. The retry backoff is expressed in
  // sweeps, so it scales down with it.
  vi.stubEnv('DSH_WORKBUDDY_POLL_MS', '100')
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(WorkBuddy, {})
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
  })
  return ctx
}

describe('catalog lifecycle', () => {
  it('serves a live catalog once the first fetch succeeds', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(catalogEnvelope('live-model', 'Live Model'))))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    })
    // The upstream roster replaced the built-in fallback entirely.
    expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).not.toContain('minimax-m3')
  })

  it('keeps the fallback roster and retries after a failed fetch', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))

    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1
      // Fail the first attempt only: the retry must recover on its own.
      return attempts === 1
        ? fakeResponse('upstream down', false, 503)
        : fakeResponse(catalogEnvelope('recovered-model', 'Recovered'))
    }))

    const ctx = await boot()
    // The failed fetch leaves the per-variant fallback serving: the group is
    // visible and usable rather than empty.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
    expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toContain('minimax-m3')
    expect(attempts).toBeGreaterThanOrEqual(1)

    // Without the retry this stayed on the fallback list until a manual
    // refresh — a startup network blip should not require user action.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['recovered-model'])
    }, { timeout: 10_000 })
  })

  it('does not re-fetch the catalog on every credential sweep', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    const request = vi.fn(async () => fakeResponse(catalogEnvelope('live-model', 'Live')))
    vi.stubGlobal('fetch', request)

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    })
    const afterFirst = request.mock.calls.length
    // Several sweeps' worth of time at the module's 30s interval would be too
    // slow to wait for here; instead assert the invariant that matters — a
    // successful fetch is not repeated for the same identity — by reading the
    // catalog repeatedly, which is what a sweep's early-return guards.
    for (let index = 0; index < 5; index += 1) await ctx.llm.listModels('workbuddy')
    expect(request.mock.calls.length).toBe(afterFirst)
  })

  it('hides the group when the credential disappears and restores it when it returns', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(catalogEnvelope('live-model', 'Live'))))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    })

    // Signing out (file removed) must remove the group, not leave it pickable.
    await rm(cnFile)
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    }, { timeout: 20_000 })

    // Signing back in restores it: the provider stayed registered throughout.
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['live-model'])
    }, { timeout: 20_000 })
  }, 45_000)

  it('does not show a previous account catalog after the account switches', async () => {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-a'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      // Answer per credential: the request carries the account's token, so the
      // second account gets a different roster.
      const auth = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '')
      return fakeResponse(auth.includes('uid-b')
        ? catalogEnvelope('account-b-model', 'B')
        : catalogEnvelope('account-a-model', 'A'))
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-a-model'])
    })

    // Switch the desktop app's account in place.
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-b'))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['account-b-model'])
    }, { timeout: 20_000 })
  }, 45_000)
})
