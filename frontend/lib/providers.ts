/**
 * Renderer-side view of the active backend provider.
 *
 * Two things the renderer genuinely needs: what the provider can do (so a request it will
 * refuse is stopped here, with a message that names the provider), and a way to turn a
 * local input file into something the provider can read.
 */

import type { BackendProvider, ImportingFeature, ProviderCapabilities } from '../../shared/providers'
import { checkFeature, LOCAL_PROVIDER_ID } from '../../shared/providers'
import { resetBackendCredentials } from './backend'
import { logger } from './logger'

export type { BackendProvider, ProviderCapabilities }

export async function listBackendProviders(): Promise<{ activeProviderId: string; providers: BackendProvider[] }> {
  return window.electronAPI.listBackendProviders()
}

export async function activateBackendProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const result = await window.electronAPI.setActiveBackendProvider({ id })
  if (!result.success) return { ok: false, error: result.error }
  // The URL and token behind backendFetch just changed; the cached pair is now wrong.
  resetBackendCredentials()
  return { ok: true }
}

export async function fetchProviderCapabilities(id?: string): Promise<ProviderCapabilities> {
  return window.electronAPI.getBackendProviderCapabilities(id ? { id } : {})
}

export async function testProviderDraft(draft: BackendProvider): Promise<ProviderCapabilities> {
  return window.electronAPI.testBackendProvider(draft)
}

/**
 * Make a local conditioning file reachable by the active provider and return the path to
 * send. Identity for the local provider, so call sites can do this unconditionally.
 *
 * Throws on failure: silently sending the un-staged local path would have the provider
 * either fail confusingly or, worse, read an unrelated file that happens to sit at the same
 * path on its own disk.
 */
export async function stageProviderInput(localPath: string): Promise<string> {
  const result = await window.electronAPI.stageProviderInput({ path: localPath })
  if (!result.success) throw new Error(result.error)
  if (result.path !== localPath) logger.info(`Staged input to provider as ${result.path}`)
  return result.path
}

/** `stageProviderInput` for a path that may not be set. */
export async function stageOptionalInput(localPath: string | undefined): Promise<string | undefined> {
  if (!localPath) return localPath
  return stageProviderInput(localPath)
}

/**
 * Everything a feature needs before it spends GPU: confirm the provider can run it and can
 * hand the result back, then put its local input files where the provider can read them.
 *
 * Inputs are keyed rather than positional so the staged result carries each field's own
 * type — a required path stays `string`, an optional one stays `string | undefined` — and
 * so adding an input can't silently shift what a call site destructures.
 *
 * Staging failures come back through the same error channel as a capability rejection: a
 * half-staged request isn't worth sending, and the caller already has somewhere to show it.
 */
export async function preflightFeature<T extends Record<string, string | undefined>>(
  feature: ImportingFeature,
  inputs: T,
): Promise<{ ok: true; staged: T } | { ok: false; error: string }> {
  const capabilities = await fetchProviderCapabilities()
  const rejection = checkFeature(capabilities, feature)
  if (rejection) return { ok: false, error: rejection.message }

  try {
    const staged: Record<string, string | undefined> = {}
    for (const [key, localPath] of Object.entries(inputs)) {
      staged[key] = await stageOptionalInput(localPath)
    }
    return { ok: true, staged: staged as T }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function isLocalProvider(provider: BackendProvider | null | undefined): boolean {
  return !provider || provider.id === LOCAL_PROVIDER_ID
}

/**
 * The active provider, without probing it.
 *
 * `useBackendProvider` also fetches capabilities, which is a round trip to the backend —
 * too much for callers that only need to know whether the backend is this machine.
 */
export async function getActiveBackendProvider(): Promise<BackendProvider | null> {
  const { activeProviderId, providers } = await listBackendProviders()
  return providers.find((p) => p.id === activeProviderId) ?? null
}

/** One line summarising a probe result, for the settings panel. */
export function describeCapabilities(capabilities: ProviderCapabilities): string {
  if (!capabilities.reachable) return capabilities.error ?? 'Unreachable'
  const parts: string[] = []
  if (capabilities.gpuName) parts.push(capabilities.gpuName)
  if (capabilities.vramMb) parts.push(`${Math.round(capabilities.vramMb / 1024)}GB VRAM`)
  if (capabilities.activeModel) parts.push(capabilities.activeModel)
  parts.push(capabilities.source === 'probed'
    ? `${capabilities.videoModels.length} model spec(s) reported`
    : 'no capability report — assuming LTX defaults')
  if (!capabilities.features.artifactTransfer && capabilities.artifactTransport === 'http-download') {
    parts.push('no artifact endpoints (results cannot be imported)')
  }
  return parts.join(' · ')
}
