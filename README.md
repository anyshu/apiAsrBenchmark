# audioApibench

API-based audio ASR benchmark scaffold with pluggable providers, sustained execution controls, SQLite persistence, and a lightweight local web UI.

## Current status

Current implementation includes:
- TypeScript project scaffold
- provider config loader (single file or provider directory)
- `openai_compatible` adapter
- `zenmux` adapter
- `custom_http` adapter
- provider switcher for runtime routing
- `audio_transcriptions`, `chat_completions_audio`, and `responses_audio` request shapes
- provider-level `retry_policy` and `runner_options`
- `provider:list`, `provider:validate`, `run:once`, `run:duration`, `run:list`, `run:show`, `run:export`, and `ui:serve` CLI commands
- JSONL / JSON / CSV artifact generation
- SQLite run persistence
- dataset manifest loading from `dataset.manifest.json`, `manifest.json`, or `--manifest`
- sidecar or external reference transcript loading
- WER / CER scoring
- minimal local web dashboard over SQLite, with run filters, validated web run creation, background jobs, cancellation, attempt filters, transcript diff, and manifest metadata display

## Install

```bash
npm install
```

## Provider config layout

Providers live as independent config files under `/Users/hc/working/github/audioApibench/providers`.

Current examples:
- `/Users/hc/working/github/audioApibench/providers/custom-http-example.yaml`
- `/Users/hc/working/github/audioApibench/providers/openai-whisper.yaml`
- `/Users/hc/working/github/audioApibench/providers/zenmux-gemini-chat.yaml`
- `/Users/hc/working/github/audioApibench/providers/zenmux-mimo-chat.yaml`

Recommended provider fields:

```yaml
provider_id: zenmux-gemini-chat
name: ZenMux Gemini Audio Chat
type: zenmux
base_url: https://zenmux.ai/api/v1
api_key_env: ZENMUX_API_KEY
default_model: google/gemini-2.5-pro
retry_policy:
  max_attempts: 2
  backoff_ms: 500
runner_options:
  concurrency: 1
  interval_ms: 200
adapter_options:
  operation: chat_completions_audio
  chat_path: /chat/completions
  text_prompt: Please transcribe this audio faithfully. Return plain text only.
  audio_format: wav
```

This layout keeps provider onboarding config-driven: new providers usually require a new YAML file, not code edits.

## CLI usage

List providers:

```bash
ZENMUX_API_KEY=... OPENAI_API_KEY=... npm run cli -- provider:list
```

Dry-run validate one provider:

```bash
OPENAI_API_KEY=... npm run cli -- provider:validate \
  --provider openai-whisper \
  --audio test/fixtures/sample.wav \
  --dry-run
```

Run one benchmark pass and write SQLite + artifacts:

```bash
ZENMUX_API_KEY=... npm run cli -- \
  --db artifacts/asrbench.sqlite \
  run:once \
  --providers zenmux-gemini-chat \
  --input /path/to/audio-dir \
  --rounds 3
```

Attach dataset metadata and references from a manifest:

```bash
ZENMUX_API_KEY=... npm run cli -- \
  --manifest /path/to/audio-dir/dataset.manifest.json \
  run:once \
  --providers zenmux-gemini-chat \
  --input /path/to/audio-dir
```

Run a sustained benchmark with default global scheduling:

```bash
ZENMUX_API_KEY=... npm run cli -- \
  --db artifacts/asrbench.sqlite \
  run:duration \
  --providers zenmux-gemini-chat \
  --input /path/to/audio-dir \
  --duration-ms 30000 \
  --concurrency 2 \
  --interval-ms 100
```

Enable sidecar references (`sample.wav` -> `sample.txt`) and compute WER/CER:

```bash
OPENAI_API_KEY=... npm run cli -- \
  --reference-sidecar \
  run:once \
  --providers openai-whisper \
  --input /path/to/audio-dir
```

Use a separate reference directory with mirrored relative paths:

```bash
OPENAI_API_KEY=... npm run cli -- \
  --reference-dir /path/to/references \
  run:duration \
  --providers openai-whisper \
  --input /path/to/audio-dir \
  --duration-ms 20000
```

Start the local dashboard:

```bash
npm run cli -- --db artifacts/asrbench.sqlite ui:serve --port 3000
```

