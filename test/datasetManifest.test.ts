import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyDatasetManifest } from '../src/services/datasetManifest.js';
import { collectAudioAssets } from '../src/utils/audio.js';

async function createTempAudioFile(dir: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  const sampleRate = 16000;
  const durationSeconds = 1;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = sampleRate * durationSeconds * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  await fs.writeFile(filePath, buffer);
  return filePath;
}

test('dataset manifest enriches audio assets with metadata and reference text', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-manifest-'));
  const audioDir = path.join(tempRoot, 'audio');
  const refsDir = path.join(tempRoot, 'refs');
  await fs.mkdir(audioDir, { recursive: true });
  await fs.mkdir(refsDir, { recursive: true });

  await createTempAudioFile(audioDir, 'speaker-a.wav');
  await fs.writeFile(path.join(refsDir, 'speaker-a.txt'), 'manifest transcript\n', 'utf8');
  await fs.writeFile(
    path.join(audioDir, 'dataset.manifest.json'),
    JSON.stringify(
      {
        items: [
          {
            path: 'speaker-a.wav',
            language: 'zh',
            speaker: 'speaker-a',
            tags: ['meeting', 'far-field'],
            reference_path: '../refs/speaker-a.txt',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const assets = await collectAudioAssets(audioDir);
  const enriched = await applyDatasetManifest(assets, {
    inputPath: audioDir,
  });

  assert.equal(enriched[0]?.language, 'zh');
  assert.equal(enriched[0]?.speaker, 'speaker-a');
  assert.deepEqual(enriched[0]?.tags, ['meeting', 'far-field']);
  assert.equal(enriched[0]?.reference_text, 'manifest transcript');
});
