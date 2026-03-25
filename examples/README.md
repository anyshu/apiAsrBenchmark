# Examples

## Demo dataset

- `demo-dataset/sample.wav`: small audio fixture for smoke tests
- `demo-dataset/sample.txt`: matching reference transcript
- `demo-dataset/dataset.manifest.json`: dataset metadata for `language`, `speaker`, and `tags`

## Demo provider

- `demo-provider/openai-whisper-demo.yaml`: standalone provider config you can point `--config` at for quick OpenAI-compatible testing
- `demo-provider/openrouter-demo.yaml`: standalone OpenRouter demo config using the current repo default model
- `../scripts/smoke-openai-demo.sh`: smoke benchmark script for a real OpenAI-compatible call, with isolated output dir and logs
- `../scripts/smoke-openrouter-demo.sh`: smoke benchmark script for a real OpenRouter call, using `test/fixtures/real-sample.wav`
- `../scripts/smoke-zenmux-demo.sh`: smoke benchmark script for a real ZenMux call, with isolated output dir and logs

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
