/**
 * Provider configuration: which backends exist, and which one is active.
 *
 * Persisted to `<userData>/backend-providers.json`. Absent file → the built-in local
 * provider is the only one and it is active, which is exactly upstream behaviour; nothing
 * about the default path reads this file's contents.
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import {
  LOCAL_PROVIDER,
  LOCAL_PROVIDER_ID,
  normalizeBaseUrl,
  type ArtifactTransport,
  type BackendProvider,
} from '../../shared/providers'
import { logger } from '../logger'

interface ProvidersFile {
  version: 1
  activeProviderId: string
  /** Only user-defined providers are stored; the local one is implicit. */
  providers: BackendProvider[]
}

const CONFIG_FILENAME = 'backend-providers.json'

let cache: ProvidersFile | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILENAME)
}

function emptyConfig(): ProvidersFile {
  return { version: 1, activeProviderId: LOCAL_PROVIDER_ID, providers: [] }
}

function isArtifactTransport(value: unknown): value is ArtifactTransport {
  return value === 'local-path' || value === 'http-download' || value === 'mapped-path'
}

/**
 * Accept only entries we fully understand. A malformed provider is dropped rather than
 * repaired: a half-parsed remote URL is how a generation quietly goes to the wrong box.
 */
function parseProvider(value: unknown): BackendProvider | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const baseUrl = typeof record.baseUrl === 'string' ? normalizeBaseUrl(record.baseUrl) : ''
  if (!id || id === LOCAL_PROVIDER_ID || !name || !baseUrl) return null
  if (record.kind !== 'remote-http') return null

  const transport = isArtifactTransport(record.artifactTransport)
    ? record.artifactTransport
    : 'http-download'

  const provider: BackendProvider = {
    id,
    name,
    kind: 'remote-http',
    baseUrl,
    artifactTransport: transport,
  }

  if (typeof record.authToken === 'string' && record.authToken) {
    provider.authToken = record.authToken
  }

  const pathMap = record.pathMap
  if (transport === 'mapped-path') {
    if (!pathMap || typeof pathMap !== 'object') return null
    const { remoteRoot, localRoot } = pathMap as Record<string, unknown>
    if (typeof remoteRoot !== 'string' || typeof localRoot !== 'string' || !remoteRoot || !localRoot) {
      return null
    }
    provider.pathMap = { remoteRoot, localRoot }
  }

  return provider
}

function load(): ProvidersFile {
  if (cache) return cache

  const file = configPath()
  if (!fs.existsSync(file)) {
    cache = emptyConfig()
    return cache
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    const providers = Array.isArray(parsed.providers)
      ? parsed.providers.map(parseProvider).filter((p): p is BackendProvider => p !== null)
      : []
    const requestedActive = typeof parsed.activeProviderId === 'string' ? parsed.activeProviderId : LOCAL_PROVIDER_ID
    // A dangling active id (provider deleted by hand, or dropped by parseProvider above)
    // must fall back to local rather than leave the app with no backend at all.
    const activeProviderId = requestedActive === LOCAL_PROVIDER_ID || providers.some((p) => p.id === requestedActive)
      ? requestedActive
      : LOCAL_PROVIDER_ID
    cache = { version: 1, activeProviderId, providers }
  } catch (error) {
    logger.error(`Failed to read ${CONFIG_FILENAME}, falling back to the local backend: ${error}`)
    cache = emptyConfig()
  }

  return cache
}

function save(config: ProvidersFile): void {
  cache = config
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    logger.error(`Failed to persist ${CONFIG_FILENAME}: ${error}`)
  }
}

/** Every provider, built-in first. */
export function listProviders(): BackendProvider[] {
  return [LOCAL_PROVIDER, ...load().providers]
}

export function getActiveProviderId(): string {
  return load().activeProviderId
}

export function getActiveProvider(): BackendProvider {
  const config = load()
  if (config.activeProviderId === LOCAL_PROVIDER_ID) return LOCAL_PROVIDER
  return config.providers.find((p) => p.id === config.activeProviderId) ?? LOCAL_PROVIDER
}

export function getProvider(id: string): BackendProvider | null {
  if (id === LOCAL_PROVIDER_ID) return LOCAL_PROVIDER
  return load().providers.find((p) => p.id === id) ?? null
}

/** Returns true when the active provider actually changed. */
export function setActiveProvider(id: string): boolean {
  const config = load()
  if (config.activeProviderId === id) return false
  if (id !== LOCAL_PROVIDER_ID && !config.providers.some((p) => p.id === id)) {
    throw new Error(`Unknown provider: ${id}`)
  }
  save({ ...config, activeProviderId: id })
  return true
}

/** Create or replace a user-defined provider. The built-in local provider is immutable. */
export function upsertProvider(input: BackendProvider): BackendProvider {
  if (input.id === LOCAL_PROVIDER_ID) {
    throw new Error('The built-in local provider cannot be modified')
  }
  const provider = parseProvider(input)
  if (!provider) {
    throw new Error('Provider needs an id, a name and a base URL (and a path map when using mapped-path)')
  }

  const config = load()
  const providers = config.providers.filter((p) => p.id !== provider.id)
  providers.push(provider)
  save({ ...config, providers })
  return provider
}

export function removeProvider(id: string): void {
  if (id === LOCAL_PROVIDER_ID) {
    throw new Error('The built-in local provider cannot be removed')
  }
  const config = load()
  const providers = config.providers.filter((p) => p.id !== id)
  const activeProviderId = config.activeProviderId === id ? LOCAL_PROVIDER_ID : config.activeProviderId
  save({ ...config, providers, activeProviderId })
}

/** Test seam — drops the in-memory copy so the next read hits disk. */
export function resetProviderConfigCache(): void {
  cache = null
}
