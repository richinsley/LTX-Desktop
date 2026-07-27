# Backend providers

## What this changes

Upstream LTX Desktop has exactly one backend. Electron spawns `backend/ltx2_server.py`, scrapes
`Server running on http://127.0.0.1:<port>` from its stdout, hands the renderer that URL plus a
per-session token, and every request goes there. The arrangement is invisible because it is the
only one: `frontend/lib/backend.ts` asks `window.electronAPI.getBackend()` for a URL and never asks
where it came from.

This branch keeps that as the default and adds the ability to point the same app at an LTX backend
running somewhere else — typically a workstation with a much larger GPU than the machine the UI is
on. Nothing on the default path changes: with no provider configured, the code takes the same
branch it always did.

The win is not output quality. It is control: the app can send generation to hardware you own,
report that hardware's real capabilities rather than a hardcoded table, and refuse a request the
provider has said it cannot serve — with the same interface available later to other models or
vendors.

> **Note: Spellbound storage is intentionally not implemented in this branch.** The storage boundary
> (`materialize` → `persist`) exists and is used, but only the local-gallery store is built. A
> Spellbound store cannot be added behind this interface as it stands, because `ProjectAsset.path` is
> still a local-file assumption across the **timeline, exporter and thumbnailer** — each of them opens
> that path directly. Spellbound addresses content by (project, sub-stream, frame range), so `persist`
> would have to return a reference richer than a path, and every one of those consumers would have to
> stop assuming a file. That is a change to the asset model, not an adapter, and it belongs in its own
> branch. See [Storage boundary](#storage-boundary-and-why-spellbound-stops-here) below.

## The seam

One thing distinguishes providers, and everything else follows from it: **the backend's filesystem
may not be yours.** The API speaks in absolute paths — a generation returns `video_path`, and
conditioning inputs are passed as `imagePath` / `audioPath`. Those are unambiguous only when client
and backend share a disk.

So a provider is a URL, a token, and a statement about how files cross between the two machines:

```ts
interface BackendProvider {
  id: string                      // 'ltx-local' is the built-in one
  name: string
  kind: 'managed-local' | 'remote-http'
  baseUrl?: string                // remote only; the local one is discovered at spawn
  authToken?: string              // the backend's LTX_AUTH_TOKEN, if it has one
  artifactTransport: 'local-path' | 'http-download' | 'mapped-path'
  pathMap?: { remoteRoot: string; localRoot: string }   // for 'mapped-path'
}
```

`shared/providers.ts` holds the contract, because both processes need it: the main process owns
config, health and file transfer; the renderer needs capabilities so it can refuse an impossible
request before spending a round trip.

### Where each piece lives

| Concern | File |
|---|---|
| Types, capability check, URL normalisation | `shared/providers.ts` |
| Which providers exist, which is active | `electron/providers/config.ts` → `<userData>/backend-providers.json` |
| Probing what a provider can do | `electron/providers/capabilities.ts` |
| Moving files both directions | `electron/providers/artifacts.ts` |
| Storage boundary (materialize → persist) | `electron/storage/output-store.ts` |
| IPC | `electron/ipc/provider-handlers.ts` |
| Lifecycle dispatch | `electron/python-backend.ts` (`startPythonBackend`) |
| UI | `frontend/components/settings/BackendProviderSection.tsx` (Settings → Backend) |
| Preflight + input staging | `frontend/lib/providers.ts` (`preflightFeature`), called from all five generation hooks |
| Backend file endpoints | `backend/_routes/artifacts.py` |

`checkFeature` / `preflightFeature` gate the non-matrix features — see
[the preflight table](#every-path-that-spends-gpu-goes-through-the-same-preflight).

`startPythonBackend()` keeps its name and its IPC entry point. For the local provider it is the
upstream spawn path unchanged; for a remote one it stops any local backend still holding the GPU
and health-checks the URL instead. There is no process to own, so ownership stays `null` and the
liveness monitor stays off — SIGTERM is not available across a network, and repeated probe failures
against a LAN host mean a network blip far more often than a hung backend.

## Capabilities: probed, not assumed

`GET /api/generate/models-specs` already returns the backend's own (model → resolution → fps →
durations) matrix. A provider is asked for it, along with `/health` and `/api/gpu-info`, and the
result carries `source: 'probed' | 'declared'`. `declared` means the provider did not answer and
these are static LTX defaults — a guess, and the UI says so rather than presenting it as fact.

`checkCapability()` runs in the renderer before `POST /api/generate`. The backend validates
independently (422 `INVALID_VIDEO_GENERATION_SPEC`); the point of checking twice is the message.
"720p at 60s is not supported on this provider. Supported: 5, 6, 8, 10." beats a bare 422 from a
machine whose logs you may not be able to see. A provider that reports no matrix at all is not
second-guessed — the request goes through and the backend answers.

This matters more than it looks. The 10s/720p ceiling is a *policy table for 16–24GB cards*
(`runtime_config/model_download_specs.py`), not a model limit. A 72GB box serves the same route with
a different matrix, and the app now shows that box's answer.

The preflight also refuses `ARTIFACT_TRANSFER_UNSUPPORTED`: an `http-download` provider that has no
`/api/artifacts/*` (an older backend) is stopped *before* generating, rather than spending GPU time
and failing at import. Note this guard runs ahead of the model/resolution/duration checks, so a test
asserting a refusal must assert the *code* — "something was rejected" would also be satisfied by this
one.

## Artifact transfer

Three new endpoints, all bounded to directories the backend owns:

- `GET /api/artifacts/capabilities` — presence is the signal. An older backend answers 404 and the
  client reports `artifactTransfer: false` rather than failing later at import time.
- `GET /api/artifacts/download?path=…` — stream a generated file back.
- `POST /api/artifacts/upload` — accept a conditioning input, return the path to pass as
  `imagePath` / `audioPath`.

Reads are confined to `outputs/` and `uploads/`, checked **after** `Path.resolve()` so neither `..`
nor a symlink planted in `outputs/` escapes. There is deliberately no general file-read endpoint:
the token gates *who* may call, and the bounds gate *what* they can reach, so a leaked token cannot
be turned into a read of the whole disk. `tests/test_artifacts.py` covers both refusals.

`mapped-path` is the alternative for an NFS/SMB setup: no bytes move, the path prefix is rewritten,
and a path outside the mapped root is an error rather than a lucky local hit.

## Two things that only bite in the app

Neither shows up in `scripts/provider-smoke.ts` or in any Node-side test, because both are
properties of the *renderer* — which is also where every backend call actually originates.

**CSP.** `electron/csp.ts` allows `connect-src` to localhost and 127.0.0.1 only. `backendFetch`
runs in the renderer, so without a change there a LAN backend is blocked before the request leaves
the process — while the main process's own transfers and any script keep working, so it looks like
the app is broken rather than the policy. `connect-src` is now built from every configured
provider's origin. CSP is delivered as a header on the document response, so a newly added origin
needs a document load: `upsertBackendProvider` reloads the window, and the UI says so.

**Bootstrap.** Provider settings used to live only in Settings, which is unreachable until a backend
is alive. On a machine that cannot run the models — a laptop, i.e. exactly who wants a remote
provider — first launch spawns the local backend, it dies, and the full-screen failure page offered
only logs and Restart. The provider panel now renders on that page too.

The required-models gate needs nothing special: it asks the backend over HTTP
(`getLtxRecommendation` / `getImgGenRecommendation`), so a remote provider that has the models
satisfies it.

## Serving on the LAN

The backend binds `127.0.0.1` unless `LTX_HOST` says otherwise. `LTX_HOST=0.0.0.0` with no
`LTX_AUTH_TOKEN` **refuses to start** — a non-loopback bind without a token is an unauthenticated
generation endpoint on the network, and the artifact route would serve every file under `outputs/`
to anyone who can reach the port. Set a token, or bind loopback and use an SSH tunnel.

```bash
LTX_HOST=0.0.0.0 LTX_PORT=8000 LTX_AUTH_TOKEN="$(openssl rand -hex 32)" \
  LTX_APP_DATA_DIR=/path/to/data python ltx2_server.py
```

Then Settings → Backend → add `http://<host>:8000` with that token, Test connection, Add, select.

## Verifying it

```bash
node scripts/provider-smoke.ts --base-url http://127.0.0.1:8000 [--token …]      # no GPU spend
node scripts/provider-smoke.ts --base-url http://box:8000 --token … --generate   # full round trip
```

It walks the real contract — probe, preflight (using the same `checkCapability` the renderer
calls), upload, download, generate, import — against a live backend. Requires Node 24+; it runs
TypeScript directly.

Verified on 2026-07-26 against a backend on this branch: probe reported the card and a probed model
matrix, a 9999s request was refused client-side, the upload/download round trip returned identical
bytes, a `/etc/passwd` read was refused 403, and a 540p/5s generation completed in 36s and imported
back as a valid 960×512 h264, 121 frames, 5.042s. Unauthenticated requests to that backend got 401.

## Storage boundary, and why Spellbound stops here

`electron/storage/output-store.ts` splits what upstream fused into one `copyFileSync`:

```ts
interface OutputStore {
  materialize(reference: string): Promise<string>   // provider reference → local file
  persist(localPath: string, projectId: string): string   // → durable project storage
}
```

The default `local-gallery` store is upstream behaviour exactly. The split is what lets a remote
provider participate without touching the six call sites that import generated assets — they all go
through `addVisualAssetToProject`.

A Spellbound store would be the second implementation, and it is **deliberately not built here**.

The blocker is not the adapter — it is that `ProjectAsset.path` is a local-file assumption held
across the whole app, not just at the import site:

| Consumer | What it assumes about `path` |
|---|---|
| Timeline / monitors (`views/editor/ProgramMonitor.tsx`, `VideoEditorSourceMonitor.tsx`, `VideoEditorAssetsPanel.tsx`, `usePlaybackAudioSync.ts`, `components/VideoPreviewPanel.tsx`) | `pathToFileUrl(path)` yields a `file://` URL a `<video>`/`<audio>` element can play |
| Exporter (`electron/export/export-handler.ts` → `video-filter.ts`, `audio-mix.ts`) | `clip.path` is handed to ffmpeg as `-i` |
| Thumbnailer (`electron/ipc/file-handlers.ts` → `image-utils.ts`, `export/ffmpeg-utils.ts`) | a file on disk to seek a frame out of and downsample |

Spellbound addresses content by (project, sub-stream, frame range) rather than by file, so `persist`
would have to return a reference richer than a path, and each of those three would have to stop
assuming a file. That is a change to the asset model, not an adapter detail, and guessing at it would
produce an interface shaped by neither side. The boundary is where the question becomes visible; that
is as far as it should go until the asset model has an answer.

## Every path that spends GPU goes through the same preflight

Five entry points send work to a provider, and each one first asks the same two questions — can it
run this, and can it hand the result back:

| Entry point | Guard | Inputs staged |
|---|---|---|
| `use-generation.ts` `generate` | `checkCapability` (full matrix) | `imagePath`, `audioPath` |
| `use-generation.ts` `generateImage` | `checkFeature('imageGeneration')` | `editSource` |
| `use-extend.ts` | `checkFeature('extend')` | `videoPath` |
| `use-retake.ts` | `checkFeature('retake')` | `videoPath` |
| `use-ic-lora.ts` | `checkFeature('icLora')` | `videoPath`, `controlVideoPath`, `inputPath`, `referenceImagePath` |

`checkFeature` is `checkCapability` minus the model/resolution/fps/duration axes, which don't apply
to those features. Both delegate to one private `checkProviderUsable`, so the reachability and
artifact-transfer rules have a single definition rather than five drifting copies.

`preflightFeature(feature, inputs)` in `frontend/lib/providers.ts` does both halves in one call.
Inputs are **keyed, not positional**, so each staged path keeps its own type (a required `string`
stays a `string`) and adding an input can't silently shift what a call site destructures.

## Checks

```bash
pnpm typecheck            # ts + electron + py, in parallel
pnpm typecheck:ts         # renderer + shared
pnpm typecheck:electron   # main process + preload + vite config  (added by this branch)
pnpm test:shared          # capability rules, node --test, no framework
pnpm backend:test         # pytest
node scripts/provider-smoke.ts --base-url … [--token …] [--generate]
```

## Known gaps

- **No streaming progress for uploads.** A large conditioning video is a silent wait.
- **The renderer probes capabilities once per request.** Cheap against a local backend, a round trip
  against a remote one; worth caching with invalidation if it shows up in practice.
- **A provider that can't return results can still be selected.** Settings shows "no artifact
  endpoints (results cannot be imported)" on its capability line and every request is refused, but
  nothing blocks the switch itself — deliberate, so an unreachable box can still be inspected.
- **`tsconfig.node.json` remains broken for standalone compilation.** Left alone rather than fixed:
  it is upstream's project reference and `tsconfig.electron.json` supersedes it for checking.
