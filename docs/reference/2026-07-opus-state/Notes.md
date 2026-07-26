<!-- Project: ltx-desktop · part of the RTX PRO 5000 project hub (../Notes.md) · dir: /home/rich/data/sglang_notes/ltx-desktop -->
# LTX-Desktop — Lightricks LTX video generation on the Blackwell box

Repo: https://github.com/Lightricks/LTX-Desktop · Apache-2.0 · latest **v1.1.0** (2026-07-23).
Relevance: pertinent to Teradek + Spellbinder work (programmatic video generation via the local API).

## What it is
Electron desktop app for local **LTX-2.3 (22B)** video generation:
- text-to-video, image-to-video, audio-to-video, video editing ("Retake"), text-to-image, image edit
- LoRA adapters (local mode), AI prompt enhancement (Gemini/local)
- Architecture: **React/TS renderer + Electron main + a local FastAPI Python backend on `http://localhost:8000`**
- Some features are cloud-backed (LTX API for text encoding / Retake, fal for Z-Image, Gemini) — optional, need keys.
  Core local generation runs on the GPU.

## Requirements (Linux)
- Ubuntu 22.04+ x64, NVIDIA GPU **≥16GB VRAM**, NVIDIA driver, 16GB+ RAM, **~160GB disk** for models.
- Install options:
  - Prebuilt: `LTX-Desktop-amd64.deb` (v1.1.0) from GitHub Releases (x86_64; arm64 also has an AppImage).
  - Dev from source: `pnpm setup:dev` then `pnpm dev` — needs Node.js, **Python 3.12+**, git, `pnpm`, `uv`.

## This box — situation & gaps
- GPU0 RTX PRO 5000 72GB Blackwell (sm_120) — VRAM is way over the 16GB min. ✓
- SSD `/home/rich/data` has ~1.2T free for the 160GB models. ✓
- Prereqs: `node` v24 ✓, `git` ✓ — **`pnpm` and `uv` NOT installed** (need `npm i -g pnpm` / uv installer).
- **This is a headless/SSH session (`DISPLAY` unset).** Electron GUI can't render here without a display or a
  virtual framebuffer (xvfb). The **FastAPI backend can run headless** → the practical path for API automation.

## Decisions (made)
- Use: **Both** — headless FastAPI backend for automation (Spellbinder/Teradek) + GUI available for interactive use.
- Install: **dev-from-source** (`pnpm` + `uv`).

## Key facts confirmed from the repo
- **Blackwell IS supported.** `backend/pyproject.toml` pins torch from the **cu128** index (`torch~2.10+cu128`),
  and a comment notes "bundled sm120 kernels for CUDA>=12.8". No SGLang-style toolchain fight expected.
- Real inference packages: `ltx-core` + `ltx-pipelines` from `github.com/Lightricks/LTX-2` (git pins), `diffusers` (git pin).
- **Backend runs standalone headless:** `backend/ltx2_server.py` `__main__` → uvicorn, host 127.0.0.1,
  port `LTX_PORT` (default 8000). Requires env **`LTX_APP_DATA_DIR`** (else it errors).
- **Storage is redirectable:** models → `$LTX_APP_DATA_DIR/models`, outputs → `$LTX_APP_DATA_DIR/outputs`.
  → set `LTX_APP_DATA_DIR=/home/rich/data/ltx-data` (SSD). Backend venv (`backend/.venv`, torch ~5GB) is on the SSD too.

## Setup (dev-from-source)
Prereqs installed: `pnpm` 11.16 (via corepack), `uv` 0.11.31 (`~/.local/bin` — add to PATH). node v24, git present.
```bash
export PATH="$HOME/.local/bin:$PATH"
# 1. Backend (Python) — the API + GPU path:
cd repo/backend && uv sync --extra dev          # torch cu128, ltx-core/pipelines, fastapi, etc.
# 2. Frontend/Electron (for the GUI later):
cd repo && pnpm install
# (or `pnpm setup:dev` does both + a torch-CUDA check)
# 3. Run the backend headless on the SSD data dir:
cd repo/backend && LTX_APP_DATA_DIR=/home/rich/data/ltx-data LTX_PORT=8000 uv run python ltx2_server.py
```
GUI (needs a display or xvfb): `cd repo && pnpm dev`.

