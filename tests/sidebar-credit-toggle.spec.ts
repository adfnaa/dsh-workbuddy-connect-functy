import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { FakeSettingsService } from './fake-settings.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'
import { workbuddyConfigDir } from '../src/paths.ts'
import * as WorkBuddy from '../src/index.ts'

/**
 * The sidebar credit card's own switch, end to end through the REAL wiring.
 *
 * Every layer of this preference is unit-tested on its own — the route parses
 * it, the status document carries it, the view model reads it, the card obeys
 * it. What none of those can show is that the pieces the plugin's `apply()`
 * assembles are joined up: the config field the settings form writes, the
 * closure that publishes it on the status document, and the closure that
 * receives the write are three separate places in `src/index.ts`, and a getter
 * wired to the wrong key (or not wired at all) would leave all the unit tests
 * green and the switch doing nothing.
 *
 * So this drives the plugin as the host does: boot it against a stand-in
 * `webServer` that keeps the handlers `apply()` really registered, serve those
 * over loopback HTTP, and read the switch back off the document.
 */

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A desktop-shaped credential document for one upstream region. */
function credentialDocument(domain: string, uid = 'uid-1'): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid, nickname: uid, enterpriseId: 'ent-1' },
  })
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-credit-toggle-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * Stands in for the Host's webServer so the plugin's REAL routes — as wired by
 * `apply()`, not re-mounted by hand — become callable from this test.
 */
class FakeWebServer extends Service {
  static current: FakeWebServer | undefined
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    FakeWebServer.current = this
  }

  register(route: { kind: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

/** Serve the captured routes over real HTTP, so the handlers see real req/res. */
async function serve(): Promise<{ get: (path: string) => Promise<Record<string, unknown>>, post: (path: string, body: unknown, key: string) => Promise<{ status: number, body: Record<string, unknown> }> }> {
  const routes = FakeWebServer.current?.routes ?? new Map()
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404).end('{}'); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const origin = `http://127.0.0.1:${String(port)}`
  return {
    get: async path => JSON.parse(await (await fetch(origin + path, {
      headers: { host: `127.0.0.1:${String(port)}` },
    })).text()) as Record<string, unknown>,
    post: async (path, body, key) => {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
  }
}

/**
 * Boot the plugin with a signed-in CN desktop credential and no network.
 *
 * The fetch stub is what keeps this offline: the CN catalog endpoint would
 * otherwise be called with a synthesized token, and the fallback roster is
 * enough for a test about a display preference.
 */
async function boot(): Promise<{ get: Awaited<ReturnType<typeof serve>>['get'], post: Awaited<ReturnType<typeof serve>>['post'] }> {
  const root = await tempDir()
  const cnFile = join(root, 'cn.info')
  await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
  vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
  // The stub must leave this test's own calls to the mounted routes alone:
  // delegate loopback requests to the real fetch, and fail only upstream ones.
  // Answering the loopback ones would deadlock the test against itself.
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
    throw new Error('offline in tests')
  }))

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeSettingsService)
  await ctx.plugin(FakeWebServer)
  // The profile entry the settings form writes to, declared through the SAME
  // schema the loader validates with — so a field the schema does not carry (or
  // does not mark volatile) fails here rather than in production.
  const settings = FakeSettingsService.current as FakeSettingsService
  settings.declareEntry(WorkBuddy.PROFILE_ENTRY_ID, {}, WorkBuddy.Config)
  const fiber = ctx.plugin(WorkBuddy, {})
  await fiber
  // Bind to what the fiber actually received: cordis ran the plugin's schema, so
  // that object holds the live references a later write has to land in.
  settings.bindFiber(WorkBuddy.PROFILE_ENTRY_ID, fiber.config)
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
  })
  return serve()
}

