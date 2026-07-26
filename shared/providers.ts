/**
 * Backend provider contract.
 *
 * Upstream LTX Desktop has exactly one backend: a Python process Electron spawns on
 * 127.0.0.1, whose URL is scraped from its stdout. This module generalises that into a
 * *provider* — something that can accept generation requests — without changing what
 * happens by default.
 *
 * Two kinds ship today:
 *   - `managed-local`  the embedded backend Electron spawns. This is the default and its
 *                      behaviour is bit-for-bit the upstream behaviour.
 *   - `remote-http`    an LTX backend already running somewhere else (another box on the
 *                      LAN, typically one with a much larger GPU). Electron spawns nothing
 *                      and only talks HTTP to it.
 *
 * The types live in `shared/` because both the Electron main process (which owns provider
 * config, health and artifact transfer) and the renderer (which shows capabilities and
 * refuses unsupported requests before spending a round trip) need them.
 */

/** How a provider's process is obtained. */
export type BackendProviderKind = 'managed-local' | 'remote-http'

/**
 * How generated files get from the provider to this machine.
 *
 * The backend reports outputs as absolute paths in *its own* filesystem (see
 * `GenerateVideoCompleteResponse.video_path`). That is fine when the backend is local and
 * meaningless when it isn't, so a provider has to say how to resolve such a path.
 */
export type ArtifactTransport =
  /** Paths are already local — read them directly. Upstream behaviour. */
  | 'local-path'
  /** Fetch over HTTP from the provider's artifact endpoint. */
  | 'http-download'
  /** The provider's filesystem is mounted here (NFS/SMB); rewrite the path prefix. */
  | 'mapped-path'

/** Prefix rewrite for `mapped-path` transport: `${remoteRoot}/x` ⇄ `${localRoot}/x`. */
export interface ArtifactPathMap {
  remoteRoot: string
  localRoot: string
}

export interface BackendProvider {
  /** Stable identifier. `ltx-local` is reserved for the built-in managed backend. */
  id: string
  /** Human-readable name shown in the UI. */
  name: string
  kind: BackendProviderKind
  /**
   * Base URL, no trailing slash — e.g. `http://192.168.1.50:8000`.
   * Ignored (and empty) for `managed-local`, whose URL is discovered at spawn time.
   */
  baseUrl?: string
  /**
   * Bearer token, if the remote backend was started with `LTX_AUTH_TOKEN`. Optional
   * because a backend started without one accepts unauthenticated requests.
   */
  authToken?: string
  artifactTransport: ArtifactTransport
  /** Required when `artifactTransport === 'mapped-path'`. */
  pathMap?: ArtifactPathMap
}

/** The built-in provider. Always present, never editable, never removable. */
export const LOCAL_PROVIDER_ID = 'ltx-local'

export const LOCAL_PROVIDER: BackendProvider = {
  id: LOCAL_PROVIDER_ID,
  name: 'Local (bundled backend)',
  kind: 'managed-local',
  artifactTransport: 'local-path',
}

/**
 * What a provider can actually do.
 *
 * `source: 'probed'` means we asked the provider and this is its own answer;
 * `source: 'declared'` means the provider did not answer a capability query and these are
 * the static LTX defaults. The distinction is deliberately visible: a declared capability
 * set is a guess, and the UI says so rather than presenting it as fact.
 */
export interface ProviderCapabilities {
  providerId: string
  reachable: boolean
  source: 'probed' | 'declared'
  /** Present when unreachable — the transport-level reason, verbatim. */
  error?: string
  /** `active_model` from `/health` — which checkpoint the provider currently has loaded. */
  activeModel?: string
  /** From `/api/gpu-info`. */
  gpuName?: string
  vramMb?: number
  /**
   * From `/api/generate/models-specs` — the provider's own (model → resolution → fps →
   * durations) matrix. This is the authority for what a generation request may ask for.
   */
  videoModels: ProviderVideoModelSpec[]
  /** Endpoints observed on the provider, used to gate optional features. */
  features: ProviderFeatures
  artifactTransport: ArtifactTransport
  /** Round-trip time of the capability probe, milliseconds. */
  probeMs?: number
}

export interface ProviderVideoModelSpec {
  pipeline: string
  displayName: string
  /** resolution → fps (as string) → allowed durations in seconds. */
  resolutions: Record<string, Record<string, number[]>>
}

