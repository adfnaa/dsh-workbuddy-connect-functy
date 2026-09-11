/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop apps'
 * sign-in. Registers one provider per product variant — `workbuddy` for the CN
 * app and `workbuddy-ai` for the international one — while streaming, tool
 * calls, compaction, and permissions stay Harness-owned.
 *
 * The two variants are assembled by the same factory and differ only in their
 * {@link WorkBuddyVariant} descriptor: each gets its own credential store,
 * catalog, upstream client, shim, adapter, probe state, and routes. Neither
 * variant's startup, catalog fetch, or credential state can stop the other from
 * registering — a user with only one app installed sees only that group.
 *
 * @module dsh-workbuddy-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore } from './auth.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyAdapter } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyProbeStore, workbuddyProbePath } from './probe-store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'
import { CN_VARIANT, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  fingerprintModel,
  WorkBuddyProbeStore,
  workbuddyProbePath,
  WORKBUDDY_PROBE_FILENAME,
  type WorkBuddyProbeRecord,
  type WorkBuddyProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export {
  AI_VARIANT,
  CN_VARIANT,
  variantFor,
  WORKBUDDY_VARIANTS,
  type WorkBuddyVariant,
} from './variants.ts'
export {
  appUserAgent,
  installedAppVersion,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
  WORKBUDDY_APP_VERSION_FILENAME,
  type AppVersionInfo,
  type WorkBuddyAppVersionSource,
} from './app-version.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  modelWithCurrentPromotion,
  normalizeCredits,
  parseModelCatalog,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyCatalogFetch,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyPromotion,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the configuration cards.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 *
 * Both variants share this one namespace: it addresses a single settings
 * section, and installing a second namespace would create a second config file
 * for the same plugin with no gain.
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy' as SettingsNamespace

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * A startup-only catalog fetch cannot notice a sign-in that happens while DSH
 * is already running, so the model group would not appear until a restart. This
 * poll is a cheap existence/parse read of at most a few local files: it never
 * contacts the network and never runs a reasoning probe.
 */
const CREDENTIAL_POLL_MS = 30_000

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy (CN) desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /** Explicit WorkBuddy AI (international) desktop auth-file path, overriding env and platform defaults. */
  authFileAI?: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  authFileAI: z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)'),
  probeConsent: z.boolean().default(false)
    .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)'),
})

/** One variant's live runtime, assembled by {@link createVariantRuntime}. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  probeStore: WorkBuddyProbeStore
  probeService: WorkBuddyProbeService
  /** The static roster this variant falls back to. */
  fallback: readonly WorkBuddyModelInfo[]
  /** Notify the model directory that this variant's answers changed. */
  invalidate: () => void
  /** Whether the provider registered successfully. */
  registered: boolean
}

/** Read the configured explicit auth-file path for one variant. */
function configuredAuthFile(config: Config, variant: WorkBuddyVariant): string | undefined {
  return variant.id === CN_VARIANT.id ? config.authFile : config.authFileAI
}

/**
 * The static catalog a variant serves before its first successful fetch.
 *
 * Each variant has its own roster: the two endpoints share several model ids
 * but not their billing, context windows, or reasoning sets, so one shared
 * fallback would misdescribe whichever variant it was not captured from.
 */
function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS
}

/** Build one variant's stores and probe state. */
function createVariantRuntime(
  config: Config,
  variant: WorkBuddyVariant,
  current: () => Config,
): VariantRuntime {
  const client = new WorkBuddyUpstreamClient()
  const configured = configuredAuthFile(config, variant)
  const store = new WorkBuddyCredentialStore({
    variant,
    ...configured === undefined ? {} : { desktopPath: configured },
    refresh: credential => client.refreshToken(credential),
  })
  const fallback = fallbackFor(variant)
  const catalog = new WorkBuddyCatalog(fallback)
  const probeStore = new WorkBuddyProbeStore({
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    path: workbuddyProbePath(variant.probeFilename),
  })
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
  })
  return {
    variant,
    store,
    client,
    catalog,
    probeStore,
    probeService,
    fallback,
    invalidate: () => {},
    registered: false,
  }
}

