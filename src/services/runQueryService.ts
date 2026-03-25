import fs from 'node:fs/promises';
import path from 'node:path';
import type { BenchAttemptRecord } from '../domain/types.js';
import { toCsv } from './benchmarkArtifacts.js';
import { getRunDetailFromSqlite, listRunsFromSqlite } from './sqliteStore.js';
import type { ListRunsQuery, StoredRunDetail } from './sqliteStore.js';

export async function listRuns(options: { dbPath: string } & ListRunsQuery) {
  return listRunsFromSqlite(options.dbPath, {
    limit: options.limit ?? 20,
    providerId: options.providerId,
    mode: options.mode,
    hasFailures: options.hasFailures,
    createdAfter: options.createdAfter,
    createdBefore: options.createdBefore,
    query: options.query,
  });
}

export async function showRun(options: {
  dbPath: string;
  runId: string;
  includeAttempts: true;
}): Promise<StoredRunDetail>;
export async function showRun(options: {
  dbPath: string;
  runId: string;
  includeAttempts?: false;
}): Promise<{ summary: StoredRunDetail['summary'] }>;
export async function showRun(options: { dbPath: string; runId: string; includeAttempts?: boolean }) {
  const detail = await getRunDetailFromSqlite(options.dbPath, options.runId);
  if (!detail) {
    throw new Error(`Run ${options.runId} not found in ${path.resolve(options.dbPath)}`);
  }

  if (options.includeAttempts) {
    return detail;
  }

  return {
    summary: detail.summary,
  };
}

export async function exportRun(options: {
  dbPath: string;
  runId: string;
  format: 'json' | 'jsonl' | 'csv';
  outputPath?: string;
}): Promise<{ outputPath?: string; content: string }> {
  const detail = await getRunDetailFromSqlite(options.dbPath, options.runId);
  if (!detail) {
    throw new Error(`Run ${options.runId} not found in ${path.resolve(options.dbPath)}`);
  }

  const content = formatRunExport(detail.attempts, detail, options.format);

  if (options.outputPath) {
    const resolvedOutputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.writeFile(resolvedOutputPath, content, 'utf8');
    return {
      outputPath: resolvedOutputPath,
      content,
    };
  }

  return { content };
}

function formatRunExport(
  attempts: BenchAttemptRecord[],
  detail: StoredRunDetail,
  format: 'json' | 'jsonl' | 'csv',
): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(detail, null, 2)}\n`;
    case 'jsonl':
      return attempts.map((attempt) => JSON.stringify(attempt)).join('\n') + '\n';
    case 'csv':
      return toCsv(attempts);
    default:
      throw new Error(`Unsupported export format: ${String(format)}`);
  }
}
