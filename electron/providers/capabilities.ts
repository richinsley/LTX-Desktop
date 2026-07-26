/**
 * Capability probing.
 *
 * Asks a backend what it can do rather than assuming. Everything here is plain HTTP against
 * endpoints upstream already serves — `/health`, `/api/gpu-info`,
 * `/api/generate/models-specs` — plus a HEAD on the artifact endpoint this branch adds, so
 * an unmodified upstream backend probes cleanly and simply reports
 * `features.artifactTransfer: false`.
 */

import {
  DECLARED_LTX_FEATURES,
  type ArtifactTransport,
  type ProviderCapabilities,
  type ProviderVideoModelSpec,
} from '../../shared/providers'

const PROBE_TIMEOUT_MS = 5000

interface ProbeTarget {
  providerId: string
  baseUrl: string
  authToken?: string
  artifactTransport: ArtifactTransport
}

export function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchJson(
  url: string,
  token: string | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: authHeaders(token) })
    if (!response.ok) return { ok: false, status: response.status, body: null }
    return { ok: true, status: response.status, body: (await response.json()) as unknown }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * `/api/generate/models-specs` → our flatter shape.
 *
 * `local_models` is what a self-hosted box can actually run; `api_models` are Lightricks'
 * hosted pipelines, which a LAN provider has no say over. A provider's capabilities are its
 * local models.
 */
function parseModelSpecs(body: unknown): ProviderVideoModelSpec[] {
  if (!body || typeof body !== 'object') return []
  const localModels = (body as { local_models?: unknown }).local_models
  if (!Array.isArray(localModels)) return []

  const specs: ProviderVideoModelSpec[] = []
  for (const entry of localModels) {
    if (!entry || typeof entry !== 'object') continue
    const { pipeline, spec } = entry as { pipeline?: unknown; spec?: unknown }
    if (typeof pipeline !== 'string' || !spec || typeof spec !== 'object') continue

    const { display_name: displayName, supported_resolutions_durations: supported } = spec as {
      display_name?: unknown
      supported_resolutions_durations?: unknown
    }
    if (!supported || typeof supported !== 'object') continue

    const resolutions: Record<string, Record<string, number[]>> = {}
    for (const [resolution, resolutionSpec] of Object.entries(supported as Record<string, unknown>)) {
      const fpsToDurations = (resolutionSpec as { fps_to_durations?: unknown } | null)?.fps_to_durations
      if (!fpsToDurations || typeof fpsToDurations !== 'object') continue
      const byFps: Record<string, number[]> = {}
      for (const [fps, durations] of Object.entries(fpsToDurations as Record<string, unknown>)) {
        if (Array.isArray(durations)) {
          byFps[fps] = durations.filter((d): d is number => typeof d === 'number')
        }
      }
      resolutions[resolution] = byFps
    }

    specs.push({
      pipeline,
      displayName: typeof displayName === 'string' ? displayName : pipeline,
      resolutions,
    })
  }
  return specs
}

async function hasArtifactTransfer(baseUrl: string, token: string | undefined): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/api/artifacts/capabilities`, {
      signal: controller.signal,
      headers: authHeaders(token),
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Probe a provider. Never throws: an unreachable provider is a capability answer
 * (`reachable: false` with the transport error), not an exception for callers to handle.
 */
export async function probeProvider(target: ProbeTarget): Promise<ProviderCapabilities> {
  const { providerId, baseUrl, authToken, artifactTransport } = target
  const startedAt = Date.now()

  const base: ProviderCapabilities = {
    providerId,
    reachable: false,
    source: 'declared',
    videoModels: [],
    features: { ...DECLARED_LTX_FEATURES },
    artifactTransport,
  }

  if (!baseUrl) {
    return { ...base, error: 'No base URL configured for this provider.' }
  }

  try {
    const health = await fetchJson(`${baseUrl}/health`, authToken)
    if (!health.ok) {
      return {
        ...base,
        error: health.status === 401
          ? 'Rejected the auth token (401). Check the token the remote backend was started with.'
          : `/health returned HTTP ${health.status}.`,
        probeMs: Date.now() - startedAt,
      }
    }

    // Health answered, so the provider exists. The rest is best-effort enrichment: a
    // backend that answers /health but not /api/gpu-info is degraded, not absent.
    const [gpu, specs, artifactTransfer] = await Promise.all([
      fetchJson(`${baseUrl}/api/gpu-info`, authToken).catch(() => ({ ok: false, status: 0, body: null })),
      fetchJson(`${baseUrl}/api/generate/models-specs`, authToken).catch(() => ({ ok: false, status: 0, body: null })),
      hasArtifactTransfer(baseUrl, authToken),
    ])

    const healthBody = (health.body ?? {}) as { active_model?: unknown }
    const gpuBody = (gpu.ok ? gpu.body : {}) as {
      gpu_name?: unknown
      vram_gb?: unknown
      gpu_info?: { name?: unknown; vram?: unknown }
    }
    const videoModels = specs.ok ? parseModelSpecs(specs.body) : []

    // gpu_info.vram is megabytes; vram_gb is the rounded-down gigabyte figure. Prefer the
    // precise one and fall back rather than reporting 0 for a card we did see.
    const vramMb = typeof gpuBody.gpu_info?.vram === 'number'
      ? gpuBody.gpu_info.vram
      : typeof gpuBody.vram_gb === 'number' ? gpuBody.vram_gb * 1024 : undefined

    return {
      providerId,
      reachable: true,
      // "probed" only when the provider answered the capability query itself. If it did
      // not, these are the static LTX defaults and the UI must not present them as fact.
      source: specs.ok && videoModels.length > 0 ? 'probed' : 'declared',
      activeModel: typeof healthBody.active_model === 'string' ? healthBody.active_model : undefined,
      gpuName: typeof gpuBody.gpu_name === 'string'
        ? gpuBody.gpu_name
        : typeof gpuBody.gpu_info?.name === 'string' ? gpuBody.gpu_info.name : undefined,
      vramMb,
      videoModels,
      features: { ...DECLARED_LTX_FEATURES, artifactTransfer },
      artifactTransport,
      probeMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `No response within ${PROBE_TIMEOUT_MS}ms.`
      : error instanceof Error ? error.message : String(error)
    return { ...base, error: message, probeMs: Date.now() - startedAt }
  }
}