## Backend verified on Blackwell ✅
`uv sync` OK (venv `backend/.venv`, 7.5GB, torch **2.10.0+cu128**). torch sees `RTX PRO 5000 72GB Blackwell
sm_120`, arch list includes sm_120, bf16 matmul works. Backend launches headless:
```
LTX_APP_DATA_DIR=/home/rich/data/ltx-data LTX_PORT=8000 HF_HOME=/home/rich/data/hf \
  CUDA_VISIBLE_DEVICES=0 uv run python ltx2_server.py
```
Startup log: Device cuda:0, bfloat16, VRAM 71GB, **SageAttention enabled**, Uvicorn on 127.0.0.1:8000.

## REST API (drive this from Spellbinder/Teradek) — 40 endpoints, key ones:
- **Generate:** `POST /api/generate` (video), `/api/generate-image`, `/api/extend`, `/api/retake`;
  progress `GET /api/generation/progress`; cancel `POST /api/generate/cancel`
- **Models:** `GET /api/models`, `POST /api/models/download` + `GET /api/models/download/progress?sessionId=…`,
  `POST /api/models/check-access`, `GET /api/models/ltx-recommendation`, `POST /api/models/active-ltx-model`
- **Info:** `GET /health`, `/api/gpu-info`, `/api/runtime-policy`; HF auth `/api/auth/huggingface/*`
- Full schema: `curl localhost:8000/openapi.json` (also `/docs`). Saved: `../scratch?` (regenerate anytime).

