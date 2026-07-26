#!/usr/bin/env bash
# Drive the LTX backend through a test matrix; report wall time + peak VRAM per generation.
# Usage: ./bench.sh [outdir]   (backend must already be running -- see run-backend.sh)
set -uo pipefail

API="${API:-http://127.0.0.1:8000}"
OUT="${1:-/tmp/ltx-bench}"
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
printf 'label\tresolution\tduration\tfps\tseconds\tpeak_vram_MiB\tfile\n' > "$RESULTS"

# one generation: label prompt resolution duration fps seed [extra json]
gen() {
  local label="$1" prompt="$2" res="$3" dur="$4" fps="$5" seed="$6" extra="${7:-}"
  local body
  body=$(python3 -c '
import json,sys
label,prompt,res,dur,fps,seed,extra = sys.argv[1:8]
d = {"prompt":prompt,"resolution":res,"duration":int(dur),"fps":int(fps),
     "seed":int(seed),"model":"fast","aspectRatio":"16:9"}
if extra: d.update(json.loads(extra))
print(json.dumps(d))' "$label" "$prompt" "$res" "$dur" "$fps" "$seed" "$extra")

  echo "=== $label : $res / ${dur}s / ${fps}fps ==="
  echo "    req: $body"

  # sample VRAM in the background for the duration of the call
  local vf="$OUT/$label.vram"
  ( while true; do nvidia-smi --id=0 --query-gpu=memory.used --format=csv,noheader,nounits; sleep 1; done > "$vf" ) &
  local vpid=$!

  local t0 t1 resp
  t0=$(date +%s.%N)
  resp=$(curl -s -X POST "$API/api/generate" -H 'Content-Type: application/json' -d "$body")
  t1=$(date +%s.%N)
  kill $vpid 2>/dev/null; wait $vpid 2>/dev/null

  local secs peak file
  secs=$(python3 -c "print(f'{$t1-$t0:.1f}')")
  peak=$(sort -n "$vf" | tail -1)
  file=$(python3 -c '
import json,sys
try:
    r=json.loads(sys.stdin.read())
    print(r.get("videoPath") or r.get("path") or r.get("outputPath") or json.dumps(r)[:200])
except Exception as e:
    print("PARSE_FAIL")' <<<"$resp")

  echo "    -> ${secs}s  peak ${peak} MiB  $file"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$res" "$dur" "$fps" "$secs" "$peak" "$file" >> "$RESULTS"
  echo "$resp" > "$OUT/$label.json"
}

PROMPT="A lone hiker in a red jacket walks along a rocky ridgeline at golden hour, wind moving the grass, distant snow-capped peaks, cinematic wide shot, shallow depth of field"

gen  720p_5s   "$PROMPT" 720p  5  24 12345
gen  1080p_5s  "$PROMPT" 1080p 5  24 12345
gen  540p_10s  "$PROMPT" 540p  10 24 12345
gen  720p_10s  "$PROMPT" 720p  10 24 12345

echo
echo "=== summary ==="
column -t -s $'\t' "$RESULTS"
