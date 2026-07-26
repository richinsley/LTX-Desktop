#!/usr/bin/env bash
# Run the LTX-Desktop FastAPI backend headless on GPU0 (Blackwell), models/outputs on the SSD.
# OpenAI-style REST API at http://127.0.0.1:${LTX_PORT}/  (docs at /docs, schema at /openapi.json).
#
# Usage:
#   ./run-backend.sh                 # foreground
#   ./run-backend.sh &               # background (or run under tmux/systemd for a durable service)
# Env overrides: LTX_PORT (default 8000), LTX_APP_DATA_DIR (default /home/rich/data/ltx-data), GPU (default 0).
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"           # uv
REPO_DIR="$(cd "$(dirname "$0")" && pwd)/repo"
export LTX_APP_DATA_DIR="${LTX_APP_DATA_DIR:-/home/rich/data/ltx-data}"   # models + outputs (SSD)
export LTX_PORT="${LTX_PORT:-8000}"
export HF_HOME="${HF_HOME:-/home/rich/data/hf}"                            # any HF cache -> SSD
export CUDA_VISIBLE_DEVICES="${GPU:-0}"                                    # Blackwell

cd "$REPO_DIR/backend"
exec uv run python ltx2_server.py
