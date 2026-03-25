# Session Reload

This file is a handoff note for the next session.

## Repo

- Path: `/Users/hc/working/github/audioApibench`
- Remote: `git@github.com:anyshu/apiAsrBenchmark.git`
- Current branch: `main`
- Latest pushed commit at handoff: `a66f00d` `feat: add run exports and provider capability views`

## Important repo instruction

- From `AGENTS.md`: `commit 时候都需要更新 spec 文档`

## What is already done

### Core benchmark

- Config-driven provider loading from single file or provider directory
- Provider types:
  - `openai_compatible`
  - `zenmux`
  - `custom_http`
- Provider switcher implemented
- Run modes:
  - `run:once`
  - `run:duration`
- Provider-level retry/backoff/concurrency/interval support
- Artifacts:
  - `attempts.jsonl`
  - `summary.json`
  - `summary.csv`
  - `raw/*.json`
- SQLite persistence for runs and attempts
- CLI query/export commands:
  - `run:list`
  - `run:show`
  - `run:export`

### Accuracy / dataset support

- Sidecar transcript support
- Reference-dir support
- WER / CER calculation
- Dataset manifest support:
  - auto-discover `dataset.manifest.json` or `manifest.json`
  - explicit `--manifest`
  - metadata fields:
    - `language`
    - `speaker`
    - `tags`
    - `reference_text`
    - `reference_path`
- Manifest metadata now persists into attempts as:
  - `audio_language`
  - `audio_speaker`
  - `audio_tags`
  - `audio_reference_path`

### Local Web UI

- Run list filters
- Attempt filters
- Transcript diff view
- Raw attempt artifact view
- Run creation form
- Background async run jobs
- Job polling
- Job cancellation
- Job progress bar / current attempt summary
- Job retry history snippet
- Run export buttons:
  - JSON
  - JSONL
  - CSV
- Provider capability panel
- Demo dataset / provider shortcut buttons

### Demo / smoke assets

- Demo dataset:
  - `/Users/hc/working/github/audioApibench/examples/demo-dataset`
- Demo provider:
  - `/Users/hc/working/github/audioApibench/examples/demo-provider`
- Smoke scripts:
  - `/Users/hc/working/github/audioApibench/scripts/smoke-openai-demo.sh`
  - `/Users/hc/working/github/audioApibench/scripts/smoke-zenmux-demo.sh`
- Smoke scripts now create isolated output dirs under `artifacts/smoke/*` and write:
  - `run.log`
  - `failure.log` on failure

## Main files touched recently

- `/Users/hc/working/github/audioApibench/src/services/uiServer.ts`
- `/Users/hc/working/github/audioApibench/src/services/runOnceService.ts`
- `/Users/hc/working/github/audioApibench/src/services/runDurationService.ts`
- `/Users/hc/working/github/audioApibench/src/services/providerExecution.ts`
- `/Users/hc/working/github/audioApibench/src/services/benchmarkArtifacts.ts`
- `/Users/hc/working/github/audioApibench/src/services/datasetManifest.ts`
- `/Users/hc/working/github/audioApibench/src/domain/types.ts`
- `/Users/hc/working/github/audioApibench/test/uiServer.test.ts`
- `/Users/hc/working/github/audioApibench/README.md`
- `/Users/hc/working/github/audioApibench/spec/requirements.md`
- `/Users/hc/working/github/audioApibench/spec/design.md`
- `/Users/hc/working/github/audioApibench/spec/interface-design.md`
- `/Users/hc/working/github/audioApibench/spec/ui-design.md`

## Current API/UI surface

### UI endpoints

- `GET /api/providers`
- `GET /api/provider-capabilities`
- `GET /api/demo-assets`
- `GET /api/jobs`
- `GET /api/jobs/:job_id`
- `POST /api/jobs/:job_id/cancel`
- `GET /api/runs`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/export?format=json|jsonl|csv`
- `GET /api/runs/:run_id/attempts/:attempt_id/raw`
- `POST /api/run`

### CLI reminders

- Provider list:
  - `npm run cli -- provider:list`
- Run once:
  - `npm run cli -- --manifest <path> run:once --providers <id> --input <dir>`
- Run duration:
  - `npm run cli -- --manifest <path> run:duration --providers <id> --input <dir> --duration-ms 30000`
- UI:
  - `npm run cli -- --config examples/demo-provider --db artifacts/asrbench.sqlite ui:serve --port 3000`

## Validation status at handoff

Last verified successfully:

- `npm run check`
- `npm test`
- `bash -n /Users/hc/working/github/audioApibench/scripts/smoke-openai-demo.sh /Users/hc/working/github/audioApibench/scripts/smoke-zenmux-demo.sh`

## Not yet done / open ideas

These were discussed or are logical next steps, but are not implemented yet:

1. Provider capability matrix page
   - Show support across:
     - `audio_transcriptions`
     - `chat_completions_audio`
     - `responses_audio`
   - Possibly indicate recommended operation per provider

2. Failed sample export
   - Export only failed attempts or high-WER attempts from UI

3. Run comparison page
   - Compare two runs by:
     - latency
     - WER/CER
     - failure counts
     - retry counts

4. Smoke report generation
   - After smoke script completes, auto-extract latest `run_id`
   - Generate a compact summary report in the smoke output directory

5. Richer job diagnostics
   - Better backoff visualization instead of raw retry JSON
   - Show retry delay estimates or derived backoff timeline

6. Optional async task persistence
   - Jobs are currently in-memory for UI server lifetime
   - Could persist job metadata if the UI server restarts matter

## Known implementation notes

- Job cancellation is cooperative, not hard-abort:
  - it stops at request/retry boundaries
  - an in-flight HTTP request is not forcibly terminated
- UI jobs are in memory only
- Provider capability summary is currently lightweight/inferred, not a deep runtime probe
- Export downloads come from SQLite-backed run detail, not directly from artifact files

## Suggested next-session starting points

If continuing feature work, a good order is:

1. build a provider capability matrix
2. add failed-attempt export from UI
3. add run-vs-run comparison page
4. enhance smoke scripts to emit a summary report

## Quick smoke commands

### OpenAI demo

```bash
cd /Users/hc/working/github/audioApibench
OPENAI_API_KEY=... ./scripts/smoke-openai-demo.sh
```

### ZenMux demo

```bash
cd /Users/hc/working/github/audioApibench
ZENMUX_API_KEY=... ./scripts/smoke-zenmux-demo.sh
```

### Start UI with demo provider

```bash
cd /Users/hc/working/github/audioApibench
npm run cli -- --config examples/demo-provider --db artifacts/asrbench.sqlite ui:serve --port 3000
```