/**
 * Whether a model can be probed by hand: it reasons and the upstream declares
 * no effort set for it.
 *
 * Deliberately *not* filtered by whether a result already exists. Dropping a
 * model once it has been detected made the list shrink with use, so
 * re-detecting one model — after an upstream change, say — meant clearing every
 * other result first. The list stays stable and the card marks which entries
 * already have an answer.
 */
function isProbeCandidate(info: WorkBuddyModelInfo): boolean {
  if (info.reasoning?.supports !== true) return false
  return (info.reasoning.supportedEfforts?.length ?? 0) === 0
}

/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime: VariantRuntime, consent: boolean): WorkBuddyWebProbeSection {
  const models = runtime.catalog.current()
  // Read results through the *same* judgement the adapter uses, rather than
  // straight from the store. A raw record can be stale in ways the adapter
  // already discounts — its catalog row changed, it aged past the TTL, or the
  // upstream has since declared an effort set (which always wins) — and showing
  // one would have the card promise levels the model picker does not offer. A
  // model the upstream dropped leaves the catalog entirely, so it drops out
  // here too.
  const results = models.flatMap(info => {
    const record = runtime.probeService.recordFor(info.id)
    if (record === undefined) return []
    return [{
      id: info.id,
      name: info.name,
      validation: record.validation,
      efforts: record.efforts,
      probedAt: record.probedAtMs,
    }]
  })
  return {
    consent,
    running: runtime.probeService.isRunning(),
    candidates: models.filter(isProbeCandidate).map(info => info.id),
    // Newest first: a detection the user just ran belongs at the top, not
    // appended below every earlier one.
    results: newestFirst(results),
  }
}

/**
 * Start one variant: its loopback endpoint, provider registration, and
 * configuration-card wiring.
 *
 * Registration waits for the shim to hold a port, because the provider's
 * models read the shim origin at construction time. A failure here is
 * contained to this variant: the caller logs it and the other keeps working.
 *
 * @returns whether the provider registered.
 */
async function startVariant(ctx: Context, runtime: VariantRuntime): Promise<boolean> {
  const { variant, store, client, catalog, probeService } = runtime
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })
  try {
    await shim.ready
  } catch (error: unknown) {
    ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} loopback endpoint failed to start`, error)
    return false
  }

  let invalidate: (() => void) | undefined
  try {
    // Constructed only once the listener holds a port: the provider's models
    // read the shim origin at construction time.
    const workbuddy = createWorkBuddyAdapter({
      providerId: variant.id,
      displayName: variant.displayName,
      shim,
      store,
      catalog,
      resolveAttachments: () => ctx.get('attachments'),
      observe: modelId => probeService.recordFor(modelId),
    })
    invalidate = workbuddy.invalidate
    runtime.invalidate = () => {
      workbuddy.invalidate()
      ctx.emit('llm/adapters-updated')
    }

    let releaseAdapter: (() => void) | undefined
    let releaseDirectory: (() => void) | undefined
    try {
      releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter)
      releaseDirectory = ctx.llm.registerConfigurableProviders([{
        provider: variant.id,
        displayName: variant.displayName,
        settingsNs: WORKBUDDY_SETTINGS_NS,
        settingsPath: [],
        declared: false,
      }])
    } finally {
      if (releaseAdapter === undefined || releaseDirectory === undefined) {
        // Registration threw; release whichever half landed.
        releaseAdapter?.()
        releaseDirectory?.()
      }
    }
    try {
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseDirectory?.()
        void shim.close()
      })
    } catch {
      // The plugin was disposed during registration; release immediately — the
      // plugin-level disposer already closed every shim.
      releaseAdapter?.()
      releaseDirectory?.()
      void shim.close()
    }
    runtime.registered = true
    return true
  } catch (error: unknown) {
    ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} provider registration failed`, error)
    void shim.close()
    return false
  }
}