describe('the sidebar credit card switch', () => {
  /**
   * The whole round trip, in the order a user performs it.
   *
   * Off is asserted twice over: in the status document, which is what the
   * sidebar actually draws itself from, and in the live settings value, which is
   * what survives the reload. A write that reached only one of them would leave
   * the card gone until the next restart, or present again after it.
   */
  it('publishes the default, stores the write, and serves it back on the next read', async () => {
    const { get, post } = await boot()

    const before = await get(CN_VARIANT.statusPath)
    // The schema default: a config that never mentioned the field still draws
    // the card, so an upgrade alone never empties the sidebar.
    expect(before['sidebarCreditVisible']).toBe(true)
    expect(before['sidebarCreditStyle']).toBe('remaining')
    const key = before['probeKey']
    expect(typeof key).toBe('string')

    const written = await post(CN_VARIANT.probePath, { action: 'set-sidebar-credit-visible', enabled: false }, key as string)
    expect(written).toMatchObject({ status: 200, body: { state: 'updated' } })

    // The settings field itself moved — this is the value a restart re-reads.
    expect(FakeSettingsService.current?.valueOf(WorkBuddy.PROFILE_ENTRY_ID, 'sidebarCreditVisible')).toBe(false)

    const after = await get(CN_VARIANT.statusPath)
    expect(after['sidebarCreditVisible']).toBe(false)
    // Turning the card off is not a statement about the figures: the pool is
    // still read, and the style the card WOULD use is still reported, so
    // switching it back on restores exactly what the user had chosen.
    expect(after['sidebarCreditStyle']).toBe('remaining')
    expect(after['status']).toBe('signed-in')
  })

  /**
   * Both products' routes carry the one preference, and both states do.
   *
   * The sidebar is a single column: whichever product the user happened to open
   * the settings page for writes the same answer, and the international route
   * has to serve it back even when that pool is empty — otherwise the card would
   * reappear the moment a document that does not know the setting was read.
   */
  it('serves one answer from both routes, in both sign-in states', async () => {
    const { get, post } = await boot()
    const key = (await get(CN_VARIANT.statusPath))['probeKey'] as string

    // Written through the CN route, read back off the international one — the
    // variant that has no account at all in this test.
    expect((await post(CN_VARIANT.probePath, { action: 'set-sidebar-credit-visible', enabled: false }, key)).status).toBe(200)
    const ai = await get(AI_VARIANT.statusPath)
    expect(ai['status']).toBe('signed-out')
    expect(ai['sidebarCreditVisible']).toBe(false)

    // And the other way round: the write is not owned by the route that made it.
    expect((await post(AI_VARIANT.probePath, { action: 'set-sidebar-credit-visible', enabled: true }, key)).status).toBe(200)
    expect((await get(CN_VARIANT.statusPath))['sidebarCreditVisible']).toBe(true)
  })

  /**
   * The composer badge's switch travels the same wire and the same plugin-wide
   * rule, over a surface the sidebar knows nothing about.
   */
  it('publishes and stores the composer badge switch, beside the sidebar card', async () => {
    const { get, post } = await boot()
    const before = await get(CN_VARIANT.statusPath)
    // A document that never mentions the field still draws the badge: an
    // upgrade alone must not take a surface away.
    expect(before['composerCreditVisible']).toBe(true)

    const key = before['probeKey'] as string
    expect(await post(CN_VARIANT.probePath, { action: 'set-composer-credit-visible', enabled: false }, key))
      .toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(FakeSettingsService.current?.valueOf(WorkBuddy.PROFILE_ENTRY_ID, 'composerCreditVisible')).toBe(false)

    // Written through the CN route, read back off the international one: one
    // composer, so one answer, whichever route carries the write.
    expect((await get(AI_VARIANT.statusPath))['composerCreditVisible']).toBe(false)
    // Independent of the sidebar's own switch — the two are different surfaces.
    expect((await get(CN_VARIANT.statusPath))['sidebarCreditVisible']).toBe(true)
  })

  /**
   * The third composer switch travels the same wire, and stays independent of
   * the two credit surfaces: a user may hide the badge and keep the detection
   * control, or the reverse.
   */
  it('publishes and stores the detection-control switch, independently', async () => {
    const { get, post } = await boot()
    const before = await get(CN_VARIANT.statusPath)
    expect(before['probeControlVisible']).toBe(true)
    const key = before['probeKey'] as string

    expect(await post(CN_VARIANT.probePath, { action: 'set-probe-control-visible', enabled: false }, key))
      .toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(FakeSettingsService.current?.valueOf(WorkBuddy.PROFILE_ENTRY_ID, 'probeControlVisible')).toBe(false)

    const after = await get(AI_VARIANT.statusPath)
    expect(after['probeControlVisible']).toBe(false)
    // The credit surfaces are untouched: three switches, three fields.
    expect(after['composerCreditVisible']).toBe(true)
    expect(after['sidebarCreditVisible']).toBe(true)
  })

  it('refuses the write without the in-process key, and leaves the card alone', async () => {
    const { get, post } = await boot()
    const refused = await post(CN_VARIANT.probePath, { action: 'set-sidebar-credit-visible', enabled: false }, 'not-the-key')
    expect(refused.status).toBe(403)
    expect((await get(CN_VARIANT.statusPath))['sidebarCreditVisible']).toBe(true)
  })
})

