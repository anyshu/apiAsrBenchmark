import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProvidersConfig } from '../src/config/loadProviders.js';

test('loads providers from a directory of individual config files', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audioapibench-providers-'));

  await fs.writeFile(
    path.join(tempDir, 'provider-a.yaml'),
    [
      'provider_id: provider-a',
      'name: Provider A',
      'type: openai_compatible',
      'base_url: https://api.example.com/v1',
      'api_key_env: PROVIDER_A_KEY',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(tempDir, 'provider-b.yaml'),
    [
      'provider_id: provider-b',
      'name: Provider B',
      'type: openai_compatible',
      'base_url: https://api.example.org/v1',
      'api_key_env: PROVIDER_B_KEY',
    ].join('\n'),
    'utf8',
  );

  const loaded = await loadProvidersConfig(tempDir);
  assert.equal(loaded.providers.length, 2);
  assert.deepEqual(
    loaded.providers.map((provider) => provider.provider_id),
    ['provider-a', 'provider-b'],
  );
});