/**
 * Start both variants: their loopback endpoints, the `workbuddy` and
 * `workbuddy-ai` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  // Live configuration source: starts as the applied config and is replaced by
  // the settings section's source once one is installed, so edits reach the
  // probe consent gate without a restart.
  let current = (): Config => config

  /** Timers and in-flight work belonging to this plugin instance. */
  let stopped = false
  const timers: NodeJS.Timeout[] = []
  /**
   * The account identity each variant last published a catalog for. Keeps a
   * same-identity token rotation from re-fetching, and lets a late response
   * from a previous identity be discarded instead of overwriting a newer one.
   */
  const lastIdentities = new Map<string, string>()

  const runtimes = WORKBUDDY_VARIANTS.map(variant => createVariantRuntime(config, variant, () => current()))

  // Same-origin routes backing each Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        client: runtime.client,
        models: () => runtime.catalog.current(),
        probe: () => probeSection(runtime, current().probeConsent === true),
        probeKey,
      })
      registerWorkBuddyProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: async modelId => {
          // The authenticated manual endpoint is called only after per-model confirmation.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => { runtime.probeStore.clear(); runtime.invalidate() },
      }, probeKey)
    }
  })

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth-file paths live across edits.
  //
  // DSH 0.1.2 moved the helper from a free function (`installSettingsSection`)
  // onto the provider service (`settings.installSection`), so the wiring now has
  // to wait for a settings service to exist — exactly what the inject below
  // does. Without one the plugin still serves its models; it simply has no
  // user-editable section, as before.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        const next = current()
        for (const runtime of runtimes) {
          runtime.store.setDesktopPath(configuredAuthFile(next, runtime.variant))
        }
      },
    })
  })

  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    void clearHostHeartbeat()
  })

  /**
   * Reconcile one variant with its credentials.
   *
   * Four transitions matter, and each is a different action:
   *
   * - **none → some** (first sighting): reveal the group and fetch a catalog.
   * - **none → some, identity changed**: additionally drop the previous
   *   account's observations, so another user's probe answers cannot be read as
   *   the new account's.
   * - **some → none**: hide the group and stop serving its models.
   * - **same identity**: nothing to do — the store refreshes tokens on demand,
   *   and re-fetching on every rotation would hit the catalog endpoint for no
   *   new information.
   */
  const syncVariant = async (runtime: VariantRuntime): Promise<void> => {
    if (stopped || !runtime.registered) return
    const credential = await runtime.store.current().catch((error: unknown) => {
      // A region mismatch or an unreadable file is reported, not swallowed as
      // "signed out": the user needs to know which file to fix.
      ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} credential read failed`, error)
      return undefined
    })
    if (stopped) return

    const id = runtime.variant.id
    if (credential === undefined) {
      lastIdentities.delete(id)
      if (runtime.catalog.setVisible(false)) runtime.invalidate()
      return
    }

    const identity = `${credential.uid}:${credential.enterpriseId ?? ''}`
    const known = lastIdentities.get(id)
    if (known === identity && runtime.catalog.isVisible()) return

    const switched = known !== undefined && known !== identity
    lastIdentities.set(id, identity)
    if (switched) {
      // Observations are per account: the same model id can answer differently
      // under a different subscription, so a switch invalidates them.
      runtime.probeStore.clear()
    }
    // Serve a fallback roster from the moment the group becomes visible, rather
    // than the previous identity's models, so nothing stale is pickable while
    // the fetch is in flight.
    runtime.catalog.set(runtime.fallback)
    runtime.catalog.setVisible(true)
    runtime.invalidate()

    try {
      const models = await runtime.client.fetchModels(credential)
      if (stopped || lastIdentities.get(id) !== identity) return
      runtime.catalog.set([...models])
      runtime.invalidate()
    } catch (error: unknown) {
      ctx.logger.warn(
        `dsh-workbuddy-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`,
        error,
      )
    }
  }

  /** Run one reconcile sweep across both variants. */
  const syncAll = async (): Promise<void> => {
    for (const runtime of runtimes) await syncVariant(runtime)
  }

  void Promise.all(runtimes.map(async runtime => startVariant(ctx, runtime))).then(() => {
    if (stopped) return
    // The host bundle is live: write a heartbeat so the status CLI can report
    // host health without a browser. Cleared on disposal; a stale heartbeat
    // after a crash is detected by PID in the reader. Written when at least one
    // variant registered, since that is what "the host bundle serves models"
    // means for this plugin.
    if (runtimes.some(runtime => runtime.registered)) void writeHostHeartbeat()

    void syncAll()
    const timer = setInterval(() => { void syncAll() }, CREDENTIAL_POLL_MS)
    timer.unref?.()
    timers.push(timer)
  })
}
