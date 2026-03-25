import fs from 'node:fs/promises';
import path from 'node:path';
import type { ValidationReport } from '../domain/types.js';
import { createAudioAsset } from '../utils/audio.js';
import { DefaultProviderSwitcher } from '../providers/switcher.js';
import { loadResolvedProvider } from '../config/loadProviders.js';

export interface ValidateProviderOptions {
  configPath: string;
  providerId: string;
  audioPath: string;
  dryRun?: boolean;
  outputDir?: string;
}

export async function validateProvider(options: ValidateProviderOptions): Promise<ValidationReport> {
  const provider = await loadResolvedProvider(options.configPath, options.providerId);
  const adapter = new DefaultProviderSwitcher().resolve(provider);
  await adapter.validateConfig(provider);
  const audio = await createAudioAsset(options.audioPath);
  const builtRequest = await adapter.buildRequest({ provider, audio });

  const report: ValidationReport = {
    ok: true,
    provider_id: provider.provider_id,
    validated_at: new Date().toISOString(),
    request_preview: builtRequest.debugPreview,
  };

  if (!options.dryRun) {
    const executionResult = await adapter.execute({ provider, audio });
    report.execution = {
      statusCode: executionResult.statusCode,
      error: executionResult.error,
    };
    if (executionResult.ok) {
      report.normalized_result = await adapter.normalize({
        provider,
        executionResult,
      });
    } else {
      report.ok = false;
    }
  }

  const outputDir = path.resolve(options.outputDir ?? 'artifacts/providers');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${provider.provider_id}.validation.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return report;
}
