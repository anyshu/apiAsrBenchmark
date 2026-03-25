# Examples

## Demo dataset

- `demo-dataset/sample.wav`: small audio fixture for smoke tests
- `demo-dataset/sample.txt`: matching reference transcript
- `demo-dataset/dataset.manifest.json`: dataset metadata for `language`, `speaker`, and `tags`

## Demo provider

- `demo-provider/openai-whisper-demo.yaml`: standalone provider config you can point `--config` at for quick OpenAI-compatible testing

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
