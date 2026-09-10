/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop
 * app's sign-in. Registers the `workbuddy` provider; streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 * @module dsh-workbuddy-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore } from './auth.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyProbeStore } from './probe-store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.ts'
export {
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
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
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
  normalizeCredits,
  prepareChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
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
 * Settings namespace owning the configuration card.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const WORKBUDDY_SETTINGS_NS = 'workbuddy' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  probeConsent: z.boolean().default(false)
    .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)'),
})

/**
 * Start the loopback endpoint, register the `workbuddy` provider, and
 * refresh the model catalog from the upstream once credentials allow it.
 * The static fallback catalog serves from the first moment, so an offline
 * upstream never leaves the provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
  })
  const catalog = new WorkBuddyCatalog()
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })

  // Live configuration source: starts as the applied config and is replaced by
  // the settings section's source once one is installed, so edits reach the
  // probe consent gate without a restart.
  let current = () => config

  // Probe state and the serial runner. Nothing here performs a request by
  // itself: `consent()` is consulted before every sweep, and the config default
  // is off, so an install that never opts in behaves exactly as before.
  const probeStore = new WorkBuddyProbeStore({ pluginVersion: WORKBUDDY_CONNECT_VERSION })
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
  })

  /**
   * Whether a model can be probed by hand: it reasons and the upstream declares
   * no effort set for it.
   *
   * Deliberately *not* filtered by whether a result already exists. Dropping a
   * model once it has been detected made the list shrink with use, so
   * re-detecting one model — after an upstream change, say — meant clearing
   * every other result first. The list stays stable and the card marks which
   * entries already have an answer.
   */
  const isProbeCandidate = (info: WorkBuddyModelInfo): boolean => {
    if (info.reasoning?.supports !== true) return false
    return (info.reasoning.supportedEfforts?.length ?? 0) === 0
  }

  /** Compact probe state for the card: consent, candidates, observations. */
  const probeSection = (): WorkBuddyWebProbeSection => {
    const config = current()
    const models = catalog.current()
    // Read results through the *same* judgement the adapter uses, rather than
    // straight from the store. A raw record can be stale in ways the adapter
    // already discounts — its catalog row changed, it aged past the TTL, or the
    // upstream has since declared an effort set (which always wins) — and
    // showing one would have the card promise levels the model picker does not
    // offer. A model the upstream dropped leaves the catalog entirely, so it
    // drops out here too.
    const results = models.flatMap(info => {
      const record = probeService.recordFor(info.id)
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
      consent: config.probeConsent === true,
      running: probeService.isRunning(),
      candidates: models.filter(isProbeCandidate).map(info => info.id),
      // Newest first: a detection the user just ran belongs at the top, not
      // appended below every earlier one.
      results: newestFirst(results),
    }
  }

  // Same-origin routes backing the Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const probeKey = createProbeKey()
  let refreshProbeModels = () => {}
  ctx.inject(['webServer'], webCtx => {
    registerWorkBuddyStatusRoute(webCtx, {
      store,
      client,
      models: () => catalog.current(),
      probe: () => probeSection(),
      probeKey,
    })
    registerWorkBuddyProbeRoute(webCtx, {
      probe: async modelId => {
        // The authenticated manual endpoint is called only after per-model confirmation.
        const result = await probeService.probe(modelId, true)
        if (result.state === 'ok') refreshProbeModels()
        return result
      },
      clear: () => { probeStore.clear(); refreshProbeModels() },
    }, probeKey)
  })

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth-file path live across edits.
  //
  // DSH 0.1.2 moved the helper from a free function (`installSettingsSection`)
  // onto the provider service (`settings.installSection`), so the wiring now
  // has to wait for a settings service to exist — exactly what the inject
  // below does. Without one the plugin still serves its models; it simply has
  // no user-editable section, as before.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        const next = current().authFile
        store.setDesktopPath(next)
      },
    })
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready
    .then(() => {
      if (stopped) return

      let invalidate: (() => void) | undefined
      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const workbuddy = createWorkBuddyAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
          observe: modelId => probeService.recordFor(modelId),
        })
        invalidate = workbuddy.invalidate
        refreshProbeModels = () => {
          if (stopped) return
          workbuddy.invalidate()
          ctx.emit('llm/adapters-updated')
        }

        let releaseAdapter: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], workbuddy.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY_PROVIDER,
            displayName: 'WorkBuddy',
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
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          releaseAdapter?.()
          releaseDirectory?.()
        }

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser. Cleared on disposal; a stale
        // heartbeat after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddy-connect: provider registration failed', error)
        return
      }

      void (async () => {
        try {
          const credential = await store.current()
          if (credential === undefined || stopped) return
          const models = await client.fetchModels(credential)
          if (stopped) return
          catalog.set([...models])
          invalidate?.()
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-workbuddy-connect: dynamic model catalog unavailable; serving the static fallback list',
            error,
          )
        }
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-workbuddy-connect: loopback endpoint failed to start; provider not registered', error)
    })
}
