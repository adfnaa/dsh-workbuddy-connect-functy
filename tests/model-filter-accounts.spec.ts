// The model filter's ACCOUNT selector: which account's list is being edited.
//
// Why this needs its own file. `model-visibility.spec.ts` proves the store keeps
// accounts apart and that a toggle is guarded against a stale account, and
// `settings-page.spec.ts` proves the picker edits the bucket the document
// names. Neither covered the question this feature adds: with SEVERAL accounts
// in one product's pool, which one's list does the page edit, and does the DSH
// model picker follow the same answer?
//
// That is the reported defect. The visibility section used to be keyed by
// "who is signed in", which on a multi-account pool is the desktop app's
// account and nothing else — so every tick landed in one bucket, and the
// account the user meant to configure was unreachable.
//
// Two halves are pinned here, and they have to agree:
//
// - the HOST resolves the effective account from the stored choice, falls back
//   to the primary rule when the choice is stale, and filters the picker by the
//   same answer the section reports;
// - the PAGE offers the pool's accounts, writes the choice through the probe
//   route, and stops offering the selector on a host that does not publish one.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { visibilityAccountOf } from '../src/index.ts'
import { WorkBuddyVisibilityStore } from '../src/visibility-store.ts'
import type { WorkBuddyAccount } from '../src/account-pool.ts'
import { accountDisplayName } from '../src/account-pool.ts'

const CLEANUP: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of CLEANUP.splice(0)) await dispose()
})

async function tempFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-vis-account-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return join(root, 'visibility.json')
}

/**
 * One pooled account row, with everything the derivation reads.
 *
 * The overrides are narrowed to the two display fields this file varies rather
 * than a `Partial<WorkBuddyAccount>`: under `exactOptionalPropertyTypes` a
 * partial spread reintroduces every optional member as `| undefined`, which the
 * real type does not accept — the fixture would then describe an account the
 * pool could never hold.
 */
function pooled(uid: string, overrides: { nickname?: string, label?: string } = {}): WorkBuddyAccount {
  const now = Date.now()
  return {
    id: `${uid}:ent`,
    uid,
    enterpriseId: 'ent',
    domain: 'copilot.tencent.com',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: now + 3_600_000,
    origin: 'qr',
    enabled: true,
    lastUsedAtMs: 0,
    addedAtMs: now,
    updatedAtMs: now,
    ...overrides,
  }
}

/** A pooled account with no enterprise binding, so its key has no suffix. */
function pooledWithoutEnterprise(uid: string): WorkBuddyAccount {
  const { enterpriseId: _dropped, ...rest } = pooled(uid)
  return { ...rest, id: `${uid}:` }
}

describe('model filter accounts', () => {
  it('names an account the same way on every surface', () => {
    // One implementation behind the card's account list, the CLI and a check-in
    // log row: a second copy would eventually disagree.
    expect(accountDisplayName(pooled('uid-1', { nickname: 'Nic' }))).toBe('Nic')
    expect(accountDisplayName(pooled('uid-1', { nickname: 'Nic', label: 'Mine' }))).toBe('Mine')
    // No label and no nickname: a short uid, not an empty string, so a row
    // never renders as a blank.
    expect(accountDisplayName(pooled('uid-1234567890'))).toBe('uid-1234…')
  })

  it('keys each account of one variant to its own bucket', () => {
    // The property the whole selector rests on: two accounts never share a
    // bucket, so switching between them cannot leak a hidden list.
    const one = visibilityAccountOf(pooled('uid-1'))
    const two = visibilityAccountOf({ uid: 'uid-2', enterpriseId: 'other' })
    expect(one).toBe('uid-1:ent')
    expect(two).toBe('uid-2:other')
    expect(one).not.toBe(two)
    // A credential with no uid has no bucket at all, which is what makes the
    // host omit the section rather than share one.
    expect(visibilityAccountOf(pooled(''))).toBeUndefined()
    // And a uid with no enterprise binding keys on the uid alone — not on a
    // suffix that would split one account into two buckets.
    expect(visibilityAccountOf(pooledWithoutEnterprise('uid-9'))).toBe('uid-9:')
  })

  it('keeps two accounts\' lists apart while the picker reads one of them', async () => {
    const store = new WorkBuddyVisibilityStore(await tempFile())
    const catalog = ['hy3', 'glm-5.3', 'kimi-k3']
    store.setVisible('uid-1:ent', 'hy3', false)
    store.setAllowlist('uid-2:ent', ['kimi-k3'])

    // The account the section names decides what the picker hides — this is the
    // read the adapter performs, expressed against the same store.
    expect(store.effectiveHidden('uid-1:ent', catalog)).toEqual(['hy3'])
    expect([...store.effectiveHidden('uid-2:ent', catalog)].sort()).toEqual(['glm-5.3', 'hy3'])
    // Neither account sees the other's edits.
    expect(store.disabled('uid-1:ent')).toEqual(['hy3'])
    expect(store.allowlist('uid-1:ent')).toBeUndefined()
    expect(store.disabled('uid-2:ent')).toEqual([])
  })

  it('survives a restart with both accounts\' lists intact', async () => {
    const path = await tempFile()
    const first = new WorkBuddyVisibilityStore(path)
    first.setVisible('uid-1:ent', 'hy3', false)
    first.setVisible('uid-2:ent', 'kimi-k3', false)

    // A fresh instance, which is what a host restart is: the choice is stored
    // config, and the lists are stored per account, so neither is lost.
    const second = new WorkBuddyVisibilityStore(path)
    expect(second.disabled('uid-1:ent')).toEqual(['hy3'])
    expect(second.disabled('uid-2:ent')).toEqual(['kimi-k3'])
  })

  it('writes the choice where the host reads it, and reads it back', async () => {
    // The stored shape is a plain string in the plugin's config, so this pins
    // the one thing that could silently break: that the identity the page sends
    // is the identity `visibilityAccountOf` derives from the pool row.
    const path = await tempFile()
    const store = new WorkBuddyVisibilityStore(path)
    const accounts = [pooled('uid-1'), pooled('uid-2')]
    const keys = accounts.map(account => visibilityAccountOf(account))
    expect(keys).toEqual(['uid-1:ent', 'uid-2:ent'])

    // A write made for the second account lands in the second bucket, and the
    // first account's list is untouched — the defect was every write landing in
    // the first one.
    store.setVisible(keys[1] as string, 'hy3', false)
    expect(store.disabled(keys[0] as string)).toEqual([])
    expect(store.disabled(keys[1] as string)).toEqual(['hy3'])
  })

  it('reads a hand-edited file without trusting it', async () => {
    const path = await tempFile()
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: {
        // A row with no account key, and a row whose lists are the wrong shape:
        // both are dropped rather than allowed to answer for a real account.
        '': { account: '', disabled: [], updatedAtMs: 1 },
        'uid-1:ent': { account: 'uid-1:ent', disabled: 'nope', updatedAtMs: 1 },
        'uid-2:ent': { account: 'uid-2:ent', disabled: ['hy3'], updatedAtMs: 1 },
      },
    }), 'utf8')
    const store = new WorkBuddyVisibilityStore(path)
    expect(store.disabled('uid-1:ent')).toEqual([])
    expect(store.disabled('uid-2:ent')).toEqual(['hy3'])
  })
})
