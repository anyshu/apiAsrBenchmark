#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is required" >&2
  exit 1
fi

echo "Running OpenAI-compatible smoke benchmark against demo dataset..."

npm run cli -- \
  --config examples/demo-provider \
  --manifest examples/demo-dataset/dataset.manifest.json \
  --reference-sidecar \
  --db artifacts/asrbench.sqlite \
  run:once \
  --providers openai-whisper-demo \
  --input examples/demo-dataset \
  --rounds 1
