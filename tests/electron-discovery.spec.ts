import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyAtRestKeyProvider,
  WORKBUDDY_CN_BUNDLE_ID,
  WORKBUDDY_ELECTRON_BIN_ENV,
  deriveProtectorKey,
  reasonCodeOf,
} from '../src/desktop-credential-protection.ts'
import type { WorkBuddyDiscoveryTools } from '../src/desktop-credential-protection.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { CN_VARIANT, AI_VARIANT } from '../src/variants.ts'

/**
 * Issue #48: the macOS Electron binary is no longer assumed to live at
 * `/Applications/WorkBuddy.app`.
 *
 * Every test here drives the discovery flow through injected tools, so no test
 * spawns `mdfind` or `plutil` — and so a test can force the fallback branch
 * without moving the real application. The contracts under test are the ones
 * §3.1–§3.7 of `docs/issue-48-electron-path-plan.md` fix: explicit config is
 * authoritative, discovery runs only after the default path fails, identity is
 * proved before execution, and an unfinished check is never mistaken for an
 * absent app.
 */

const SECRET = Buffer.alloc(32, 9).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

/** A discovery-tool stand-in that records every call. */
function fakeTools(overrides: Partial<WorkBuddyDiscoveryTools> = {}): WorkBuddyDiscoveryTools & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    findApps: async () => [],
    bundleIdentifier: async () => WORKBUDDY_CN_BUNDLE_ID,
    bundleVersion: async () => '5.6.2',
    ...overrides,
  }
}

/** Count how many times a tool was entered, without changing its behaviour. */
function counting<T extends (...args: never[]) => unknown>(fn: T, calls: string[], label: string): T {
  return ((...args: never[]) => {
    calls.push(label)
    return fn(...args)
  }) as T
}

let root: string
const cleanups: (() => Promise<void>)[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-electron-discovery-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

/** Create a real, executable file so `accessSync(X_OK)` succeeds. */
async function executableAt(...segments: string[]): Promise<string> {
  const path = join(root, ...segments)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '#!/bin/sh\n', { mode: 0o755 })
  return path
}

/** A `.app` bundle whose Electron is executable. */
async function fakeApp(name: string): Promise<{ bundlePath: string, electronPath: string }> {
  const bundlePath = join(root, name)
  const electronPath = join(bundlePath, 'Contents', 'MacOS', 'Electron')
  await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(electronPath, '#!/bin/sh\n', { mode: 0o755 })
  return { bundlePath, electronPath }
}

describe('#48 explicit configuration is authoritative', () => {
  it('never falls back when an explicit option points at a missing binary', async () => {
    const tools = fakeTools()
    const provider = new WorkBuddyAtRestKeyProvider({
      // The default path exists and discovery would find an app: neither may
      // be consulted, because the caller named a binary and it is unusable.
      electronPath: '/nonexistent/workbuddy-electron',
      discovery: 'macos-workbuddy',
      defaultElectronPath: await executableAt('default-Electron'),
      tools,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/not available at \/nonexistent/)
    expect(tools.calls).toEqual([])
    expect(reasonCodeOf(new Error('x'))).toBeUndefined()
  })

  it('never falls back when WORKBUDDY_ELECTRON_BIN points at a missing binary', async () => {
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, '/nonexistent/from-env')
    const tools = fakeTools()
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: await executableAt('default-Electron'),
      tools,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/not available at \/nonexistent\/from-env/)
    expect(tools.calls).toEqual([])
  })

  it('classifies an unusable explicit path as electron-path-invalid', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      electronPath: '/nonexistent/workbuddy-electron',
      discovery: 'macos-workbuddy',
      tools: fakeTools(),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-path-invalid')
  })
})

