/**
 * Output storage boundary.
 *
 * Generated media takes two steps to become a project asset:
 *
 *   materialize  the provider's reference (an absolute path in *its* filesystem) becomes a
 *                readable local file. Identity for the local provider; a download or a
 *                mount-path rewrite for a remote one.
 *   persist      that local file is copied into durable project storage.
 *
 * Upstream fuses both into a `fs.copyFileSync` from a path it assumes is local. Splitting
 * them is what lets a non-local provider — or, later, a non-filesystem store — participate
 * without touching the six call sites that import generated assets.
 *
 * The default store keeps the upstream behaviour exactly: local gallery, files under the
 * project assets directory.
 *
 * TODO(spellbound): a second implementation writes into a Spellbound store instead of the
 * project assets directory — frame-per-object, with `persist` declaring a sub-stream and
 * `materialize` reading a range back. Not built here: Spellbound addresses content by
 * (project, sub-stream, frame range) rather than by file, so `persist` would need to return
 * a reference richer than a path, and every consumer of `ProjectAsset.path` — the timeline,
 * the exporter, the thumbnailer — assumes a file it can open. That is a real design
 * question about the asset model, not an adapter detail, so the interface stops at the
 * boundary rather than guessing at it. See `docs/backend-providers.md`.
 */

import fs from 'fs'
import path from 'path'
import { getProjectAssetsPath } from '../app-state'
import { materializeArtifact } from '../providers/artifacts'
import { getActiveProvider } from '../providers/config'

export interface OutputStore {
  readonly id: string
  /** Provider-reported artifact reference → an absolute path readable on this machine. */
  materialize(reference: string): Promise<string>
  /** Copy a local file into durable storage for a project; returns the stored path. */
  persist(localPath: string, projectId: string): string
}

function getUniqueDestinationPath(destDir: string, fileName: string): string {
  const parsed = path.parse(fileName)
  let candidate = path.join(destDir, fileName)
  let idx = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${parsed.name}(${idx})${parsed.ext}`)
    idx += 1
  }
  return candidate
}

const localGalleryStore: OutputStore = {
  id: 'local-gallery',

  materialize(reference: string): Promise<string> {
    return materializeArtifact(getActiveProvider(), reference)
  },

  persist(localPath: string, projectId: string): string {
    const destDir = path.join(getProjectAssetsPath(), projectId)
    fs.mkdirSync(destDir, { recursive: true })
    const destPath = getUniqueDestinationPath(destDir, path.basename(localPath))
    fs.copyFileSync(localPath, destPath)
    return destPath
  },
}

/**
 * The active output store. One implementation today; the indirection exists so the
 * Spellbound work above has somewhere to land.
 */
export function getOutputStore(): OutputStore {
  return localGalleryStore
}
