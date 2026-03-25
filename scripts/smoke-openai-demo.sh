#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is required" >&2
  exit 1
fi

echo "Running OpenAI-compatible smoke benchmark against demo dataset..."

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/smoke/openai-${STAMP}"
mkdir -p "$OUT_DIR"
LOG_PATH="$OUT_DIR/run.log"
FAIL_LOG="$OUT_DIR/failure.log"

{
  echo "== OpenAI smoke run =="
  echo "timestamp=$STAMP"
  echo "output_dir=$OUT_DIR"
} | tee "$LOG_PATH"

if ! npm run cli -- \
  --config examples/demo-provider \
  --manifest examples/demo-dataset/dataset.manifest.json \
  --reference-sidecar \
  --db "$OUT_DIR/asrbench.sqlite" \
  run:once \
  --providers openai-whisper-demo \
  --input examples/demo-dataset \
  --rounds 1 | tee -a "$LOG_PATH"; then
  echo "Smoke run failed. See $LOG_PATH" | tee "$FAIL_LOG" >&2
  exit 1
fi

echo "Smoke run succeeded. Log: $LOG_PATH" | tee -a "$LOG_PATH"
