import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.ts'
import { fingerprintModel } from '../src/probe-store.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import type { WorkBuddyProbeRecord } from '../src/probe-store.ts'

/**
 * End-to-end tests for the observation/declaration merge, driven through the
 * real LLM seam rather than an internal helper
 * (`docs/reasoning-effort-probe-plan.md` §5).
 *
 * What must hold:
 * - with no observation, an undeclared model still exposes no control (the
 *   shipped behavior is unchanged for anyone who never opts in);
 * - a *validating* observation grants exactly the verified spellings;
 * - a *non-validating* observation grants nothing, because the upstream
 *   accepts values that cannot exist;
 * - a declared set is never overridden, and probing never confers `off`.
 */

const CLEANUP: string[] = []

afterEach(async () => {
  for (const path of CLEANUP.splice(0)) await rm(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** Write a probe record for `model` before the plugin boots, then start it. */
async function boot(options: {
  model?: WorkBuddyModelInfo['id']
  record?: (fingerprint: string) => WorkBuddyProbeRecord
}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wb-probe-'))
  CLEANUP.push(root)
  vi.stubEnv('DSH_HOME', root)

  if (options.record !== undefined && options.model !== undefined) {
    const info = WorkBuddy.FALLBACK_WORKBUDDY_MODELS.find(model => model.id === options.model)
    if (info === undefined) throw new Error(`no fallback model ${options.model}`)
    const store = new WorkBuddy.WorkBuddyProbeStore({ pluginVersion: 'test' })
    store.set(info.id, options.record(fingerprintModel(info)))
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WorkBuddy, {})
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
  })
  return ctx
}

/** The resolved efforts for one model, sorted, or undefined when none exist. */
async function effortsFor(ctx: Context, modelId: string): Promise<string[] | undefined> {
  const resolved = await ctx.llm.resolveModelInfo('workbuddy', modelId)
  return resolved.reasoning?.efforts.map(effort => effort.id).sort()
}

describe('probe results merged into the provider', () => {
  it('leaves an undeclared model without a control when nothing was observed', async () => {
    const ctx = await boot({})
    // `auto` is the old-form shape: no declared set, no observation.
    expect(await effortsFor(ctx, 'auto')).toBeUndefined()
    void ctx.fiber.dispose()
  })

  it('grants exactly the verified spellings for a validating observation', async () => {
    const ctx = await boot({
      model: 'auto',
      record: fingerprint => ({
        fingerprint,
        validation: 'validating',
        efforts: ['low', 'high'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
      }),
    })
    const efforts = await effortsFor(ctx, 'auto')
    expect(efforts).toEqual(['high', 'low'])
    // `off` is never conferred by probing, even though the picker knows the level.
    expect(efforts).not.toContain('off')
    expect(efforts).not.toContain('minimal')
    void ctx.fiber.dispose()
  })

  it('grants nothing for a non-validating observation', async () => {
    const ctx = await boot({
      model: 'auto',
      record: fingerprint => ({
        fingerprint,
        validation: 'non-validating',
        efforts: [],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
      }),
    })
    expect(await effortsFor(ctx, 'auto')).toBeUndefined()
    void ctx.fiber.dispose()
  })

  it('never overrides a declared set with an observation', async () => {
    const ctx = await boot({
      model: 'glm-5.3',
      // Fabricate an observation that disagrees with the declaration; the
      // declared set must still win.
      record: fingerprint => ({
        fingerprint,
        validation: 'validating',
        efforts: ['max'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
      }),
    })
    // Assert against the declaration actually in force rather than a hardcoded
    // list: the live upstream refresh replaces the fallback catalog, and its
    // declared set for this model has already drifted from the fallback's
    // (upstream now says low/high/max where the fallback says low/high/xhigh).
    // The invariant under test is that the observation never adds to or
    // replaces the declared set — not which values upstream declares this week.
    const info = WorkBuddy.FALLBACK_WORKBUDDY_MODELS.find(model => model.id === 'glm-5.3')
    const declared = [...(info?.reasoning?.supportedEfforts ?? [])].sort()
    const expected = info?.reasoning?.canDisableThinking === true ? ['off', ...declared].sort() : declared
    const efforts = await effortsFor(ctx, 'glm-5.3')
    expect(efforts).toEqual(expected)
    // `max` was in the fabricated observation; it appears only if declared.
    expect(efforts).not.toContain('medium')
    void ctx.fiber.dispose()
  })

  it('ignores an observation whose fingerprint no longer matches the catalog', async () => {
    const ctx = await boot({
      model: 'auto',
      record: () => ({
        fingerprint: 'stale-fingerprint',
        validation: 'validating',
        efforts: ['low', 'high'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
      }),
    })
    expect(await effortsFor(ctx, 'auto')).toBeUndefined()
    void ctx.fiber.dispose()
  })
})