/**
 * The model filter's account selector, through the REAL routes.
 *
 * This is the one test that covers the round trip the feature actually is: the
 * page asks one product's probe route to point the model filter at a pool
 * account, the host stores that as a config field, and the status document the
 * card renders reports the account the filter now applies for — with the list of
 * accounts to choose from. Every unit in between is covered elsewhere; what is
 * only provable here is that the route, the config field and the getter agree.
 */
describe('the model filter account selector', () => {
  /**
   * Boot with TWO accounts in the CN pool, so a choice has somewhere to go.
   *
   * The second account is added through the pool file rather than the desktop
   * credential, which is how a QR sign-in looks: the pool is where a selector's
   * options come from, and the desktop app can only ever contribute one.
   */
  async function bootWithTwoAccounts(): Promise<{
    get: (path: string) => Promise<Record<string, unknown>>
    post: (path: string, body: unknown, key: string) => Promise<{ status: number, body: Record<string, unknown> }>
  }> {
    const root = await tempDir()
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com', 'uid-1'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent.info'))
    await mkdir(workbuddyConfigDir(), { recursive: true })
    await writeFile(join(workbuddyConfigDir(), '.workbuddy-accounts.json'), JSON.stringify({
      version: 1,
      accounts: [
        {
          id: 'uid-1:ent-1', uid: 'uid-1', enterpriseId: 'ent-1', domain: 'copilot.tencent.com',
          accessToken: 'at-1', refreshToken: 'rt-1', expiresAtMs: Date.now() + 3_600_000,
          origin: 'desktop', enabled: true, lastUsedAtMs: 0,
        },
        {
          id: 'uid-2:ent-2', uid: 'uid-2', enterpriseId: 'ent-2', nickname: 'Second', domain: 'copilot.tencent.com',
          accessToken: 'at-2', refreshToken: 'rt-2', expiresAtMs: Date.now() + 3_600_000,
          origin: 'qr', enabled: true, lastUsedAtMs: 0,
        },
      ],
    }))
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
      throw new Error('offline in tests')
    }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FakeSettingsService)
    await ctx.plugin(FakeWebServer)
    const settings = FakeSettingsService.current as FakeSettingsService
    settings.declareEntry(WorkBuddy.PROFILE_ENTRY_ID, {}, WorkBuddy.Config)
    const fiber = ctx.plugin(WorkBuddy, {})
    await fiber
    settings.bindFiber(WorkBuddy.PROFILE_ENTRY_ID, fiber.config)
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    return serve()
  }

  it('offers the pool, stores the choice, and reports it back', async () => {
    const { get, post } = await bootWithTwoAccounts()
    const before = await get(CN_VARIANT.statusPath)
    const visibility = before['visibility'] as {
      account?: string
      choices?: { id: string, name: string, active: boolean }[]
      chosen?: boolean
    }
    const key = before['probeKey'] as string

    // Both accounts are offered, and the one in effect is marked. Without this
    // list the page would have no controls at all, so its presence is the
    // feature's capability signal.
    expect(visibility.choices?.map(choice => choice.id)).toEqual(['uid-1:ent-1', 'uid-2:ent-2'])
    expect(visibility.choices?.find(choice => choice.active)?.id).toBe('uid-1:ent-1')
    // The country account is named by its nickname, the other by a short uid.
    expect(visibility.choices?.map(choice => choice.name)).toEqual(['uid-1', 'Second'])
    // Nothing stored yet, so the primary rule is what answered.
    expect(visibility.account).toBe('uid-1:ent-1')
    expect(visibility.chosen).toBe(false)

    expect(await post(CN_VARIANT.probePath, { action: 'set-visibility-account', account: 'uid-2:ent-2' }, key))
      .toMatchObject({ status: 200, body: { state: 'updated' } })
    // The settings field itself moved, which is what survives a restart.
    expect(FakeSettingsService.current?.valueOf(WorkBuddy.PROFILE_ENTRY_ID, 'visibilityAccount')).toBe('uid-2:ent-2')

    const after = await get(CN_VARIANT.statusPath)
    const next = after['visibility'] as { account?: string, chosen?: boolean, disabled?: string[] }
    expect(next.account).toBe('uid-2:ent-2')
    expect(next.chosen).toBe(true)
    // The hidden list served is the CHOSEN account's, not the signed-in one's:
    // the card's checkboxes and the DSH picker must read the same bucket.
    expect(next.disabled).toEqual([])
  })

  it('refuses an account that is not in this product\'s pool', async () => {
    const { get, post } = await bootWithTwoAccounts()
    const key = (await get(CN_VARIANT.statusPath))['probeKey'] as string

    // Stored would be a preference nothing could honour: the read path falls
    // back to the primary account, which the user would experience as "the
    // selector does not stick".
    const refused = await post(CN_VARIANT.probePath, { action: 'set-visibility-account', account: 'uid-nope:ent' }, key)
    expect(refused.status).toBe(200)
    expect(refused.body['state']).toBe('failed')
    expect(FakeSettingsService.current?.valueOf(WorkBuddy.PROFILE_ENTRY_ID, 'visibilityAccount')).toBe('')

    // The other product's pool is a separate pool, so its ids are not choices
    // here either — the routes are per variant and the ids do not carry over.
    const still = (await get(CN_VARIANT.statusPath))['visibility'] as { chosen?: boolean }
    expect(still.chosen).toBe(false)
  })

  it('returns to the primary rule when asked with an empty account', async () => {
    const { get, post } = await bootWithTwoAccounts()
    const key = (await get(CN_VARIANT.statusPath))['probeKey'] as string

    expect(await post(CN_VARIANT.probePath, { action: 'set-visibility-account', account: 'uid-2:ent-2' }, key))
      .toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(((await get(CN_VARIANT.statusPath))['visibility'] as { account?: string }).account).toBe('uid-2:ent-2')

    // Empty is meaningful rather than malformed: it is how the card restores the
    // default, and it is the state every earlier build was in.
    expect(await post(CN_VARIANT.probePath, { action: 'set-visibility-account', account: '' }, key))
      .toMatchObject({ status: 200, body: { state: 'updated' } })
    const back = (await get(CN_VARIANT.statusPath))['visibility'] as { account?: string, chosen?: boolean }
    expect(back.account).toBe('uid-1:ent-1')
    expect(back.chosen).toBe(false)
  })

  it('falls back to the primary account when the choice left the pool', async () => {
    const { get, post } = await bootWithTwoAccounts()
    const key = (await get(CN_VARIANT.statusPath))['probeKey'] as string
    expect(await post(CN_VARIANT.probePath, { action: 'set-visibility-account', account: 'uid-2:ent-2' }, key))
      .toMatchObject({ status: 200, body: { state: 'updated' } })

    // The account is removed from the pool while the preference still names it —
    // the state a user reaches by deleting an account they had selected. The
    // filter must NOT keep answering for a departed account: its bucket would
    // hide models on behalf of an account the picker cannot even name.
    await post(CN_VARIANT.accountPath, { action: 'remove', id: 'uid-2:ent-2' }, key)
    const after = await get(CN_VARIANT.statusPath)
    const section = after['visibility'] as {
      account?: string
      chosen?: boolean
      choices?: { id: string }[]
    }
    expect(section.account).toBe('uid-1:ent-1')
    expect(section.chosen).toBe(false)
    expect(section.choices?.map(choice => choice.id)).toEqual(['uid-1:ent-1'])
    // The stale preference is still ON DISK — the read falls back rather than
    // rewriting the user's config, so re-adding the account restores the choice.
    expect(FakeSettingsService.current?.valueOf(WorkBuddy.PROFILE_ENTRY_ID, 'visibilityAccount')).toBe('uid-2:ent-2')
  })
})