The dashboard now supports:
- run filtering by provider / mode / failures / search text
- starting `run:once` or `run:duration` jobs from the browser
- non-blocking background job polling for browser-triggered runs
- cooperative cancellation for queued / running browser jobs
- inline form validation and structured field errors
- demo dataset shortcuts for quickly filling the form
- provider capability cards showing type / operation / timestamp support
- provider / status / text filters
- min latency / min WER thresholds
- sorting by latency / WER / retries / recency
- built-in latency / WER / failure bar charts
- failure diagnostics on the selected attempt
- manifest metadata (`language`, `speaker`, `tags`) in attempt views
- raw attempt artifact inspection
- side-by-side reference vs hypothesis diff chips

List recent runs from SQLite:

```bash
npm run cli -- --db artifacts/asrbench.sqlite run:list --limit 10
```

Filter runs by provider / mode / failures / time:

```bash
npm run cli -- --db artifacts/asrbench.sqlite run:list \
  --provider openai-whisper \
  --mode once \
  --failures no \
  --created-after 2026-03-25T00:00:00Z \
  --query samples
```

Show one run summary:

```bash
npm run cli -- --db artifacts/asrbench.sqlite run:show --run-id <run-id>
```

Show one run with attempts:

```bash
npm run cli -- --db artifacts/asrbench.sqlite run:show --run-id <run-id> --attempts
```

Export one run:

```bash
npm run cli -- --db artifacts/asrbench.sqlite run:export --run-id <run-id> --format csv --output exports/run.csv
```

## Artifacts and persistence

Each run still writes file artifacts under `artifacts/runs/<run-id>/`:
- `attempts.jsonl`
- `summary.json`
- `summary.csv`
- `raw/*.json`

In addition, summaries and attempts are persisted into SQLite, defaulting to:
- `/Users/hc/working/github/audioApibench/artifacts/asrbench.sqlite`

Optional dataset manifest format:

```json
{
  "items": [
    {
      "path": "speaker-a.wav",
      "reference_text": "optional inline transcript",
      "reference_path": "../refs/speaker-a.txt",
      "language": "zh",
      "speaker": "speaker-a",
      "tags": ["meeting", "far-field"]
    }
  ]
}
```

Notes:
- `path` can be an audio path relative to the input root, or just a filename
- manifest metadata is applied before sidecar / `--reference-dir`, so those sources can still fill missing references
- `reference_path` is resolved relative to the manifest file location

## Demo assets

For a quick smoke test, the repo includes:
- `/Users/hc/working/github/audioApibench/examples/demo-dataset`
- `/Users/hc/working/github/audioApibench/examples/demo-provider`
- `/Users/hc/working/github/audioApibench/scripts/smoke-openai-demo.sh`
- `/Users/hc/working/github/audioApibench/scripts/smoke-zenmux-demo.sh`

Smoke scripts now:
- create isolated output directories under `artifacts/smoke/*`
- write `run.log`
- write `failure.log` when the benchmark command fails

Example:

```bash
OPENAI_API_KEY=... npm run cli -- \
  --config examples/demo-provider \
  --manifest examples/demo-dataset/dataset.manifest.json \
  --reference-sidecar \
  run:once \
  --providers openai-whisper-demo \
  --input examples/demo-dataset
```

## Metrics

Per attempt:
- latency
- HTTP status
- retry count / request attempts
- normalized transcript
- timestamps when provider returns them
- WER / CER when a reference transcript is available

Per run and per provider:
- p50 / p90 / p95 latency
- average RTF when audio duration is known
- total / average retries
- average WER / CER
- failure type counts

## Notes

- secrets are read from `api_key_env` when configured
- auth headers are redacted in request previews
- provider-level `runner_options` override CLI defaults during `run:duration`
- retry policy uses exponential backoff from `retry_policy.backoff_ms`
- ZenMux is modeled as an independent provider type, not only as a generic OpenAI-compatible endpoint
- the local UI uses `GET /api/providers`, `GET /api/provider-capabilities`, `GET /api/demo-assets`, `GET /api/jobs`, `GET /api/jobs/:job_id`, `POST /api/jobs/:job_id/cancel`, `GET /api/runs`, `GET /api/runs/:run_id`, `GET /api/runs/:run_id/export`, `GET /api/runs/:run_id/attempts/:attempt_id/raw`, and `POST /api/run`
