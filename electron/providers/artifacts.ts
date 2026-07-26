/**
 * Artifact transfer between this machine and the active provider.
 *
 * The backend speaks in absolute paths in its own filesystem, both for outputs
 * (`video_path`) and for inputs (`imagePath`, `audioPath`). When the backend is the local
 * managed one those paths are already ours and nothing here runs. When it is a remote box,
 * they have to cross the wire:
 *
 *   materializeArtifact()  provider path → local file (so the gallery can import it)
 *   stageInputFile()       local file → provider path (so a generation can reference it)
 */

import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { app } from 'electron'
import type { BackendProvider } from '../../shared/providers'
import { approvePath } from '../path-validation'
import { logger } from '../logger'
import { authHeaders } from './capabilities'

const TRANSFER_TIMEOUT_MS = 120_000

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'provider-artifacts')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Rewrite a provider-side path into a local one for `mapped-path` transport.
 * Returns null when the path lies outside the mapped root — better to fail loudly than to
 * hand back a path that happens to exist locally and belongs to something else.
 */
function mapRemotePath(provider: BackendProvider, remotePath: string): string | null {
  const map = provider.pathMap
  if (!map) return null
  const remoteRoot = map.remoteRoot.replace(/\/+$/, '')
  if (remotePath !== remoteRoot && !remotePath.startsWith(`${remoteRoot}/`)) return null
  const relative = remotePath.slice(remoteRoot.length).replace(/^\/+/, '')
  return path.join(map.localRoot, relative)
}

function requireBaseUrl(provider: BackendProvider): string {
  if (!provider.baseUrl) {
    throw new Error(`Provider "${provider.name}" has no base URL`)
  }
  return provider.baseUrl
}

async function downloadToCache(provider: BackendProvider, remotePath: string): Promise<string> {
  const baseUrl = requireBaseUrl(provider)
  const url = `${baseUrl}/api/artifacts/download?path=${encodeURIComponent(remotePath)}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: authHeaders(provider.authToken) })
    if (!response.ok) {
      const detail = response.status === 404
        ? 'the provider no longer has that file'
        : `HTTP ${response.status}`
      throw new Error(`Could not download ${path.basename(remotePath)} from "${provider.name}": ${detail}`)
    }
    if (!response.body) {
      throw new Error(`Provider "${provider.name}" returned an empty body for ${path.basename(remotePath)}`)
    }

    // Provider-side basenames are already unique (the backend timestamps them), but two
    // providers can collide, so namespace by provider id.
    const destination = path.join(cacheDir(), `${provider.id}__${path.basename(remotePath)}`)
    const partial = `${destination}.part`
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(partial))
    // Rename only after the body is fully written: a truncated file at the final path
    // would be indistinguishable from a good one on the next run.
    fs.renameSync(partial, destination)

    // The renderer will hand this path straight back for the project-asset copy, and that
    // path is validated against the allow-list roots — userData is one, but approve
    // explicitly so this keeps working if the cache ever moves.
    approvePath(destination)
    return destination
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Resolve a provider-reported output path to a local file.
 *
 * For the local provider this returns the input unchanged — the upstream path, byte for
 * byte, with no filesystem access of its own.
 */
export async function materializeArtifact(provider: BackendProvider, remotePath: string): Promise<string> {
  switch (provider.artifactTransport) {
    case 'local-path':
      return remotePath

    case 'mapped-path': {
      const mapped = mapRemotePath(provider, remotePath)
      if (!mapped) {
        throw new Error(
          `"${remotePath}" is outside the mapped root ${provider.pathMap?.remoteRoot ?? '(unset)'} for provider "${provider.name}"`,
        )
      }
      if (!fs.existsSync(mapped)) {
        throw new Error(`Mapped path does not exist locally: ${mapped} — is the share mounted?`)
      }
      approvePath(mapped)
      return mapped
    }

    case 'http-download':
      return downloadToCache(provider, remotePath)
  }
}

/**
 * Make a local input file available to the provider, returning the path the provider
 * should be given. No-op (identity) for the local provider.
 */
export async function stageInputFile(provider: BackendProvider, localPath: string): Promise<string> {
  if (provider.artifactTransport === 'local-path') return localPath

  if (provider.artifactTransport === 'mapped-path') {
    const map = provider.pathMap
    if (!map) throw new Error(`Provider "${provider.name}" is missing its path map`)
    const localRoot = path.resolve(map.localRoot)
    const resolved = path.resolve(localPath)
    if (resolved !== localRoot && !resolved.startsWith(localRoot + path.sep)) {
      throw new Error(
        `Input file must live under ${map.localRoot} to be visible to "${provider.name}" — got ${localPath}`,
      )
    }
    const relative = path.relative(localRoot, resolved).split(path.sep).join('/')
    return `${map.remoteRoot.replace(/\/+$/, '')}/${relative}`
  }

  const baseUrl = requireBaseUrl(provider)
  const stat = fs.statSync(localPath)
  if (!stat.isFile()) throw new Error(`Not a file: ${localPath}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS)
  try {
    const body = new FormData()
    body.append('file', new Blob([fs.readFileSync(localPath)]), path.basename(localPath))
    const response = await fetch(`${baseUrl}/api/artifacts/upload`, {
      method: 'POST',
      signal: controller.signal,
      headers: authHeaders(provider.authToken),
      body,
    })
    if (!response.ok) {
      throw new Error(
        `Could not upload ${path.basename(localPath)} to "${provider.name}": HTTP ${response.status}`
        + (response.status === 404 ? ' — this backend has no artifact endpoints (upgrade it)' : ''),
      )
    }
    const payload = (await response.json()) as { path?: unknown }
    if (typeof payload.path !== 'string' || !payload.path) {
      throw new Error(`Provider "${provider.name}" accepted the upload but returned no path`)
    }
    logger.info(`Staged ${path.basename(localPath)} to ${provider.name} at ${payload.path}`)
    return payload.path
  } finally {
    clearTimeout(timeout)
  }
}

/** Delete cached downloads for a provider (or all of them). Best-effort. */
export function clearArtifactCache(providerId?: string): void {
  const dir = cacheDir()
  for (const entry of fs.readdirSync(dir)) {
    if (providerId && !entry.startsWith(`${providerId}__`)) continue
    try {
      fs.rmSync(path.join(dir, entry), { force: true })
    } catch (error) {
      logger.warn(`Could not remove cached artifact ${entry}: ${error}`)
    }
  }
}
