/**
 * Provider smoke test — exercises the whole remote-backend contract over HTTP, with no
 * Electron and no UI.
 *
 * It walks the same sequence the app does: probe capabilities, refuse an unsupported
 * request using the same `checkCapability` the renderer calls, upload a conditioning input,
 * generate, poll progress, and download the result back. Everything it touches is a real
 * endpoint on a real backend, so a pass means the LAN path works, not that a mock agrees
 * with itself.
 *
 * Usage:
 *   node scripts/provider-smoke.ts --base-url http://127.0.0.1:8000 [--token TOKEN]
 *   node scripts/provider-smoke.ts --base-url http://192.168.1.50:8000 --token … --generate
 *
 * Without --generate it stops before spending GPU time; that short run is the one to use in
 * CI or when checking a box is reachable. Requires Node 24+ (runs TypeScript directly).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkCapability, normalizeBaseUrl, type ProviderCapabilities } from '../shared/providers.ts'

interface Args {
  baseUrl: string
  token?: string
  generate: boolean
  resolution: string
  duration: number
  fps: number
  model: string
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const baseUrl = normalizeBaseUrl(get('--base-url') ?? 'http://127.0.0.1:8000')
  return {
    baseUrl,
    token: get('--token'),
    generate: argv.includes('--generate'),
    resolution: get('--resolution') ?? '540p',
    duration: Number(get('--duration') ?? 5),
    fps: Number(get('--fps') ?? 24),
    model: get('--model') ?? 'fast',
  }
}

const args = parseArgs(process.argv.slice(2))
const headers: Record<string, string> = args.token ? { Authorization: `Bearer ${args.token}` } : {}

let failures = 0
function check(label: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
  return ok
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${args.baseUrl}${pathname}`, { headers })
  const text = await response.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, body }
}

async function postJson(pathname: string, payload: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${args.baseUrl}${pathname}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, body }
}

/** Same normalisation `electron/providers/capabilities.ts` performs, over the same routes. */
async function probe(): Promise<ProviderCapabilities> {
  const [health, gpu, specs, artifacts] = await Promise.all([
    getJson('/health'),
    getJson('/api/gpu-info'),
    getJson('/api/generate/models-specs'),
    getJson('/api/artifacts/capabilities'),
  ])

  const videoModels = (specs.body?.local_models ?? []).map((entry: any) => ({
    pipeline: entry.pipeline,
    displayName: entry.spec?.display_name ?? entry.pipeline,
    resolutions: Object.fromEntries(
      Object.entries(entry.spec?.supported_resolutions_durations ?? {}).map(([resolution, spec]: [string, any]) => [
        resolution,
        spec?.fps_to_durations ?? {},
      ]),
    ),
  }))

  return {
    providerId: 'smoke',
    reachable: health.status === 200,
    source: specs.status === 200 && videoModels.length > 0 ? 'probed' : 'declared',
    error: health.status === 200 ? undefined : `/health returned ${health.status}`,
    activeModel: health.body?.active_model ?? undefined,
    gpuName: gpu.body?.gpu_name ?? undefined,
    vramMb: gpu.body?.gpu_info?.vram ?? undefined,
    videoModels,
    features: {
      textToVideo: true,
      imageToVideo: true,
      audioToVideo: true,
      extend: true,
      retake: true,
      icLora: true,
      imageGeneration: true,
      artifactTransfer: artifacts.status === 200,
    },
    artifactTransport: 'http-download',
  }
}

