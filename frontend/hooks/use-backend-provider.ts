import { useCallback, useEffect, useState } from 'react'
import type { BackendProvider, ProviderCapabilities } from '../../shared/providers'
import { LOCAL_PROVIDER_ID } from '../../shared/providers'
import { activateBackendProvider, fetchProviderCapabilities, listBackendProviders } from '../lib/providers'
import { logger } from '../lib/logger'

interface UseBackendProviderReturn {
  providers: BackendProvider[]
  activeProviderId: string
  activeProvider: BackendProvider | null
  capabilities: ProviderCapabilities | null
  isProbing: boolean
  refresh: () => Promise<void>
  activate: (id: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Active provider plus its capabilities.
 *
 * The capability probe is deliberately not on the app's startup path: an unreachable remote
 * provider would otherwise cost every mount a timeout. It runs when this hook mounts and on
 * explicit refresh, and callers treat a null result as "not known yet", not "unsupported".
 */
export function useBackendProvider(): UseBackendProviderReturn {
  const [providers, setProviders] = useState<BackendProvider[]>([])
  const [activeProviderId, setActiveProviderId] = useState<string>(LOCAL_PROVIDER_ID)
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null)
  const [isProbing, setIsProbing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const listing = await listBackendProviders()
      setProviders(listing.providers)
      setActiveProviderId(listing.activeProviderId)
      setIsProbing(true)
      setCapabilities(await fetchProviderCapabilities())
    } catch (error) {
      logger.error(`Failed to read backend providers: ${error}`)
    } finally {
      setIsProbing(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const activate = useCallback(async (id: string) => {
    const result = await activateBackendProvider(id)
    if (result.ok) await refresh()
    return result
  }, [refresh])

  return {
    providers,
    activeProviderId,
    activeProvider: providers.find((p) => p.id === activeProviderId) ?? null,
    capabilities,
    isProbing,
    refresh,
    activate,
  }
}
