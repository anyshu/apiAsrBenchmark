#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is required" >&2
  exit 1
fi

echo "Running OpenRouter smoke benchmark against a real audio fixture..."

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/smoke/openrouter-${STAMP}"
INPUT_DIR="$OUT_DIR/input"
mkdir -p "$INPUT_DIR"
cp test/fixtures/real-sample.wav "$INPUT_DIR/sample.wav"

LOG_PATH="$OUT_DIR/run.log"
FAIL_LOG="$OUT_DIR/failure.log"

{
  echo "== OpenRouter smoke run =="
  echo "timestamp=$STAMP"
  echo "output_dir=$OUT_DIR"
  echo "input_audio=$INPUT_DIR/sample.wav"
} | tee "$LOG_PATH"

if ! npm run cli -- \
  --config examples/demo-provider \
  --db "$OUT_DIR/asrbench.sqlite" \
  run:once \
  --providers openrouter-demo \
  --input "$INPUT_DIR" \
  --rounds 1 | tee -a "$LOG_PATH"; then
  echo "Smoke run failed. See $LOG_PATH" | tee "$FAIL_LOG" >&2
  exit 1
fi

echo "Smoke run succeeded. Log: $LOG_PATH" | tee -a "$LOG_PATH"
