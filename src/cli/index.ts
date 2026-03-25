#!/usr/bin/env node
import { Command } from 'commander';
import { loadProvidersConfig } from '../config/loadProviders.js';
import { runDuration } from '../services/runDurationService.js';
import { runOnce } from '../services/runOnceService.js';
import { validateProvider } from '../services/validationService.js';

const program = new Command();

program
  .name('asrbench')
  .description('Audio ASR benchmark CLI')
  .option('-c, --config <path>', 'provider config file or directory', 'providers');

program
  .command('provider:list')
  .description('List configured providers')
  .action(async () => {
    const configPath = program.opts<{ config: string }>().config;
    const providersFile = await loadProvidersConfig(configPath);
    for (const provider of providersFile.providers) {
      console.log(`${provider.provider_id}\t${provider.type}\t${provider.name}`);
    }
  });

program
  .command('provider:validate')
  .description('Validate one provider with one audio sample')
  .requiredOption('--provider <id>', 'provider id')
  .requiredOption('--audio <path>', 'audio file path')
  .option('--dry-run', 'only preview the request without sending it', false)
  .action(async (options: { provider: string; audio: string; dryRun: boolean }) => {
    const configPath = program.opts<{ config: string }>().config;
    const report = await validateProvider({
      configPath,
      providerId: options.provider,
      audioPath: options.audio,
      dryRun: options.dryRun,
    });
    console.log(JSON.stringify(report, null, 2));
  });

program
  .command('run:once')
  .description('Run one benchmark pass across providers and audio inputs')
  .requiredOption('--providers <ids>', 'comma-separated provider ids')
  .requiredOption('--input <path>', 'audio file or directory path')
  .option('--rounds <n>', 'number of rounds to execute', '1')
  .action(async (options: { providers: string; input: string; rounds: string }) => {
    const configPath = program.opts<{ config: string }>().config;
    const summary = await runOnce({
      configPath,
      providerIds: options.providers.split(',').map((value) => value.trim()).filter(Boolean),
      inputPath: options.input,
      rounds: Number.parseInt(options.rounds, 10),
    });
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command('run:duration')
  .description('Run a sustained benchmark for a fixed duration')
  .requiredOption('--providers <ids>', 'comma-separated provider ids')
  .requiredOption('--input <path>', 'audio file or directory path')
  .requiredOption('--duration-ms <n>', 'benchmark duration in milliseconds')
  .option('--concurrency <n>', 'number of concurrent workers', '1')
  .option('--interval-ms <n>', 'delay before scheduling each task', '0')
  .action(
    async (options: {
      providers: string;
      input: string;
      durationMs: string;
      concurrency: string;
      intervalMs: string;
    }) => {
      const configPath = program.opts<{ config: string }>().config;
      const summary = await runDuration({
        configPath,
        providerIds: options.providers.split(',').map((value) => value.trim()).filter(Boolean),
        inputPath: options.input,
        durationMs: Number.parseInt(options.durationMs, 10),
        concurrency: Number.parseInt(options.concurrency, 10),
        intervalMs: Number.parseInt(options.intervalMs, 10),
      });
      console.log(JSON.stringify(summary, null, 2));
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
