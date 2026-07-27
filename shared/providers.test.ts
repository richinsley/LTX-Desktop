/**
 * Tests for the provider capability rules.
 *
 * `shared/providers.ts` is pure and now gates five call sites (video generation, image
 * generation, extend, retake, IC-LoRA), so a change to the order or conditions of its
 * refusals silently changes what the whole app will attempt. That already happened once:
 * adding the artifact-transfer guard ahead of the duration check turned a smoke-test
 * assertion of "something was refused" into a pass that never reached the duration logic.
 *
 * No framework — `node --test` with Node's own type stripping. Run:
 *   node --test shared/providers.test.ts        (or `pnpm test:shared`)
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkCapability,
  checkFeature,
  normalizeBaseUrl,
  type ProviderCapabilities,
} from './providers.ts'

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    providerId: 'test',
    reachable: true,
    source: 'probed',
    videoModels: [{
      pipeline: 'fast',
      displayName: 'LTX 2.3 Fast',
      resolutions: { '540p': { '24': [5, 10, 20] }, '720p': { '24': [5, 10] } },
    }],
    features: {
      textToVideo: true,
      imageToVideo: true,
      audioToVideo: true,
      extend: true,
      retake: true,
      icLora: true,
      imageGeneration: true,
      artifactTransfer: true,
    },
    artifactTransport: 'http-download',
    ...overrides,
  }
}

const wanted = { model: 'fast', resolution: '540p', fps: 24, duration: 5 }

describe('checkCapability', () => {
  it('accepts a request the provider reports it can serve', () => {
    assert.equal(checkCapability(capabilities(), wanted), null)
  })

  it('refuses when capabilities are unknown', () => {
    assert.equal(checkCapability(null, wanted)?.code, 'PROVIDER_UNREACHABLE')
  })

  it('carries the transport error into the message, so the user sees the actual cause', () => {
    const rejection = checkCapability(capabilities({ reachable: false, error: 'connect ECONNREFUSED' }), wanted)
    assert.equal(rejection?.code, 'PROVIDER_UNREACHABLE')
    assert.match(rejection!.message, /ECONNREFUSED/)
  })

  it('names what the provider does support on the axis that failed', () => {
    const tooLong = checkCapability(capabilities(), { ...wanted, duration: 9999 })
    assert.equal(tooLong?.code, 'DURATION_UNSUPPORTED')
    assert.deepEqual(tooLong?.supported, [5, 10, 20])

    const badResolution = checkCapability(capabilities(), { ...wanted, resolution: '2160p' })
    assert.equal(badResolution?.code, 'RESOLUTION_UNSUPPORTED')
    assert.deepEqual(badResolution?.supported, ['540p', '720p'])

    const badModel = checkCapability(capabilities(), { ...wanted, model: 'pro' })
    assert.equal(badModel?.code, 'MODEL_UNSUPPORTED')
    assert.deepEqual(badModel?.supported, ['fast'])

    const badFps = checkCapability(capabilities(), { ...wanted, fps: 60 })
    assert.equal(badFps?.code, 'FPS_UNSUPPORTED')
    assert.deepEqual(badFps?.supported, [24])
  })

  it('does not second-guess a provider that reported no matrix at all', () => {
    // Refusing here would block work the backend may well accept; let it answer.
    const silent = capabilities({ videoModels: [], source: 'declared' })
    assert.equal(checkCapability(silent, { ...wanted, duration: 9999 }), null)
  })

  it('refuses an http-download provider with no artifact endpoints', () => {
    const noTransfer = capabilities({ features: { ...capabilities().features, artifactTransfer: false } })
    assert.equal(checkCapability(noTransfer, wanted)?.code, 'ARTIFACT_TRANSFER_UNSUPPORTED')
  })

  it('does not require artifact endpoints for local-path or mapped-path providers', () => {
    // Those transports never call /api/artifacts/* — the file is already readable here, or
    // reachable through a mount. Gating them on it would refuse working configurations.
    const features = { ...capabilities().features, artifactTransfer: false }
    assert.equal(checkCapability(capabilities({ artifactTransport: 'local-path', features }), wanted), null)
    assert.equal(checkCapability(capabilities({ artifactTransport: 'mapped-path', features }), wanted), null)
  })

  it('reports the artifact refusal ahead of the request-shape refusals', () => {
    // Ordering is load-bearing for tests written against this function: a provider that
    // cannot return files is refused for that reason even when the ask is also invalid, so
    // an assertion of "some rejection happened" proves nothing about the other checks.
    const noTransfer = capabilities({ features: { ...capabilities().features, artifactTransfer: false } })
    assert.equal(checkCapability(noTransfer, { ...wanted, duration: 9999 })?.code, 'ARTIFACT_TRANSFER_UNSUPPORTED')
  })

  it('refuses conditioning inputs the provider does not accept', () => {
    const noI2v = capabilities({ features: { ...capabilities().features, imageToVideo: false } })
    assert.equal(checkCapability(noI2v, { ...wanted, needsImageInput: true })?.code, 'FEATURE_UNSUPPORTED')
    assert.equal(checkCapability(noI2v, wanted), null, 'only when an image is actually supplied')

    const noA2v = capabilities({ features: { ...capabilities().features, audioToVideo: false } })
    assert.equal(checkCapability(noA2v, { ...wanted, needsAudioInput: true })?.code, 'FEATURE_UNSUPPORTED')
  })
})

describe('checkFeature', () => {
  it('accepts a feature the provider reports', () => {
    for (const feature of ['extend', 'retake', 'icLora', 'imageGeneration'] as const) {
      assert.equal(checkFeature(capabilities(), feature), null, feature)
    }
  })

  it('refuses a feature the provider lacks, naming it', () => {
    const noExtend = capabilities({ features: { ...capabilities().features, extend: false } })
    const rejection = checkFeature(noExtend, 'extend')
    assert.equal(rejection?.code, 'FEATURE_UNSUPPORTED')
    assert.match(rejection!.message, /Extend/)
  })

  it('applies the same usability rules as checkCapability', () => {
    assert.equal(checkFeature(null, 'retake')?.code, 'PROVIDER_UNREACHABLE')

    const noTransfer = capabilities({ features: { ...capabilities().features, artifactTransfer: false } })
    assert.equal(checkFeature(noTransfer, 'retake')?.code, 'ARTIFACT_TRANSFER_UNSUPPORTED')
  })

  it('is not gated on the video-generation matrix', () => {
    // Extend and friends have no model/resolution/duration axes; a provider that reports no
    // matrix must still be allowed to run them.
    assert.equal(checkFeature(capabilities({ videoModels: [], source: 'declared' }), 'extend'), null)
  })
})

describe('normalizeBaseUrl', () => {
  it('adds a scheme, trims, and drops trailing slashes', () => {
    assert.equal(normalizeBaseUrl('  192.168.1.50:8000  '), 'http://192.168.1.50:8000')
    assert.equal(normalizeBaseUrl('http://box:8000/'), 'http://box:8000')
    assert.equal(normalizeBaseUrl('https://box:8000///'), 'https://box:8000')
    assert.equal(normalizeBaseUrl(''), '')
  })
})
