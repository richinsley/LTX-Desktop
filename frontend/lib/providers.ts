/**
 * Renderer-side view of the active backend provider.
 *
 * Two things the renderer genuinely needs: what the provider can do (so a request it will
 * refuse is stopped here, with a message that names the provider), and a way to turn a
 * local input file into something the provider can read.
 */

import type { BackendProvider, ProviderCapabilities } from '../../shared/providers'
import { LOCAL_PROVIDER_ID } from '../../shared/providers'
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

export function isLocalProvider(provider: BackendProvider | null | undefined): boolean {
  return !provider || provider.id === LOCAL_PROVIDER_ID
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
