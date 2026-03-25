#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${ZENMUX_API_KEY:-}" ]]; then
  echo "ZENMUX_API_KEY is required" >&2
  exit 1
fi

echo "Running ZenMux smoke benchmark against demo dataset..."

npm run cli -- \
  --config providers \
  --manifest examples/demo-dataset/dataset.manifest.json \
  --reference-sidecar \
  --db artifacts/asrbench.sqlite \
  run:once \
  --providers zenmux-gemini-chat \
  --input examples/demo-dataset \
  --rounds 1