describe('#48 discovery runs only after the default path fails', () => {
  it('does not call the discovery tools when the default path works', async () => {
    const tools = fakeTools()
    const defaultPath = await executableAt('default-Electron')
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: defaultPath,
      tools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await provider.protectorKeyFor([KEY_ID])
    // §3.0 low-intrusion: the ordinary installation pays no subprocess cost.
    expect(tools.calls).toEqual([])
  })

  it('falls back to discovery when the default path is missing', async () => {
    const app = await fakeApp('WorkBuddy.app')
    const calls: string[] = []
    const tools = fakeTools({
      findApps: counting(async () => [app.bundlePath], calls, 'mdfind'),
      bundleIdentifier: counting(async () => WORKBUDDY_CN_BUNDLE_ID, calls, 'plutil-id'),
    })
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(calls).toContain('mdfind')
    expect(calls).toContain('plutil-id')
  })

  it('performs no discovery during construction (§3.0: the constructor is synchronous)', async () => {
    const tools = fakeTools()
    // Constructing must not spawn anything: discovery lives in the async
    // payload path, so a plugin load never pays for it.
    new WorkBuddyAtRestKeyProvider({ discovery: 'macos-workbuddy', tools })
    expect(tools.calls).toEqual([])
  })
})

describe('#48 identity is proved before execution', () => {
  it('rejects a candidate whose bundle id is another product', async () => {
    const app = await fakeApp('NotWorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => [app.bundlePath],
        bundleIdentifier: async () => 'com.example.something-else',
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })

  it('rejects a matching bundle whose Electron is not executable', async () => {
    const bundlePath = join(root, 'WorkBuddy.app')
    // Present but not executable: identity alone is not enough to execute it.
    await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(bundlePath, 'Contents', 'MacOS', 'Electron'), '#!/bin/sh\n', { mode: 0o644 })
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })
})

describe('#48 candidate counting', () => {
  it('uses the only candidate found', async () => {
    const app = await fakeApp('WorkBuddy.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [app.bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
  })

  it('reports not-found when the search completes with no candidate', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [] }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-not-found')
  })

  it('refuses to choose between two distinct apps, and lists them', async () => {
    const first = await fakeApp('WorkBuddy.app')
    const second = await fakeApp('WorkBuddy 2.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [first.bundlePath, second.bundlePath] }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-binary-ambiguous')
    // The user has to know which two, or they cannot act on the message.
    expect((error as Error).message).toContain(first.bundlePath)
    expect((error as Error).message).toContain(second.bundlePath)
  })

  it('collapses path aliases of one app instead of calling it ambiguous', async () => {
    const app = await fakeApp('WorkBuddy.app')
    // Spotlight can list one bundle several times; the same real path twice
    // must not read as two installations.
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => [app.bundlePath, app.bundlePath] }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
  })
})

describe('#48 an unfinished check is not an absent app', () => {
  it('reports incomplete when the search tool cannot run', async () => {
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({ findApps: async () => { throw new Error('mdfind is unavailable') } }),
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-discovery-incomplete')
    // The wording must not claim the app is missing.
    expect((error as Error).message).toMatch(/did not finish|not proof/i)
  })

  it('reports incomplete when one candidate could not be identified', async () => {
    const good = await fakeApp('WorkBuddy.app')
    const unreadable = join(root, 'Broken.app')
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => [good.bundlePath, unreadable],
        // The plutil seam answers `undefined` for "could not read", which is
        // not the same as "this one is a different product".
        bundleIdentifier: async path => path === unreadable ? undefined : WORKBUDDY_CN_BUNDLE_ID,
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // One good candidate exists, but pretending it is the only one would be a
    // guess: the unfinished candidate may be a second copy.
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(error)).toBe('electron-discovery-incomplete')
  })
})

describe('#48 discoverability is a per-variant setting', () => {
  it('never discovers, and never takes the CN default, for a none-discovery provider', async () => {
    const tools = fakeTools({ findApps: async () => { throw new Error('must not be called') } })
    const defaultPath = await executableAt('default-Electron')
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'none',
      defaultElectronPath: defaultPath,
      tools,
    })
    const error = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    // Global is isolated: no CN default, no Spotlight, and the failure says
    // "not configured" rather than "searched and not found".
    expect(reasonCodeOf(error)).toBe('electron-binary-unavailable')
    expect(tools.calls).toEqual([])
    expect(provider.helperPath()).toBeUndefined()
  })

  it('still honours an explicit env path for a none-discovery provider', async () => {
    const binary = await executableAt('user-supplied-Electron')
    vi.stubEnv(WORKBUDDY_ELECTRON_BIN_ENV, binary)
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'none',
      tools: fakeTools({ findApps: async () => { throw new Error('must not be called') } }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    // The env var is a deliberate user choice, so it stays available even
    // where the plugin will not search on its own.
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
  })
})

