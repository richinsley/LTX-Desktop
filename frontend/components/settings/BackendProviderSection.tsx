import { AlertCircle, Check, Loader2, Server, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { LOCAL_PROVIDER_ID, normalizeBaseUrl, type BackendProvider, type ProviderCapabilities } from '../../../shared/providers'
import { useBackendProvider } from '../../hooks/use-backend-provider'
import { describeCapabilities, testProviderDraft } from '../../lib/providers'
import { logger } from '../../lib/logger'
import { Button } from '../ui/button'

const inputClass = 'w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500'

interface DraftState {
  name: string
  baseUrl: string
  authToken: string
}

const emptyDraft: DraftState = { name: '', baseUrl: '', authToken: '' }

/** Slug from the display name, so the user never has to invent an id. */
function draftId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'remote-backend'
}

function draftToProvider(draft: DraftState): BackendProvider {
  return {
    id: draftId(draft.name),
    name: draft.name.trim(),
    kind: 'remote-http',
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    authToken: draft.authToken.trim() || undefined,
    artifactTransport: 'http-download',
  }
}

function CapabilityLine({ capabilities }: { capabilities: ProviderCapabilities }) {
  const good = capabilities.reachable
  return (
    <div className={`flex items-start gap-2 text-xs ${good ? 'text-zinc-400' : 'text-amber-400'}`}>
      {good ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="leading-relaxed">{describeCapabilities(capabilities)}</span>
    </div>
  )
}

/**
 * Choose which backend serves generation requests.
 *
 * The bundled local backend is the default and is always listed first; everything else is a
 * URL the user has pointed at — typically a workstation on the LAN whose GPU is larger than
 * the one running the app.
 */
export function BackendProviderSection() {
  const { providers, activeProviderId, capabilities, isProbing, refresh, activate } = useBackendProvider()
  const [draft, setDraft] = useState<DraftState>(emptyDraft)
  const [draftResult, setDraftResult] = useState<ProviderCapabilities | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDraftResult(null) }, [draft.baseUrl, draft.authToken])

  const testDraft = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setDraftResult(await testProviderDraft(draftToProvider(draft)))
    } catch (e) {
      logger.error(`Provider test failed: ${e}`)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [draft])

  const saveDraft = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.upsertBackendProvider(draftToProvider(draft))
      if (!result.success) {
        setError(result.error)
        return
      }
      setDraft(emptyDraft)
      setDraftResult(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [draft, refresh])

  const remove = useCallback(async (id: string) => {
    setBusy(true)
    try {
      const result = await window.electronAPI.removeBackendProvider({ id })
      if (!result.success) setError(result.error)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const select = useCallback(async (id: string) => {
    setBusy(true)
    setError(null)
    const result = await activate(id)
    if (!result.ok) setError(result.error ?? 'Could not switch provider')
    setBusy(false)
  }, [activate])

  const canSubmit = draft.name.trim().length > 0 && draft.baseUrl.trim().length > 0

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-blue-400" />
          <h3 className="text-sm font-semibold text-white">Generation Backend</h3>
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">
          Where generation requests are sent. The bundled backend runs on this machine. A remote
          backend is an LTX backend already running elsewhere — start it there with{' '}
          <code className="text-zinc-400">LTX_HOST=0.0.0.0</code> and{' '}
          <code className="text-zinc-400">LTX_AUTH_TOKEN</code> set, and results are fetched back
          over HTTP.
        </p>

        <div className="space-y-2">
          {providers.map((provider) => {
            const isActive = provider.id === activeProviderId
            return (
              <div
                key={provider.id}
                className={`rounded-lg border-2 p-3 transition-colors ${
                  isActive ? 'border-blue-500 bg-zinc-800/50' : 'border-transparent bg-zinc-800/30 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    className="flex-1 text-left"
                    disabled={busy}
                    onClick={() => { if (!isActive) void select(provider.id) }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{provider.name}</span>
                      {isActive && <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-blue-300">Active</span>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {provider.kind === 'managed-local' ? 'Spawned by this app on 127.0.0.1' : provider.baseUrl}
                    </div>
                  </button>
                  {provider.id !== LOCAL_PROVIDER_ID && (
                    <Button variant="ghost" size="icon" disabled={busy} onClick={() => void remove(provider.id)}>
                      <Trash2 className="h-4 w-4 text-zinc-500" />
                    </Button>
                  )}
                </div>
                {isActive && (
                  <div className="mt-2 border-t border-zinc-700/60 pt-2">
                    {isProbing && !capabilities
                      ? <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing…</div>
                      : capabilities
                        ? <CapabilityLine capabilities={capabilities} />
                        : <span className="text-xs text-zinc-600">No capability information.</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-4">
        <h4 className="text-sm font-medium text-white">Add a remote backend</h4>
        <div className="grid gap-2">
          <input
            className={inputClass}
            placeholder="Name (e.g. Workstation RTX PRO 5000)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className={inputClass}
            placeholder="http://192.168.1.50:8000"
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
          <input
            className={inputClass}
            type="password"
            autoComplete="off"
            placeholder="Auth token (the backend's LTX_AUTH_TOKEN, if it has one)"
            value={draft.authToken}
            onChange={(e) => setDraft({ ...draft, authToken: e.target.value })}
          />
        </div>

        {draftResult && <CapabilityLine capabilities={draftResult} />}
        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex items-center gap-2">
          <Button variant="outline" className="border-zinc-700" disabled={!canSubmit || busy} onClick={() => void testDraft()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test connection'}
          </Button>
          <Button disabled={!canSubmit || busy} onClick={() => void saveDraft()}>Add</Button>
          {/* The window reloads on Add so the new origin is covered by connect-src; saying so
              keeps that from looking like a crash. */}
          <span className="text-xs text-zinc-600">Adding a backend reloads the window.</span>
        </div>
      </div>
    </div>
  )
}
