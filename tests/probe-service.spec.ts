import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WorkBuddyProbeStore } from '../src/probe-store.ts'
import { WorkBuddyProbeService } from '../src/probe-service.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

describe('manual probe consent and deduplication', () => {
  const paths: string[] = []
  afterEach(() => { paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
  function setup() {
    const path = mkdtempSync(join(tmpdir(), 'wb-probe-service-'))
    paths.push(path)
    const catalog = new WorkBuddyCatalog()
    const send = vi.fn(async () => ({ status: 200, streamed: true }))
    const service = new WorkBuddyProbeService({
      catalog,
      store: new WorkBuddyProbeStore({ path: join(path, 'state.json'), pluginVersion: 'test' }),
      credentials: { current: async () => ({}) } as unknown as WorkBuddyCredentialStore,
      client: {} as WorkBuddyUpstreamClient,
      consent: () => false,
      send: () => send,
    })
    return { service, send }
  }
  it('keeps automatic requests gated but permits one confirmed model without changing consent', async () => {
    const { service, send } = setup()
    expect((await service.probe('glm-5.2')).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
    expect((await service.probe('glm-5.2', true)).state).toBe('ok')
    expect(send).toHaveBeenCalledTimes(2)
    expect((await service.probe('auto')).state).toBe('unavailable')
  })
  it('does not spend twice when two conversations submit the same model', async () => {
    const { service, send } = setup()
    const results = await Promise.all([service.probe('glm-5.2', true), service.probe('glm-5.2', true)])
    expect(results.map(result => result.state)).toEqual(['ok', 'ok'])
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('rejects declared and unknown models before sending', async () => {
    const { service, send } = setup()
    expect((await service.probe('glm-5.3', true)).state).toBe('unavailable')
    expect((await service.probe('not-in-catalog', true)).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
  })
})