export interface ProviderFeatures {
  /** `POST /api/generate` — always true for an LTX provider. */
  textToVideo: boolean
  /** `imagePath` accepted on `/api/generate`. */
  imageToVideo: boolean
  /** `audioPath` accepted on `/api/generate`. */
  audioToVideo: boolean
  /** `POST /api/extend`. */
  extend: boolean
  /** `POST /api/retake`. */
  retake: boolean
  /** `POST /api/ic-lora/generate`. */
  icLora: boolean
  /** `POST /api/generate-image`. */
  imageGeneration: boolean
  /**
   * `GET /api/artifacts/download` + `POST /api/artifacts/upload`. Required for a
   * `remote-http` provider to return anything usable; absent on older backends.
   */
  artifactTransfer: boolean
}

/** Static LTX capability declaration, used when a provider answers no capability query. */
export const DECLARED_LTX_FEATURES: ProviderFeatures = {
  textToVideo: true,
  imageToVideo: true,
  audioToVideo: true,
  extend: true,
  retake: true,
  icLora: true,
  imageGeneration: true,
  artifactTransfer: false,
}

/** A generation request checked against a provider's declared capabilities. */
export interface CapabilityCheckRequest {
  model: string
  resolution: string
  fps: number
  duration: number
  needsImageInput?: boolean
  needsAudioInput?: boolean
}

export type CapabilityRejectionCode =
  | 'PROVIDER_UNREACHABLE'
  | 'MODEL_UNSUPPORTED'
  | 'RESOLUTION_UNSUPPORTED'
  | 'FPS_UNSUPPORTED'
  | 'DURATION_UNSUPPORTED'
  | 'FEATURE_UNSUPPORTED'

export interface CapabilityRejection {
  code: CapabilityRejectionCode
  /** One sentence, safe to show to a user, naming both the ask and what is on offer. */
  message: string
  /** What the provider does support on the axis that failed. */
  supported?: (string | number)[]
}

/**
 * Refuse a request the provider has said it cannot serve, before it is sent.
 *
 * Returns `null` when the request is servable. The backend validates independently and
 * answers 422 `INVALID_VIDEO_GENERATION_SPEC`; this exists so the failure names the
 * provider and the supported values instead of surfacing a bare 422 from a machine the
 * user may not even be able to see the logs of.
 */
export function checkCapability(
  capabilities: ProviderCapabilities | null,
  request: CapabilityCheckRequest,
): CapabilityRejection | null {
  if (!capabilities || !capabilities.reachable) {
    return {
      code: 'PROVIDER_UNREACHABLE',
      message: capabilities?.error
        ? `Backend provider is unreachable: ${capabilities.error}`
        : 'Backend provider is unreachable.',
    }
  }

  if (request.needsImageInput && !capabilities.features.imageToVideo) {
    return { code: 'FEATURE_UNSUPPORTED', message: 'This provider does not support image-to-video.' }
  }
  if (request.needsAudioInput && !capabilities.features.audioToVideo) {
    return { code: 'FEATURE_UNSUPPORTED', message: 'This provider does not support audio-to-video.' }
  }

  // No model matrix at all: the provider told us nothing, so refusing here would block
  // work the backend may well accept. Let it through and let the backend answer.
  if (capabilities.videoModels.length === 0) return null

  const model = capabilities.videoModels.find((m) => m.pipeline === request.model)
  if (!model) {
    return {
      code: 'MODEL_UNSUPPORTED',
      message: `Model "${request.model}" is not available on this provider.`,
      supported: capabilities.videoModels.map((m) => m.pipeline),
    }
  }

  const resolutions = Object.keys(model.resolutions)
  const fpsMap = model.resolutions[request.resolution]
  if (!fpsMap) {
    return {
      code: 'RESOLUTION_UNSUPPORTED',
      message: `${request.resolution} is not supported by "${model.displayName}" on this provider.`,
      supported: resolutions,
    }
  }

  const fpsOptions = Object.keys(fpsMap)
  const durations = fpsMap[String(request.fps)]
  if (!durations) {
    return {
      code: 'FPS_UNSUPPORTED',
      message: `${request.fps} fps is not supported at ${request.resolution} on this provider.`,
      supported: fpsOptions.map(Number),
    }
  }

  if (!durations.includes(request.duration)) {
    return {
      code: 'DURATION_UNSUPPORTED',
      message: `${request.duration}s is not supported at ${request.resolution}/${request.fps}fps on this provider.`,
      supported: durations,
    }
  }

  return null
}

/** Normalise user-entered base URLs: trim, add scheme if missing, drop trailing slash. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}