## Models — un-gated, selective download
Core text-to-video set (from `/api/models/ltx-recommendation`, ~72GB, → SSD):
`ltx-2.3-22b-distilled-1.1` (46GB) + `gemma-3-12b-it-qat-q4_0-unquantized` (25GB) + `ltx-2.3-spatial-upscaler-x2-1.1` (1GB).
`Lightricks/LTX-2.3` + Gemma repos are **not gated** (authorized without HF login). Optional extras: Z-Image-Turbo
(31GB, text-to-image), IC-LoRA control, depth/pose aux → download only if those pipelines are needed (that's the ~160GB).
Note: ~73GB resident estimate ≈ 72GB VRAM → LTX offloads the text encoder after prompt encoding (peak ≈ transformer+VAE); watch VRAM on first gen.

## First generation ✅ (text-to-video works end to end)
`POST /api/generate` with prompt + `resolution:720p, duration:5, fps:24` produced a valid clip:
- **H.264, 1280×704, 24fps, 121 frames, 5.04s, 4.1MB** → `/home/rich/data/ltx-data/outputs/*.mp4`
- **~55s** total (8-step distilled diffusion + upscaler, incl. first-run model load), **peak VRAM 23.5 GiB / 72**.
- Pipeline: Gemma text-encode → 22B transformer → spatial upscaler → mp4. VRAM releases to ~0 between requests.
- "LTX 2.3 Fast" resolution/duration matrix: 540p {5,6,8,10,20s}, 720p {5,6,8,10s}, 1080p {5s} @24fps.
- Request fields (GenerateVideoRequest): `prompt*, resolution, model(=fast), duration, fps, aspectRatio,
  cameraMotion, negativePrompt, seed, imagePath (i2v), audioPath (a2v), audio, loras`.
- Benign: one `ModuleNotFoundError: ltx_pipelines.retake_pipeline` during a memory-patch install — falls back
  cleanly, generation unaffected (only matters for the Retake feature).

## Benchmarks — speed & quality (2026-07-24, `./bench.sh`)
Fixed prompt + `seed:12345`, `model:fast`, 16:9, 24fps. Wall time = full blocking `POST /api/generate`.

| Run | Output | Wall | Peak VRAM | vs realtime |
|---|---|---|---|---|
| 720p / 5s **(cold)** | 1280×704, 121f | **60.1s** | 23.3 GiB | 12.0× |
| 720p / 5s **(warm)** | 1280×704, 121f | **36.1s** | 23.3 GiB | **7.2×** |
| 720p / 10s | 1280×704, 241f | **61.1s** | 26.0 GiB | 6.1× |
| 1080p / 5s | 1920×1088, 121f | **72.0s** | 27.5 GiB | 14.4× |
| 540p / 10s | 960×512, 241f | **39.6s** | 24.0 GiB | 4.0× |

- **Model load ≈ 24s** — first gen after backend start pays it (60.1 vs 36.1 warm); models stay resident
  afterwards, so a long-lived backend amortizes it. The earlier "~55s" figure was a *cold* number.
- **Scaling is sub-linear in duration, super-linear in pixels.** Doubling 720p 5s→10s costs only +69%
  (36→61s), but 720p→1080p at 5s costs +99% for 2.3× the pixels. Longer clips are cheap; higher res isn't.
- **VRAM is a non-issue** — 23–27.5 GiB of 72. Room for 1440p/2160p, bigger batches, or co-resident models.
- **Quality is good** (verified on extracted frames): accurate prompt adherence (wardrobe, golden-hour light,
  snow peaks, shallow DOF), clean anatomy/gait, stable background. **10s holds temporal coherence** — no
  identity drift or morphing across 241 frames, continuous camera move.
- **Seed is not resolution-invariant** — same seed at 540p/720p/1080p gives different framings/compositions,
  not the same shot at different sizes. Lock resolution when iterating on a seed.
- Output mp4 is H.264 yuv420p **with a silent AAC track** even at `audio:false` — harmless, but downstream
  muxers should expect a stream-1.

## Max clip length at 720p — **60s works** (upstream caps it at 10s)

**The 10s cap is a policy table, not a model limit.** Two places gate it, both enforced server-side
(HTTP 422 `INVALID_VIDEO_GENERATION_SPEC`, so the pydantic enum is *not* the only check):
- `backend/runtime_config/model_download_specs.py:103` — the `(resolution → fps → durations)` matrix for the
  local distilled model. Upstream: 540p {5,6,8,10,20}, **720p {5,6,8,10}**, 1080p {5}. Validated in
  `backend/api_model_specs.py:164` `validate_generate_video_request`, called from
  `backend/handlers/video_generation_handler.py:88`.
- `backend/api_types.py:343` — `LTXVideoGenDuration` Literal, upstream ceiling 20.

Neither `ltx-core` nor `ltx-pipelines` imposes any frame ceiling; the only pre-flight assert is resolution
divisibility (/64). Frames = `((dur*fps)//8)*8+1` (`backend/frame_math.py:16`), so 60s@24 = 1441 frames, which
satisfies the `(n-1)%8==0` grid. The upstream table is tuned for ~16–24GB cards — irrelevant on 72GB.

**Local patch applied:** `unlock-long-durations.patch` (720p → `{5,6,8,10,12,14,16,18,20,30,45,60}`, Literal
extended to 60). Re-apply after an upstream pull with `git apply ../unlock-long-durations.patch` in `repo/`;
revert with `cd repo && git checkout backend/api_types.py backend/runtime_config/model_download_specs.py`.
The frontend needs no change — it derives dropdowns from `GET /api/generate/models-specs`.

| 720p duration | Frames | Wall | ×realtime | Peak VRAM |
|---|---|---|---|---|
| 5s | 121 | 36.1s | 7.2× | 23.3 GiB |
| 10s | 241 | 61.1s | 6.1× | 25.4 GiB |
| 20s | 481 | 124.6s | 6.2× | 32.5 GiB |
| 30s | 721 | 205.9s | 6.9× | 39.9 GiB |
| 45s | 1081 | 357.1s | 7.9× | 50.0 GiB |
| **60s** | **1441** | **549.5s** | **9.2×** | **60.4 GiB** |

- **VRAM is linear: ~700 MiB per second of video** (above 10s). Extrapolated OOM wall ≈ **76s**;
  **~65s is the safe ceiling** with sane headroom. 60s at 60.4/72 GiB is comfortable but not spacious —
  don't run anything else on GPU0 during a 60s job.
- **Time is super-linear** (~O(n^1.35) — attention). Cost per second of output is flat ~6.1× realtime out to
  20s, then climbs: 6.9× at 30s, 7.9× at 45s, 9.2× at 60s. **20s is the efficiency sweet spot.**
- **Per-frame visual quality holds the whole way** — at 60s/1441 frames the subject keeps its identity, terrain
  and lighting stay consistent, individual frames are sharp and correct.
- **But temporal consistency degrades with length** (see below). Sampled stills cannot detect this; it needs a
  frame-pair metric.
- Untested beyond 60s and at other resolutions; 540p should reach much further (fewer tokens/frame), 1080p far less.

### Temporal consistency vs length — the real cost of long clips
Measured with `temporal.py` (opencv, run via `uv run python` in `repo/backend`): consecutive-frame MAD, optical
flow, global luma/saturation. **Caveat: raw MAD is confounded** — each duration generates a *different shot*
(seed is not duration-invariant), so compare `jerk/MAD` (motion discontinuity per unit of motion), not raw values.

| Clip | MAD (motion) | jerk | **jerk/MAD** |
|---|---|---|---|
| 5s | 1.942 | 0.334 | **0.172** |
| 20s | 0.501 | 0.152 | **0.303** |
| 30s | 1.518 | 0.720 | **0.474** |
| 60s | 1.354 | 0.759 | **0.561** |

- Normalized jerk rises monotonically with length — **~3.3× worse at 60s than 5s**. Motion stutters/pops rather
  than flowing, while each individual frame stays sharp. This matches the subjective read: "visual quality fine,
  temporal consistency isn't."
- **It is NOT drift.** Within-clip normalized jerk by third is flat (30s: .488/.439/.435 · 60s: .534/.560/.575).
  The model spreads a fixed coherence budget over the requested frame count, so the *whole* clip is uniformly
  less stable — trimming the tail doesn't help, and cutting a 60s generation into 20s pieces is worse than
  generating three 20s clips.
- ⇒ **20s is the sweet spot on both axes**: last duration before normalized jerk climbs steeply (.30→.47 at 30s),
  and the point where wall-time per second of output starts rising. **Generate at 20s and stitch.**

## Upstream perf harness (`pnpm perf:dev`) — works, with two setup gotchas
PR #129 (merged 2026-07-23, **already in our clone** — our HEAD *is* that merge) added
`backend/performance_runner/`: soak/leak, fixed-seed PSNR A/B, decompose, cold-start, sanity sweep, dashboard.
It also *introduced* `frame_math.py` and the whole duration matrix we patched — those limits are one day old.

```bash
cd repo && XDG_DATA_HOME=/home/rich/data HF_HOME=/home/rich/data/hf CUDA_VISIBLE_DEVICES=0 pnpm perf:dev
# backend :41954 (auth token auto-generated), dashboard :8750
```
- **Gotcha 1 — it hardcodes the app-data dir.** `scripts/perf-dev.mjs` sets `LTX_APP_DATA_DIR` from an XDG path
  (`$XDG_DATA_HOME/LTXDesktop`), *overriding* whatever you export. Left alone it targets `~/.local/share` on the
  **84%-full system drive** and won't see our models. Fix: `XDG_DATA_HOME=/home/rich/data` +
  `ln -s /home/rich/data/ltx-data /home/rich/data/LTXDesktop` (done). No repo edit needed.
- **Gotcha 2 — no `pnpm install` required.** `perf-dev.mjs` imports only node builtins, so it runs with no
  `node_modules` (we still have none — the Electron GUI would need it).
- Dashboard is **localhost-only**: from a headless session, `ssh -L 8750:127.0.0.1:8750 <host>`.
- CLI works too; the token is `PERF_AUTH_TOKEN`/`LTX_AUTH_TOKEN`, and a backend started **without** a token needs
  none. To drive an already-running `perf:dev` instance, recover its random token from the process env:
  `tr '\0' '\n' < /proc/$(pgrep -f run_dashboard.py)/environ | grep ^PERF_AUTH_TOKEN=`

### ✅ ALL LoRAs installed → sweep **16 pass, 0 fail, 0 skip** (2026-07-24)
Accepted the gate on 10 more `Lightricks/*` repos and downloaded them (7.1GB of IC-LoRAs → `models/ic-loras/<id>/`,
plus cinemagraph → `models/loras/`). Only `cross-eyed` left un-accepted (deliberately). Sweep is now a clean sheet;
`iclora_day_to_night` 20.5s closed the last skip. Max peak 28121 MiB (38% of card), median 0.18× realtime.

**Installed IC-LoRAs** (all usable via `POST /api/ic-lora/generate`): `clean-plate` (remove people/vehicles,
rebuild background — plate prep), `outpainting` (extend frame / change aspect), `deblur`, `decompression`
(artifact removal — archival), `colorization` (grayscale→color), `day-to-night` (relight day-for-night),
`ingredients` (subject consistency from a reference sheet), `water-simulation`, `instant-shave`. Plus the
`cinemagraph-motion` LoRA (selective-motion look).

#### Getting gated downloads working headless (the app's own HF login is OAuth/browser)
`POST /api/{ic-,}loras/download {"use_hf_auth":true}` returns **403 "HuggingFace authentication required"** unless
the app itself is signed in — and its login is a PKCE browser flow. Workaround: the handler persists/loads a token
file, so **seed it directly** and restart the backend (`handlers/hf_auth_handler.py:61` + `load_token()`):
```bash
python3 -c "import json,time,os;p='/home/rich/data/ltx-data/hf_auth_token.json';\
open(p,'w').write(json.dumps({'access_token':open('/home/rich/data/sglang_notes/hftoken.txt').read().strip(),\
'expires_at':time.time()+365*24*3600}));os.chmod(p,0o600)"
```
→ `GET /api/auth/huggingface/status` then reports `authenticated` and gated downloads work. A static `hf_...` read
token works fine in place of an OAuth one. **Gotcha:** the endpoints are `/api/loras/...` and `/api/ic-loras/...` —
omitting `/api` returns a bare 404 that looks like a missing LoRA rather than a bad path.

### (earlier) 2 LoRAs installed → sweep 15 pass, 1 skip
Added `cozy-felt-style` (0.35GB) + `openwheel-tcam-style` (1.35GB) → `models/loras/<id>/`, and cps
`ltx-2.3-22b-ic-lora-union-control-ref0.5` (0.65GB) + `dpt-hybrid-midas` → `models/`.
New passes: `lora_cozy_felt` 28.1s · `lora_cozy_felt_openwheel` 28.5s · **`iclora_canny` 23.9s** ·
**`iclora_depth` 26.5s @24957MiB**. `t2i` dropped to **9.7s** (warm, 0.32Wh). Only `iclora_day_to_night` skips.
- Downloads serialize server-side — a second `POST /api/loras/download` while one runs returns
  `DOWNLOAD_ALREADY_RUNNING`. `/api/loras/download/progress` **requires** `?sessionId=`; without it, 422.

### HF access map (token at `../hftoken.txt`, user `rinsley`, read scope — `chmod 600` it)
Checked every catalog repo by actually range-fetching the weight file (a 200/**206** = reachable; 403 = gated):
- **Reachable (17):** every community repo — all `vrgamedevgirl84/*` styles, `openwheel`, `fpv-motion`,
  `crt-animation-terminal`, `product-ad`, `upscale`, `greenscreen-avatar`, `crossview-prompt`, `3d-render-to-real`.
  Also `Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control` and `Intel/dpt-hybrid-midas` — **not** gated.
- **403 — need one-time license acceptance (12), all first-party `Lightricks/*`:** `IC-LoRA-HDR`, `Day-To-Night`,
  `Clean-Plate`, `Colorization`, `Decompression`, `Deblur`, `Cross-Eyed`, `Water-Simulation`, `Ingredients`,
  `Instant-Shave`, `In-Outpainting`, `LoRA-Cinemagraph`.
  `gated: auto` = **auto-approved on acceptance**, but a read token cannot accept — a human must click
  "Agree and access repository" once per repo while logged in. Then the same token works.
  ⚠ Note the API's `/tree/main` returns 200 even for gated repos (metadata is public) — only fetching the
  **weight file** reveals the 403. Don't trust the tree endpoint as an access check.

### HDR IC-LoRA ✅ WORKING — SDR→HDR conversion to EXR (2026-07-24)
Access granted (the gate is a **contact-sharing/privacy consent**, not a license agreement — "Agree and Access").
Weights → `models/hdr-ic-lora/`. **Ran end to end in 63s** for 720p/121f on GPU0.

```bash
cd repo/backend && CUDA_VISIBLE_DEVICES=0 uv run python -m ltx_pipelines.hdr_ic_lora \
  --input  /home/rich/data/ltx-data/hdr-in  --output-dir /home/rich/data/ltx-data/hdr-out \
  --hdr-lora        $M/hdr-ic-lora/ltx-2.3-22b-ic-lora-hdr-0.9.safetensors \
  --text-embeddings $M/hdr-ic-lora/ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors \
  --distilled-checkpoint-path $M/ltx-2.3-22b-distilled-1.1.safetensors \
  --spatial-upsampler-path    $M/ltx-2.3-spatial-upscaler-x2-1.1.safetensors \
  --num-frames 121 --seed 12345          # (n-1)%8==0;  M=/home/rich/data/ltx-data/models
```
Extra flags: `--high-quality` (2× frames internally, keeps every other — ~2× slower), `--offload none|cpu|disk`,
`--spatial-tile 1280` (lower for less VRAM), `--exr-half` (fp16 EXR), `--skip-mp4`, `--seed`.

**Output:** `<name>_exr/frame_NNNNN.exr` (121 files, **839MB** for 5s — ~7MB/frame float32) + an H.264 **sRGB
preview** mp4. (The module docstring says "tonemapped ProRes .mov"; the installed build writes H.264 mp4 —
transcode to ProRes yourself if the finishing chain needs it.)

**EXR verified genuine HDR** (via OpenImageIO): 1280×704, RGB **float32**, zip, Rec.709/sRGB chromaticities
(0.64/0.33, 0.30/0.60), `colorSpace=sRGB` attr but **linear values**. Range **−0.017 … 17.82** (negatives are
normal post-transform). Measured SDR→HDR tone expansion on frame 0 — a real inverse tone map, not a rescale:

| SDR luma | → HDR linear (mean) |
|---|---|
| 0–32 | 0.005 |
| 96–128 | 0.324 |
| 128–160 | 0.595 |
| 160–192 | **1.156** ← diffuse white ≈1.0 lands near SDR ~175 |
| 192–224 | 4.921 |
| 224–248 | 6.301 |

→ **~3–4 stops of highlight headroom above diffuse white**, shadows rolled to near zero; top 0.1% of pixels sit
6.2 stops above the mid-tone average. Image content/quality is preserved (preview matches the source shot).
Model card: 16-bit HDR, does **both** HDR generation *and* 8-bit SDR → 16-bit HDR conversion; LogC3 transform
pre/post; reference downscale factor 1. Paper: LumiVid, arXiv 2604.11788.

⚠ Note the pipeline **re-generates** rather than purely grading — it's an IC-LoRA conditioned on the source, so
output is a new render aligned to the reference, not a pixel-exact regrade. Check shot-matching before relying
on it for conform.

### (historical) HDR IC-LoRA — blocked on acceptance
`ltx_pipelines/hdr_ic_lora.py` is a **standalone CLI, not wired into the desktop app** (hence absent from
`/api/ic-loras`). It's a two-stage IC-LoRA pipeline whose `__call__` returns a **linear HDR float** tensor via
**LogC3 inverse transform** (ARRI log) → writes **EXR** (`--exr-half` for fp16) plus optional H.264; tonemapping
is the caller's job. Takes an input .mp4 (or a directory) and re-generates it in HDR.
- Weights: `Lightricks/LTX-2.3-22b-IC-LoRA-HDR` → `ltx-2.3-22b-ic-lora-hdr-0.9.safetensors` (327MB) **and**
  `ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors` (12.6MB). The latter is the `--text-embeddings` arg
  **pre-computed**, so the Gemma `PromptEncoder` step in the docstring is unnecessary.
- Everything else is already on disk: `--distilled-checkpoint-path models/ltx-2.3-22b-distilled-1.1.safetensors`
  (46GB) and `--spatial-upsampler-path models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors`.
- **Frame budget by resolution** (from `--help`; fp8_cast + bf16 VAE + tiled decode). Our 72GB sits between their
  two reference cards, so interpolate — 4K should land ~90-110 frames:

  | Resolution | 80GB (H100) | 48GB (A6000) |
  |---|---|---|
  | 720p / 1080p / 2K | 161+ | 161+ |
  | 1440p 2560x1440 | 161+ | 137 |
  | 4K 3840x2160 | 121 | 49 |

  `(frames-1) % 8 == 0` still applies. (`utils.vram_budget.max_frames_for_resolution`, referenced in the help
  text, **does not exist** in the installed package — dead reference, don't rely on it.)
- ⛔ **To unblock:** accept the license at https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-HDR

### Full sweep (`sanity.py`, no `--fast`, 2026-07-24): 12 pass, 0 fail, 5 skip
Real resolutions this time. **Independently reproduces our `bench.sh` numbers to within 0.5%** — two separate
harnesses agreeing is good evidence both measure correctly:

| Scenario | Upstream harness | our `bench.sh` |
|---|---|---|
| t2v 720p/10s | 61.4s, 26603 MiB | 61.1s, 26000 MiB |
| t2v 1080p/5s | 72.3s, 28119 MiB | 72.0s, 28105 MiB |

Other scenarios: 540p/20s 66.5s @26899MiB · 720p 9:16 36.7s · i2v 26.8s · a2v/ia2v 30.8s · extend 58.0s ·
prepend 56.6s · retake 35.9s · **t2i 23.3s @12693MiB**. Max peak 28119 MiB (38% of the card); median 0.17× realtime.
Energy is reported per generation (2.3–5.3 Wh for video, 0.66 Wh for t2i).
- **t2i now PASSES** — the earlier failure was purely the missing Z-Image checkpoint. Its peak on GPU0 (12693 MiB)
  is within 300MiB of its peak on the A5000 (12391 MiB), confirming the CPU-offload footprint is device-independent.
- Remaining 5 SKIPs are LoRA/IC-LoRA weights we haven't fetched. To close them: `cozy-felt-style` (0.35GB),
  `openwheel-tcam-style` (1.35GB), cp `ltx-2.3-22b-ic-lora-union-control-ref0.5` (0.65GB) and `dpt-hybrid-midas`
  (0.5GB) are **un-gated**; `day-to-night` needs **HF login** so it stays skipped without credentials.
  Full catalogs if ever wanted: LoRAs 6.2GB / IC-LoRAs 9.9GB (most IC-LoRAs require HF login).

### Earlier smoke run (`sanity.py --fast`): pass=10 err=1 skip=5
- ✅ t2v (16:9 + 9:16), **i2v, a2v, ia2v, extend, prepend, retake** all PASS — first validation of those paths here.
- ❌ `t2i` HTTP 500 = `Checkpoint not found: z-image-turbo` — the optional 31GB model we chose not to download,
  **not a bug**. (Inconsistent harness: missing LoRAs SKIP cleanly, a missing Z-Image checkpoint fails the verdict.)
- ⏭ 5 LoRA/IC-LoRA scenarios SKIP — weights not downloaded, as expected.
- Peak VRAM 24733 MiB → reported as **">24GB (high-end only)"**; `perf_config.py:314` `CARD_TIERS_GIB = (8,12,16,24)`
  — this card is off the top of their scale, which is exactly why the shipped duration table wastes ~46GB.
- **`--fast` caps EVERY scenario to 540p/5s** regardless of its name — `t2v_720p_10s` and `t2v_1080p_5s` both sent
  `540p/5s` (hence identical 26.2s / 24703MiB). Don't read resolution conclusions from a `--fast` run.
- **Their throughput metric is the reciprocal of ours**: "0.19× realtime" = 5s of video in 26.2s. Our tables use
  wall÷duration (5.3× here). Same measurement, inverted — don't compare the numbers directly.
- Run artifacts + a viewer: `backend/performance_runner/dashboard_runs/sanity_*/index.html`.
- Not yet run: full sweep (no `--fast`), `soak_test.py` (VRAM leak), `coldstart.py`, `output_ab.py` (PSNR).
- **No temporal-consistency metric upstream** — grepped for temporal/flicker/jitter/optical-flow: none. They measure
  PSNR (A/B correctness). Our `temporal.py` covers something their harness doesn't.

## Z-Image text-to-image on the A5000 (GPU1) ✅ — dual-GPU split
Keeps GPU0 (Blackwell) free for video while stills run on GPU1. `./run-backend-gpu1.sh` → **port 8001**,
`CUDA_VISIBLE_DEVICES=1`, **shares** `LTX_APP_DATA_DIR` with the GPU0 instance (models downloaded once).

**31GB on disk does NOT mean 31GB of VRAM.** `Tongyi-MAI/Z-Image-Turbo` (un-gated, 32.9GB, single fp32 variant —
there is no quantized branch to fall back to) breaks down as transformer **24.6GB (fp32 ~6B)**, text_encoder 8.05GB,
vae 0.17GB. Two things in `services/image_generation_pipeline/zit_image_generation_pipeline.py` make it fit 24GB:
- line 40 `torch_dtype=torch.bfloat16` → the fp32 transformer halves to **~12.3GB** on load;
- line 139 `enable_model_cpu_offload()`, called **unconditionally on CUDA** → only the executing submodule is
  resident, the rest sits in host RAM. Peak ≈ largest component, *not* the 32.9GB sum.

**Measured: peak 12,391 MiB on GPU1** — dead on the ~12.3GB prediction, ~12GB of the A5000 still free.
Text-to-image 1024×576 / 4 steps: **57.6s cold, 11.1s warm.** Quality is strong (correct material, subject,
lighting, DOF). Downloaded via `POST /api/models/download {"cp_ids":["z-image-turbo"]}` at ~216MB/s.

**Concurrent dual-GPU verified:** a 720p/5s video on GPU0 and a 1024×576 image on GPU1 launched together both
completed — GPU0 23,161 MiB @100% util, GPU1 12,393 MiB @100% util. Caveat: the pair took 61.1s wall vs 36.1s
for video alone; Z-Image's CPU-offload streaming contends for host RAM/PCIe, and I did not isolate the cause
(the GPU0 backend's warm state also differed). Treat concurrency as *working*, not as *free*.

⚠ **Multi-GPU reporting bug (upstream):** with `CUDA_VISIBLE_DEVICES=1`, the startup banner prints
`GPU: NVIDIA RTX PRO 5000 72GB Blackwell | VRAM: 71 GB` — it reads *physical* GPU0 rather than the CUDA-visible
device. Only `Runtime policy ... vram_gb=23` is correct. So `/api/gpu-info` (which the perf dashboard trusts for
tier/headroom) is **wrong on a multi-GPU box** — don't believe perf-runner VRAM tiers for the GPU1 instance.

## Run it
`./run-backend.sh` (headless backend on :8000; models/outputs on SSD; GPU0). Foreground or `&`/tmux/systemd for durable.
`./run-backend-gpu1.sh` (second instance on :8001, A5000/GPU1 — text-to-image; shares the model dir).
`./bench.sh [outdir]` re-runs the speed/quality matrix against a running backend (writes `results.tsv`).
GUI later: `cd repo && pnpm install` then `pnpm dev` (needs a display or xvfb).

## Progress
- ✅ Prereqs (pnpm/uv), repo cloned, backend `uv sync`, **Blackwell verified (torch 2.10+cu128, sm_120)**.
- ✅ Backend headless on :8000; models/outputs on SSD; core ~72GB models downloaded (un-gated).
- ✅ **First text-to-video generation validated** (720p/5s in ~55s, 23.5GiB peak).
- ✅ **Speed/quality matrix benchmarked** (see above): warm 720p/5s **36s**, 1080p/5s 72s, 720p/10s 61s; ≤27.5GiB.
- ✅ **720p long-clip ceiling found: 60s works** (549s, 60.4GiB, quality intact) via `unlock-long-durations.patch`;
  upstream's 10s cap is a policy table for small cards. Safe ceiling ~65s, OOM ≈76s.
- ⏭ Next: Spellbinder/Teradek API integration (drive `/api/generate` + poll `/api/generation/progress`);
  optionally image-to-video (`imagePath`), higher res/longer at 540p, keep-resident tuning, GUI via display/xvfb.
