import { session } from 'electron'
import { isDev } from './config'
import { listProviders } from './providers/config'
import { logger } from './logger'

/**
 * Origins of every configured remote provider.
 *
 * `connect-src` otherwise allows only localhost/127.0.0.1, which silently kills the entire
 * remote-provider feature: `backendFetch` runs in the renderer, so a backend on another
 * machine is blocked before the request leaves. Nothing outside the renderer is subject to
 * this — the main process's artifact transfers and any Node-side script are unaffected —
 * so it fails only in the app, and only for the LAN case.
 *
 * Every *configured* provider is allowed rather than just the active one, so switching
 * between saved backends needs no reload. Adding a new one does; see the reload in
 * `ipc/provider-handlers.ts`.
 */
function providerOrigins(): string[] {
  const origins = new Set<string>()
  for (const provider of listProviders()) {
    if (provider.kind !== 'remote-http' || !provider.baseUrl) continue
    try {
      origins.add(new URL(provider.baseUrl).origin)
    } catch {
      logger.warn(`Skipping malformed provider base URL in CSP: ${provider.baseUrl}`)
    }
  }
  return [...origins]
}

// Enforce Content Security Policy via response headers (tamper-proof from renderer)
export function setupCSP(): void {
  // img-src/media-src allow https://videos.ltx.io and https://storage.googleapis.com because
  // the LoRA library plays remote demo clips and thumbnails (catalog entries'
  // media.demo_video / media.thumbnail) hosted on those CDNs.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Recomputed per response so a provider added since launch is covered on the next
    // document load, without restarting the app.
    const remotes = providerOrigins()
    const connectSrc = [
      "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
      ...remotes,
    ].join(' ')

    const csp = isDev
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          connectSrc,
          "img-src 'self' data: blob: file: https://storage.googleapis.com",
          "media-src 'self' blob: file: https://videos.ltx.io https://storage.googleapis.com",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join('; ')
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          connectSrc,
          "img-src 'self' data: blob: file: https://storage.googleapis.com",
          "media-src 'self' blob: file: https://videos.ltx.io https://storage.googleapis.com",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join('; ')

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}
