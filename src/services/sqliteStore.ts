import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BenchAttemptRecord, BenchRunSummary } from '../domain/types.js';

export interface StoredRunDetail {
  summary: BenchRunSummary;
  attempts: BenchAttemptRecord[];
}

export interface ListRunsQuery {
  limit?: number;
  providerId?: string;
  mode?: BenchRunSummary['mode'];
  hasFailures?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  query?: string;
}

export async function persistRunToSqlite(params: {
  dbPath: string;
  summary: BenchRunSummary;
  attempts: BenchAttemptRecord[];
}): Promise<void> {
  const resolvedDbPath = path.resolve(params.dbPath);
  await fs.mkdir(path.dirname(resolvedDbPath), { recursive: true });

  const db = new DatabaseSync(resolvedDbPath);
  try {
    initializeSchema(db);

    db.prepare(
      `INSERT INTO runs (
        run_id,
        created_at,
        mode,
        provider_ids_json,
        input_path,
        attempt_count,
        success_count,
        failure_count,
        average_latency_ms,
        average_wer,
        average_cer,
        total_retry_count,
        summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        created_at = excluded.created_at,
        mode = excluded.mode,
        provider_ids_json = excluded.provider_ids_json,
        input_path = excluded.input_path,
        attempt_count = excluded.attempt_count,
        success_count = excluded.success_count,
        failure_count = excluded.failure_count,
        average_latency_ms = excluded.average_latency_ms,
        average_wer = excluded.average_wer,
        average_cer = excluded.average_cer,
        total_retry_count = excluded.total_retry_count,
        summary_json = excluded.summary_json`,
    ).run(
      params.summary.run_id,
      params.summary.created_at,
      params.summary.mode,
      JSON.stringify(params.summary.provider_ids),
      params.summary.input_path,
      params.summary.attempt_count,
      params.summary.success_count,
      params.summary.failure_count,
      params.summary.average_latency_ms ?? null,
      params.summary.average_wer ?? null,
      params.summary.average_cer ?? null,
      params.summary.total_retry_count,
      JSON.stringify(params.summary),
    );

    db.prepare('DELETE FROM attempts WHERE run_id = ?').run(params.summary.run_id);

    const insertAttempt = db.prepare(
      `INSERT INTO attempts (
        attempt_id,
        run_id,
        provider_id,
        audio_id,
        started_at,
        latency_ms,
        success,
        retry_count,
        wer,
        cer,
        attempt_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    db.exec('BEGIN');
    try {
      for (const attempt of params.attempts) {
        insertAttempt.run(
          attempt.attempt_id,
          attempt.run_id,
          attempt.provider_id,
          attempt.audio_id,
          attempt.started_at,
          attempt.latency_ms,
          attempt.success ? 1 : 0,
          attempt.retry_count,
          attempt.evaluation?.word_error_rate ?? null,
          attempt.evaluation?.char_error_rate ?? null,
          JSON.stringify(attempt),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function listRunsFromSqlite(dbPath: string, query: ListRunsQuery = {}): Promise<BenchRunSummary[]> {
  const rows = withDatabase(dbPath, (db) => {
    const conditions: string[] = [];
    const values: Array<string | number> = [];

    if (query.providerId) {
      conditions.push('provider_ids_json LIKE ?');
      values.push(`%"${query.providerId}"%`);
    }
    if (query.mode) {
      conditions.push('mode = ?');
      values.push(query.mode);
    }
    if (query.hasFailures !== undefined) {
      conditions.push(query.hasFailures ? 'failure_count > 0' : 'failure_count = 0');
    }
    if (query.createdAfter) {
      conditions.push('created_at >= ?');
      values.push(query.createdAfter);
    }
    if (query.createdBefore) {
      conditions.push('created_at <= ?');
      values.push(query.createdBefore);
    }
    if (query.query) {
      conditions.push('(run_id LIKE ? OR input_path LIKE ?)');
      values.push(`%${query.query}%`, `%${query.query}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, query.limit ?? 50);
    const statement = db.prepare(
      `SELECT summary_json FROM runs ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    );

    return statement.all(...values, limit) as Array<{ summary_json: string }>;
  });

  return rows.map((row) => JSON.parse(row.summary_json) as BenchRunSummary);
}

export async function getRunDetailFromSqlite(dbPath: string, runId: string): Promise<StoredRunDetail | undefined> {
  return withDatabase(dbPath, (db) => {
    const summaryRow = db
      .prepare('SELECT summary_json FROM runs WHERE run_id = ?')
      .get(runId) as { summary_json: string } | undefined;

    if (!summaryRow) {
      return undefined;
    }

    const attemptRows = db
      .prepare('SELECT attempt_json FROM attempts WHERE run_id = ? ORDER BY started_at ASC, attempt_id ASC')
      .all(runId) as Array<{ attempt_json: string }>;

    return {
      summary: JSON.parse(summaryRow.summary_json) as BenchRunSummary,
      attempts: attemptRows.map((row) => JSON.parse(row.attempt_json) as BenchAttemptRecord),
    };
  });
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider_ids_json TEXT NOT NULL,
      input_path TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      success_count INTEGER NOT NULL,
      failure_count INTEGER NOT NULL,
      average_latency_ms REAL,
      average_wer REAL,
      average_cer REAL,
      total_retry_count INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      audio_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      success INTEGER NOT NULL,
      retry_count INTEGER NOT NULL,
      wer REAL,
      cer REAL,
      attempt_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attempts_run_id ON attempts(run_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_provider_id ON attempts(provider_id);
  `);
}

function withDatabase<T>(dbPath: string, callback: (db: DatabaseSync) => T): T {
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath, { open: true });
  try {
    initializeSchema(db);
    return callback(db);
  } finally {
    db.close();
  }
}