describe('#48 a failed discovery is retried, a successful one is cached', () => {
  it('re-runs discovery on the next attempt after a failure', async () => {
    let found = false
    const app = await fakeApp('WorkBuddy.app')
    const calls: string[] = []
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => {
          calls.push('findApps')
          return found ? [app.bundlePath] : []
        },
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    const first = await provider.protectorKeyFor([KEY_ID]).catch((caught: unknown) => caught)
    expect(reasonCodeOf(first)).toBe('electron-binary-not-found')
    // The app appears (installed, or moved into an indexed place) without a
    // DSH restart.
    found = true
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(calls.filter(call => call === 'findApps')).toHaveLength(2)
  })

  it('re-checks a cached discovery path and re-discovers when it went away', async () => {
    const app = await fakeApp('WorkBuddy.app')
    let searches = 0
    const provider = new WorkBuddyAtRestKeyProvider({
      discovery: 'macos-workbuddy',
      defaultElectronPath: join(root, 'absent', 'Electron'),
      tools: fakeTools({
        findApps: async () => { searches += 1; return [app.bundlePath] },
      }),
      spawnHelper: async () => PAYLOAD_TEXT,
    })
    await provider.protectorKeyFor([KEY_ID])
    expect(searches).toBe(1)
    // The app is moved away, and an envelope naming a key this process has not
    // resolved forces the helper path again (a cached key would short-circuit
    // before resolution, which is its own, correct, behaviour).
    await rm(join(app.bundlePath, 'Contents', 'MacOS', 'Electron'), { force: true })
    const second = await provider.protectorKeyFor(['0123456789abcdef']).catch((caught: unknown) => caught)
    expect(reasonCodeOf(second)).toBe('electron-binary-not-found')
    expect(searches).toBe(2)
  })
})

describe('#48 discovery failures reach the status document as reasonCode', () => {
  it('carries electron-binary-not-found through store.status()', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath: join(root, 'workbuddy-desktop.info'),
      ownPath: join(root, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
      keyProvider: new WorkBuddyAtRestKeyProvider({
        discovery: 'macos-workbuddy',
        defaultElectronPath: join(root, 'absent', 'Electron'),
        tools: fakeTools({ findApps: async () => [] }),
      }),
    })
    await writeFile(join(root, 'workbuddy-desktop.info'), encryptedEnvelopeFixture())
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reasonCode).toBe('electron-binary-not-found')
  })

  it('carries electron-binary-unavailable for the international variant', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: AI_VARIANT,
      desktopPath: join(root, 'workbuddy-desktop-ai.info'),
      ownPath: join(root, 'own-ai.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
      keyProvider: new WorkBuddyAtRestKeyProvider({ discovery: 'none' }),
    })
    await writeFile(join(root, 'workbuddy-desktop-ai.info'), encryptedEnvelopeFixture())
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    // Not `not-found`: nothing was searched, and claiming otherwise would send
    // the user looking for a problem that does not exist.
    expect(status.reasonCode).toBe('electron-binary-unavailable')
  })

  it('reports no-credential when there is simply no sign-in', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath: join(root, 'missing.info'),
      ownPath: join(root, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    expect(await store.status()).toEqual({ state: 'signed-out', reasonCode: 'no-credential' })
  })
})

/** A minimal 5.6-style encrypted document; the key is never reachable here. */
function encryptedEnvelopeFixture(): string {
  return JSON.stringify({
    auth: {
      accessToken: {
        $wbEncrypted: 1,
        envelope: Buffer.from(JSON.stringify({
          suite: 1,
          keyId: KEY_ID,
          nonce: Buffer.alloc(12, 1).toString('base64'),
          authTag: Buffer.alloc(16, 2).toString('base64'),
          ciphertext: Buffer.alloc(24, 3).toString('base64'),
        }), 'utf8').toString('base64'),
      },
      refreshToken: 'refresh-token-value',
      uid: 'uid-1',
      domain: 'www.workbuddy.cn',
    },
  })
}
