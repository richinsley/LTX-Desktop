#!/usr/bin/env bash
# Second LTX backend pinned to GPU1 (RTX A5000 24GB, sm_86) for text-to-image (Z-Image-Turbo),
# leaving GPU0 (Blackwell) free for video generation.
#
# The backend selects its CUDA device once at startup, so a second GPU needs a second process.
# CUDA_VISIBLE_DEVICES=1 makes the A5000 appear as cuda:0 to this instance.
# It SHARES the model cache + outputs dir with the GPU0 instance (same LTX_APP_DATA_DIR),
# so Z-Image is downloaded once and visible to both.
#
# 24GB lands in the backend's "streaming_models_loading" tier (15-30GB on CUDA) -- weights
# stream from pinned host RAM rather than sitting fully resident. Expect slower first load.
#
# Usage:
#   ./run-backend-gpu1.sh              # foreground, port 8001
#   LTX_PORT=9000 ./run-backend-gpu1.sh
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"           # uv
REPO_DIR="$(cd "$(dirname "$0")" && pwd)/repo"
export LTX_APP_DATA_DIR="${LTX_APP_DATA_DIR:-/home/rich/data/ltx-data}"   # shared with GPU0 instance
export LTX_PORT="${LTX_PORT:-8001}"                                       # NOT 8000 -- avoid the GPU0 backend
export HF_HOME="${HF_HOME:-/home/rich/data/hf}"
export CUDA_VISIBLE_DEVICES="${GPU:-1}"                                   # A5000

cd "$REPO_DIR/backend"
exec uv run python ltx2_server.py
