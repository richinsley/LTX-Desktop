import { ApiClient } from './api-client'
import { GENERATION_RECOVERY_KEY, type GenerationRecoveryContext } from '../hooks/use-generation'
import { builtinRecoveryImporters } from './generation-recovery-importers'
import { logger } from './logger'
import type { Asset } from '../types/project-model'

// Three consecutive failures of the same import is enough to call it permanent. Retrying is
// worth doing — a transient lock or a momentarily missing file does resolve — but each
// attempt copies the media again, so the cost of being wrong grows with every tick.
const MAX_IMPORT_ATTEMPTS = 3

// Keyed the same way the recovery marker already is: undefined means the default "video" case
// (t2v/i2v/a2v/ic-lora/retake/extend all recover as a standalone video asset today — see
// GenSpace's own mount-recovery effect for why those four share one fallback).
export type RecoveryGenType = NonNullable<GenerationRecoveryContext['genType']> | 'video'

export interface RecoveryImporterApi {
  addAsset: (projectId: string, asset: Omit<Asset, 'id' | 'createdAt'>) => unknown
  modelsDir: string
}

export type RecoveryImporter = (
  ctx: GenerationRecoveryContext,
  result: string | string[],
  api: RecoveryImporterApi,
) => Promise<void> | void

// A marker written by an older build (before baselineId existed) would parse fine as JSON but
// have `baselineId === undefined` — and since the progress endpoint's `id` is always `string |
// null`, never `undefined`, an identity check that just compares `observedId === ctx.baselineId`
// would treat that `undefined` as "already different from whatever's live right now" and trust
// it immediately, on the very first tick, with zero confirmation. Callers must check this before
// trusting anything else in the marker.
export function hasValidBaselineId(ctx: GenerationRecoveryContext): boolean {
  return typeof ctx.baselineId === 'string' || ctx.baselineId === null
}

// The project whose GenSpace instance is currently mounted and already handling its own
// generation lifecycle live (polling, completion effects). The background watcher backs off
// entirely for it, so two independent pollers never race to import the same completion twice.
let activeOwnerProjectId: string | null = null

export function setActiveGenerationOwner(projectId: string | null): void {
  activeOwnerProjectId = projectId
}

// One check: is there a recovery marker, is anything registered to handle it, and if the
// generation it points at has finished, persist the result into its project. Takes an
// already-fetched progress poll (shared with useGlobalGenerationLock via
// subscribeToGenerationProgress) instead of fetching its own, so mounting both doesn't double
// the network chatter.
export async function checkAndConsumeRecovery(
  progress: Awaited<ReturnType<typeof ApiClient.getGenerationProgress>>,
  api: RecoveryImporterApi,
): Promise<void> {
  const saved = localStorage.getItem(GENERATION_RECOVERY_KEY)
  if (!saved) return

  let ctx: GenerationRecoveryContext
  try {
    ctx = JSON.parse(saved) as GenerationRecoveryContext
  } catch {
    localStorage.removeItem(GENERATION_RECOVERY_KEY)
    return
  }
  if (!hasValidBaselineId(ctx)) {
    localStorage.removeItem(GENERATION_RECOVERY_KEY)
    return
  }

  // That project's own GenSpace is mounted and already polling/importing this live.
  if (ctx.projectId === activeOwnerProjectId) return

  // A generation kind with no importer (e.g. 'enhance': there's nowhere to put a rewritten
  // prompt without an open editor) is left alone here — only that project's own mount-recovery
  // effect can handle it.
  const importer = builtinRecoveryImporters[ctx.genType ?? 'video']
  if (!importer) return

  if (!progress.ok) return
  const observedId = progress.data.id
  const status = progress.data.status

  if (ctx.generationId == null) {
    // Not yet confirmed. Any id different from the baseline captured when this marker was
    // written proves (single global generation slot) our generation has started — regardless of
    // status, even if it's already 'complete' by the time we look (a fast generation can finish
    // between two polls). Until the id actually changes, this endpoint is still reporting
    // whatever predated this marker, which must not be trusted.
    if (observedId === ctx.baselineId) return
    ctx = { ...ctx, generationId: observedId ?? undefined }
    localStorage.setItem(GENERATION_RECOVERY_KEY, JSON.stringify(ctx))
  } else if (observedId !== ctx.generationId) {
    // Already confirmed once; a FURTHER id change means a different generation superseded ours
    // before we ever saw it finish. Nothing left to recover.
    localStorage.removeItem(GENERATION_RECOVERY_KEY)
    return
  }

  if (status === 'running') return // still going — check again next tick

  if (status === 'complete' && progress.data.result != null) {
    try {
      await importer(ctx, progress.data.result, api)
    } catch (error) {
      // Retry, but not forever. Leaving the marker on every failure means a permanently
      // failing import (a thumbnailer that can't run, a full disk, a vanished source) is
      // retried every poll for the life of the session — and each attempt copies the media
      // again under a fresh unique name, so the loop fills the disk while it spins. A cause
      // that has failed MAX_IMPORT_ATTEMPTS times in a row is not transient.
      const attempts = (ctx.importAttempts ?? 0) + 1
      if (attempts >= MAX_IMPORT_ATTEMPTS) {
        logger.error(
          `Giving up importing the recovered generation after ${attempts} attempts: ${error}`,
        )
        localStorage.removeItem(GENERATION_RECOVERY_KEY)
        return
      }
      localStorage.setItem(GENERATION_RECOVERY_KEY, JSON.stringify({ ...ctx, importAttempts: attempts }))
      return
    }
  }

  localStorage.removeItem(GENERATION_RECOVERY_KEY)
}
