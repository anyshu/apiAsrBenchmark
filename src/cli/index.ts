#!/usr/bin/env node
import { Command } from 'commander';
import { loadProvidersConfig } from '../config/loadProviders.js';

const program = new Command();

program
  .name('asrbench')
  .description('Audio ASR benchmark CLI')
  .option('-c, --config <path>', 'provider config file or directory', 'providers')
  .option('--db <path>', 'SQLite path for persisted benchmark runs', 'artifacts/asrbench.sqlite')
  .option('--reference-sidecar', 'load same-basename .txt references next to audio files', false)
  .option('--reference-dir <path>', 'directory containing .txt references mapped by audio relative path');

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
    const { validateProvider } = await import('../services/validationService.js');
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
    const globalOptions = program.opts<{
      config: string;
      db: string;
      referenceSidecar: boolean;
      referenceDir?: string;
    }>();
    const { runOnce } = await import('../services/runOnceService.js');
    const summary = await runOnce({
      configPath: globalOptions.config,
      providerIds: options.providers.split(',').map((value) => value.trim()).filter(Boolean),
      inputPath: options.input,
      rounds: Number.parseInt(options.rounds, 10),
      dbPath: globalOptions.db,
      referenceSidecar: globalOptions.referenceSidecar,
      referenceDir: globalOptions.referenceDir,
    });
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command('run:duration')
  .description('Run a sustained benchmark for a fixed duration')
  .requiredOption('--providers <ids>', 'comma-separated provider ids')
  .requiredOption('--input <path>', 'audio file or directory path')
  .requiredOption('--duration-ms <n>', 'benchmark duration in milliseconds')
  .option('--concurrency <n>', 'default number of concurrent workers per provider', '1')
  .option('--interval-ms <n>', 'default delay between requests for providers without overrides', '0')
  .action(
    async (options: {
      providers: string;
      input: string;
      durationMs: string;
      concurrency: string;
      intervalMs: string;
    }) => {
      const globalOptions = program.opts<{
        config: string;
        db: string;
        referenceSidecar: boolean;
        referenceDir?: string;
      }>();
      const { runDuration } = await import('../services/runDurationService.js');
      const summary = await runDuration({
        configPath: globalOptions.config,
        providerIds: options.providers.split(',').map((value) => value.trim()).filter(Boolean),
        inputPath: options.input,
        durationMs: Number.parseInt(options.durationMs, 10),
        concurrency: Number.parseInt(options.concurrency, 10),
        intervalMs: Number.parseInt(options.intervalMs, 10),
        dbPath: globalOptions.db,
        referenceSidecar: globalOptions.referenceSidecar,
        referenceDir: globalOptions.referenceDir,
      });
      console.log(JSON.stringify(summary, null, 2));
    },
  );

program
  .command('run:list')
  .description('List benchmark runs stored in SQLite')
  .option('--limit <n>', 'max number of runs to return', '20')
  .option('--provider <id>', 'filter runs that include this provider id')
  .option('--mode <mode>', 'filter by run mode: once or duration')
  .option('--failures <kind>', 'filter by failure presence: yes or no')
  .option('--created-after <iso>', 'only include runs created at or after this ISO timestamp')
  .option('--created-before <iso>', 'only include runs created at or before this ISO timestamp')
  .option('--query <text>', 'filter by run id or input path substring')
  .action(
    async (options: {
      limit: string;
      provider?: string;
      mode?: 'once' | 'duration';
      failures?: string;
      createdAfter?: string;
      createdBefore?: string;
      query?: string;
    }) => {
    const globalOptions = program.opts<{ db: string }>();
    const { listRuns } = await import('../services/runQueryService.js');
    const runs = await listRuns({
      dbPath: globalOptions.db,
      limit: Number.parseInt(options.limit, 10),
      providerId: options.provider,
      mode: options.mode,
      hasFailures:
        options.failures === undefined ? undefined : ['yes', 'true', '1'].includes(options.failures.toLowerCase()),
      createdAfter: options.createdAfter,
      createdBefore: options.createdBefore,
      query: options.query,
    });
    console.log(JSON.stringify({ runs }, null, 2));
    },
  );

program
  .command('run:show')
  .description('Show one benchmark run from SQLite')
  .requiredOption('--run-id <id>', 'run id')
  .option('--attempts', 'include attempts in the output', false)
  .action(async (options: { runId: string; attempts: boolean }) => {
    const globalOptions = program.opts<{ db: string }>();
    const { showRun } = await import('../services/runQueryService.js');
    const run = options.attempts
      ? await showRun({
          dbPath: globalOptions.db,
          runId: options.runId,
          includeAttempts: true,
        })
      : await showRun({
          dbPath: globalOptions.db,
          runId: options.runId,
        });
    console.log(JSON.stringify(run, null, 2));
  });

program
  .command('run:export')
  .description('Export one benchmark run from SQLite')
  .requiredOption('--run-id <id>', 'run id')
  .requiredOption('--format <format>', 'export format: json, jsonl, csv')
  .option('--output <path>', 'write export to a file instead of stdout')
  .action(async (options: { runId: string; format: 'json' | 'jsonl' | 'csv'; output?: string }) => {
    const globalOptions = program.opts<{ db: string }>();
    const { exportRun } = await import('../services/runQueryService.js');
    const exported = await exportRun({
      dbPath: globalOptions.db,
      runId: options.runId,
      format: options.format,
      outputPath: options.output,
    });

    if (exported.outputPath) {
      console.log(JSON.stringify({ output_path: exported.outputPath }, null, 2));
      return;
    }

    process.stdout.write(exported.content);
  });

program
  .command('ui:serve')
  .description('Serve a lightweight local dashboard backed by the SQLite run store')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('--port <n>', 'port to bind', '3000')
  .action(async (options: { host: string; port: string }) => {
    const globalOptions = program.opts<{ db: string }>();
    const { startUiServer } = await import('../services/uiServer.js');
    const server = await startUiServer({
      dbPath: globalOptions.db,
      host: options.host,
      port: Number.parseInt(options.port, 10),
    });
    console.log(JSON.stringify({ url: server.url, db_path: globalOptions.db }, null, 2));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
