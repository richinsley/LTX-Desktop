/**
 * IPC for backend provider selection, capability probing and input staging.
 *
 * The renderer never learns a provider's transport details — it asks for capabilities and
 * gets an answer, and hands over local input paths and gets back whatever the provider
 * should be told. Everything URL- and token-shaped stays in the main process.
 */

import { LOCAL_PROVIDER_ID, type BackendProvider, type ProviderCapabilities } from '../../shared/providers'
import { logger } from '../logger'
import { probeProvider } from '../providers/capabilities'
import {
  getActiveProvider,
  getActiveProviderId,
  getProvider,
  listProviders,
  removeProvider,
  setActiveProvider,
  upsertProvider,
} from '../providers/config'
import { clearArtifactCache, stageInputFile } from '../providers/artifacts'
import { getAuthToken, getBackendUrl, startPythonBackend, stopPythonBackend } from '../python-backend'
import { getMainWindow } from '../window'
import { handle } from './typed-handle'

/**
 * Where to send a probe. The local provider has no configured URL — it is wherever the
 * process we spawned ended up listening, which only the running backend knows.
 */
function probeTargetFor(provider: BackendProvider): { baseUrl: string; authToken?: string } {
  if (provider.kind === 'managed-local') {
    return { baseUrl: getBackendUrl() ?? '', authToken: getAuthToken() ?? undefined }
  }
  return { baseUrl: provider.baseUrl ?? '', authToken: provider.authToken }
}

async function probe(provider: BackendProvider): Promise<ProviderCapabilities> {
  const { baseUrl, authToken } = probeTargetFor(provider)
  return probeProvider({
    providerId: provider.id,
    baseUrl,
    authToken,
    artifactTransport: provider.artifactTransport,
  })
}

export function registerProviderHandlers(): void {
  handle('listBackendProviders', () => ({
    activeProviderId: getActiveProviderId(),
    providers: listProviders(),
  }))

  handle('setActiveBackendProvider', async ({ id }) => {
    try {
      const changed = setActiveProvider(id)
      if (changed) {
        // Switching away from the bundled backend must actually stop it — otherwise it goes
        // on holding VRAM for a machine that is no longer doing the work.
        if (id !== LOCAL_PROVIDER_ID) stopPythonBackend()
        await startPythonBackend()
      }
      return { success: true as const, activeProviderId: getActiveProviderId() }
    } catch (error) {
      logger.error(`Failed to activate provider ${id}: ${error}`)
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('upsertBackendProvider', (input) => {
    try {
      const provider = upsertProvider(input)
      // CSP arrives as a header on the document response, so a newly allowed origin only
      // takes effect on the next load. Without this the provider saves, looks correct, and
      // then every request to it is blocked by connect-src with no visible cause.
      // Reloading here is cheap: adding a backend is deliberate and rare, and the screens
      // it happens from (Settings, the backend-failed page) hold no unsaved work.
      const window = getMainWindow()
      if (window) setImmediate(() => window.webContents.reload())
      return { success: true as const, provider }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('removeBackendProvider', async ({ id }) => {
    try {
      const wasActive = getActiveProviderId() === id
      removeProvider(id)
      clearArtifactCache(id)
      // Removing the active provider drops the app back to local, which has to be started.
      if (wasActive) await startPythonBackend()
      return { success: true as const }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('getBackendProviderCapabilities', async ({ id }) => {
    const provider = id ? getProvider(id) : getActiveProvider()
    if (!provider) {
      return {
        providerId: id ?? '',
        reachable: false,
        source: 'declared' as const,
        error: `Unknown provider: ${id}`,
        videoModels: [],
        features: {
          textToVideo: false, imageToVideo: false, audioToVideo: false, extend: false,
          retake: false, icLora: false, imageGeneration: false, artifactTransfer: false,
        },
        artifactTransport: 'local-path' as const,
      }
    }
    return probe(provider)
  })

  handle('testBackendProvider', (draft) => probe(draft))

  handle('stageProviderInput', async ({ path }) => {
    try {
      return { success: true as const, path: await stageInputFile(getActiveProvider(), path) }
    } catch (error) {
      logger.error(`Failed to stage input for provider: ${error}`)
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
