# audioApibench

API-based audio ASR benchmark scaffold.

## Current status

Current first-pass implementation includes:
- TypeScript project scaffold
- provider config loader (single file or provider directory)
- `openai_compatible` adapter
- `zenmux` adapter
- `custom_http` adapter
- `audio_transcriptions` request mode
- `chat_completions_audio` request mode
- ZenMux-compatible chat audio validation path
- `provider:list` CLI command
- `provider:validate` CLI command
- `run:once` CLI command
- dry-run request preview
- basic adapter tests

## Install

```bash
npm install
```

## Provider config layout

Providers now live as independent config files under `/Users/hc/working/github/audioApibench/providers`.

Current examples:
- `/Users/hc/working/github/audioApibench/providers/custom-http-example.yaml`
- `/Users/hc/working/github/audioApibench/providers/openai-whisper.yaml`
- `/Users/hc/working/github/audioApibench/providers/zenmux-gemini-chat.yaml`
- `/Users/hc/working/github/audioApibench/providers/zenmux-mimo-chat.yaml`

This is the preferred layout because adding or changing a provider should only require editing config, not code.

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

Validate a ZenMux-style chat audio provider:

```bash
ZENMUX_API_KEY=... npm run cli -- provider:validate \
  --provider zenmux-gemini-chat \
  --audio /path/to/sample.wav \
  --dry-run
```

Run one benchmark pass:

```bash
ZENMUX_API_KEY=... npm run cli -- run:once \
  --providers zenmux-gemini-chat \
  --input /path/to/audio-dir \
  --rounds 3
```

Run a sustained benchmark:

```bash
ZENMUX_API_KEY=... npm run cli -- run:duration \
  --providers zenmux-gemini-chat \
  --input /path/to/audio-dir \
  --duration-ms 30000 \
  --concurrency 2 \
  --interval-ms 100
```

Validate a custom HTTP provider:

```bash
CUSTOM_HTTP_API_KEY=... npm run cli -- provider:validate \
  --provider custom-http-demo \
  --audio /path/to/sample.wav \
  --dry-run
```

## Notes

- `provider:validate` writes a validation report to `artifacts/providers/<provider-id>.validation.json`
- `run:once` writes run artifacts under `artifacts/runs/<run-id>/`
- `run:once` now supports `--rounds` and writes both `summary.json` and `summary.csv`
- `run:duration` supports `--duration-ms`, `--concurrency`, and `--interval-ms`
- summary now includes per-provider aggregates, p50/p90/p95 latency, failure type counts, and `rtf` when audio duration is available
- secrets are read from `api_key_env` when configured
- request previews redact auth headers before writing reports
- the default CLI config path is the provider directory `/Users/hc/working/github/audioApibench/providers`
- ZenMux is now modeled as an independent provider type in config
- provider routing now goes through a provider switcher, which chooses between generic `openai_compatible` and provider-specific implementations such as `zenmux`
