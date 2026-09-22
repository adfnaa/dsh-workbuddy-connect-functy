import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.ts'
import { sealAuthFieldForTest } from '../src/desktop-credential-protection.ts'
import { deriveProtectorKey } from '../src/desktop-credential-protection.ts'

/**
 * Doctor's desktop-auth-file report: the on-disk format rides the output so a
 * WorkBuddy 5.6 user (encrypted file) sees the real state, and an unlock
 * failure names its actual cause instead of the generic "sign in again" hint.
 * The key helper is pointed at a nonexistent binary via env, so the failure
 * path is exercised without spawning anything real.
 */

const SECRET = Buffer.alloc(32, 7).toString('base64')
const KEY = deriveProtectorKey(SECRET)

function plaintextDocument(): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
    account: { uid: 'uid-1', nickname: 'nick' },
  })
}

function encryptedDocument(): string {
  return JSON.stringify({
    auth: {
      accessToken: sealAuthFieldForTest(KEY, 'test-access'),
      refreshToken: sealAuthFieldForTest(KEY, 'test-refresh'),
      expiresAt: Date.now() + 3_600_000,
      domain: 'copilot.tencent.com',
    },
    account: { uid: 'uid-1', nickname: 'nick' },
  })
}

async function captureDoctor(args: string[]): Promise<{ code: number, json: Record<string, unknown>, text: string }> {
  const writes: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await run(args)
    const output = writes.join('')
    return {
      code,
      json: output.trim().startsWith('{') ? JSON.parse(output) as Record<string, unknown> : {},
      text: output,
    }
  } finally {
    spy.mockRestore()
  }
}

describe('doctor desktop auth format', () => {
  let root: string

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined as unknown as string
    vi.unstubAllEnvs()
  })

  it('reports plaintext for a 5.5-shaped file and signs in', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-doctor-plain-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'workbuddy-desktop.info'))
    await writeFile(join(root, 'workbuddy-desktop.info'), plaintextDocument())
    const { code, json } = await captureDoctor(['doctor', '--json'])
    expect(code).toBe(0)
    const file = json['desktopAuthFile'] as Record<string, unknown>
    expect(file['format']).toBe('plaintext')
    expect(json['signIn']).toBe('signed-in')
  })

  it('reports encrypted for a 5.6-shaped file, and an unlock failure with its real cause', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-doctor-encrypted-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'workbuddy-desktop.info'))
    // The key helper would be needed to open this file; point it nowhere.
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', join(root, 'absent-electron'))
    await writeFile(join(root, 'workbuddy-desktop.info'), encryptedDocument())
    const { code, json } = await captureDoctor(['doctor', '--json'])
    const file = json['desktopAuthFile'] as Record<string, unknown>
    expect(file['format']).toBe('encrypted')
    expect(json['signIn']).toBe('signed-out')
    // The real reason, not "sign in again": the unlock failure is spelled out
    // and the generic re-login hint is suppressed.
    const decryptionNote = String(json['decryptionNote'])
    expect(decryptionNote).toContain('Encrypted desktop credential could not be used')
    expect(decryptionNote).toContain('absent-electron')
    const hints = json['hints'] as string[]
    expect(hints[0]).toBe(decryptionNote)
    expect(hints).toHaveLength(2)
    // Not a healthy state: exit non-zero.
    expect(code).toBe(1)
    // The human-readable report names the format on the file line.
    const { text } = await captureDoctor(['doctor'])
    expect(text).toContain('present — encrypted')
  })

  it('reports absent when no file exists and unrecognized for an unparsable one', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-doctor-absent-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent.info'))
    const absent = await captureDoctor(['doctor', '--json'])
    expect((absent.json['desktopAuthFile'] as Record<string, unknown>)['format']).toBe('absent')

    const brokenPath = join(root, 'broken.info')
    await writeFile(brokenPath, 'definitely not json')
    vi.stubEnv('WORKBUDDY_AUTH_FILE', brokenPath)
    const broken = await captureDoctor(['doctor', '--json'])
    expect((broken.json['desktopAuthFile'] as Record<string, unknown>)['format']).toBe('unrecognized')
  })
})