async function main(): Promise<void> {
  console.log(`\nProvider smoke test → ${args.baseUrl}\n`)

  console.log('1. Capability probe')
  const capabilities = await probe()
  if (!check('backend reachable', capabilities.reachable, capabilities.error ?? '')) {
    process.exit(1)
  }
  check('reports a GPU', !!capabilities.gpuName, capabilities.gpuName ?? 'none reported')
  check('reports a model matrix', capabilities.source === 'probed',
    `${capabilities.videoModels.length} model(s), source=${capabilities.source}`)
  const hasArtifacts = check('artifact endpoints present', capabilities.features.artifactTransfer,
    capabilities.features.artifactTransfer ? '' : 'backend predates this branch — remote results cannot be imported')

  console.log('\n2. Capability check (the preflight the renderer runs)')
  const wanted = { model: args.model, resolution: args.resolution, fps: args.fps, duration: args.duration }
  const rejection = checkCapability(capabilities, wanted)

  if (hasArtifacts) {
    check(`${args.resolution}/${args.fps}fps/${args.duration}s accepted`, rejection === null, rejection?.message ?? '')
  } else {
    // A provider that cannot return files is refused up front rather than after a
    // generation has already spent the GPU. That refusal is the correct outcome here, so
    // check for it by code — "something was rejected" would also be satisfied by a
    // rejection for an entirely different reason.
    check('a provider that cannot return results is refused before generating',
      rejection?.code === 'ARTIFACT_TRANSFER_UNSUPPORTED',
      rejection ? `${rejection.code}: ${rejection.message}` : 'it was NOT refused')
  }

  const absurd = checkCapability(capabilities, { model: args.model, resolution: args.resolution, fps: args.fps, duration: 9999 })
  if (hasArtifacts) {
    // Assert the code, not merely that something was refused: the artifact-transfer guard
    // runs before the duration check, so a bare `!== null` would pass on a backend without
    // artifact endpoints while never exercising the duration logic at all.
    check('a 9999s request is refused before it is sent', absurd?.code === 'DURATION_UNSUPPORTED',
      absurd ? `${absurd.code}: ${absurd.message}` : 'it was NOT refused')
  } else {
    console.log('  skip  duration refusal — unreachable behind the artifact-transfer guard on this backend')
  }

  if (hasArtifacts) {
    console.log('\n3. Artifact round trip')
    const payload = Buffer.from(`smoke ${Date.now()}`)
    const form = new FormData()
    form.append('file', new Blob([payload]), 'smoke-input.png')
    const uploadResponse = await fetch(`${args.baseUrl}/api/artifacts/upload`, { method: 'POST', headers, body: form })
    const uploaded = uploadResponse.ok ? await uploadResponse.json() as { path: string } : null
    if (check('upload accepted', !!uploaded, uploaded?.path ?? `HTTP ${uploadResponse.status}`)) {
      const downloadResponse = await fetch(
        `${args.baseUrl}/api/artifacts/download?path=${encodeURIComponent(uploaded!.path)}`, { headers })
      const returned = Buffer.from(await downloadResponse.arrayBuffer())
      check('download returns the same bytes', returned.equals(payload), `${returned.length} bytes`)
    }

    const escape = await getJson(`/api/artifacts/download?path=${encodeURIComponent('/etc/passwd')}`)
    check('a path outside the artifact roots is refused', escape.status === 403, `HTTP ${escape.status}`)
  }

  if (!args.generate) {
    console.log('\n(skipping generation — pass --generate to run one)')
  } else {
    console.log('\n4. Generation')
    const startedAt = Date.now()
    const polling = setInterval(() => {
      void getJson('/api/generation/progress').then(({ body }) => {
        if (body?.status === 'running') {
          process.stdout.write(`\r       ${body.phase} ${body.progress}%   `)
        }
      })
    }, 2000)

    const result = await postJson('/api/generate', {
      prompt: 'a slow pan across an empty room, natural light',
      model: args.model,
      resolution: args.resolution,
      duration: args.duration,
      fps: args.fps,
      audio: false,
      aspectRatio: '16:9',
      seed: 12345,
    })
    clearInterval(polling)
    process.stdout.write('\r')

    const videoPath: string | undefined = result.body?.video_path
    if (check('generation completed', result.status === 200 && !!videoPath,
      videoPath ?? `HTTP ${result.status}: ${JSON.stringify(result.body)}`)) {
      console.log(`       ${Math.round((Date.now() - startedAt) / 1000)}s → ${videoPath}`)

      if (hasArtifacts) {
        const response = await fetch(
          `${args.baseUrl}/api/artifacts/download?path=${encodeURIComponent(videoPath!)}`, { headers })
        const bytes = Buffer.from(await response.arrayBuffer())
        const local = path.join(os.tmpdir(), `provider-smoke-${path.basename(videoPath!)}`)
        fs.writeFileSync(local, bytes)
        // This is the step that makes a remote provider usable at all: without it the app
        // holds a path on a machine it cannot read.
        check('result imported to this machine', bytes.length > 0, `${bytes.length} bytes → ${local}`)
      }
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
