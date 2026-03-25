import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { loadProvidersConfig } from '../config/loadProviders.js';
import { runDuration } from './runDurationService.js';
import { runOnce } from './runOnceService.js';
import { getRunDetailFromSqlite, listRunsFromSqlite } from './sqliteStore.js';

export interface UiServerOptions {
  dbPath: string;
  configPath: string;
  host?: string;
  port?: number;
}

export interface RunningUiServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);

    if (requestUrl.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderIndexHtml());
      return;
    }

    if (requestUrl.pathname === '/api/runs') {
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? '50', 10);
      const runs = await listRunsFromSqlite(options.dbPath, {
        limit: Number.isFinite(limit) ? limit : 50,
        providerId: requestUrl.searchParams.get('provider') ?? undefined,
        mode: (requestUrl.searchParams.get('mode') as 'once' | 'duration' | null) ?? undefined,
        hasFailures:
          requestUrl.searchParams.get('failures') === null
            ? undefined
            : ['yes', 'true', '1'].includes((requestUrl.searchParams.get('failures') ?? '').toLowerCase()),
        createdAfter: requestUrl.searchParams.get('created_after') ?? undefined,
        createdBefore: requestUrl.searchParams.get('created_before') ?? undefined,
        query: requestUrl.searchParams.get('query') ?? undefined,
      });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ runs }, null, 2));
      return;
    }

    if (requestUrl.pathname === '/api/providers') {
      const providersFile = await loadProvidersConfig(options.configPath);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ providers: providersFile.providers }, null, 2));
      return;
    }

    const match = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (match) {
      const run = await getRunDetailFromSqlite(options.dbPath, decodeURIComponent(match[1]));
      if (!run) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'run_not_found' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(run, null, 2));
      return;
    }

    const rawMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/attempts\/([^/]+)\/raw$/);
    if (rawMatch) {
      const run = await getRunDetailFromSqlite(options.dbPath, decodeURIComponent(rawMatch[1]));
      if (!run) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'run_not_found' }));
        return;
      }

      const rawAttempt = await readRawAttemptArtifact(run.summary.attempts_path, decodeURIComponent(rawMatch[2]));
      if (!rawAttempt) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'raw_attempt_not_found' }));
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(rawAttempt, null, 2));
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/run') {
      const payload = (await readJsonBody(request)) as {
        mode: 'once' | 'duration';
        providerIds: string[];
        inputPath: string;
        rounds?: number;
        durationMs?: number;
        concurrency?: number;
        intervalMs?: number;
        manifestPath?: string;
        referenceSidecar?: boolean;
        referenceDir?: string;
      };

      const summary =
        payload.mode === 'duration'
          ? await runDuration({
              configPath: options.configPath,
              providerIds: payload.providerIds,
              inputPath: payload.inputPath,
              durationMs: payload.durationMs ?? 30_000,
              concurrency: payload.concurrency,
              intervalMs: payload.intervalMs,
              dbPath: options.dbPath,
              manifestPath: payload.manifestPath,
              referenceSidecar: payload.referenceSidecar,
              referenceDir: payload.referenceDir,
            })
          : await runOnce({
              configPath: options.configPath,
              providerIds: payload.providerIds,
              inputPath: payload.inputPath,
              rounds: payload.rounds ?? 1,
              dbPath: options.dbPath,
              manifestPath: payload.manifestPath,
              referenceSidecar: payload.referenceSidecar,
              referenceDir: payload.referenceDir,
            });

      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ summary }, null, 2));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;

  return {
    host,
    port: address.port,
    url,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ASR Bench</title>
    <style>
      :root {
        --bg: #f3efe6;
        --panel: rgba(255, 252, 247, 0.92);
        --ink: #1d1b17;
        --muted: #6d6558;
        --line: rgba(29, 27, 23, 0.12);
        --accent: #0d7a5f;
        --accent-soft: rgba(13, 122, 95, 0.1);
        --warm: #d96c3d;
        --danger: #b94a32;
        --danger-soft: rgba(185, 74, 50, 0.1);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217,108,61,0.18), transparent 30%),
          radial-gradient(circle at bottom right, rgba(13,122,95,0.18), transparent 35%),
          linear-gradient(135deg, #efe8db 0%, #f8f4ec 48%, #ebe1d0 100%);
      }

      .shell {
        display: grid;
        grid-template-columns: 360px 1fr;
        min-height: 100vh;
      }

      .sidebar, .content {
        padding: 24px;
      }

      .sidebar {
        border-right: 1px solid var(--line);
        background: rgba(255,255,255,0.35);
        backdrop-filter: blur(12px);
      }

      .content {
        display: grid;
        gap: 16px;
      }

      h1, h2, h3, h4 { margin: 0; }
      h1 { font-size: 30px; letter-spacing: 0.02em; }
      .subtitle, .muted { color: var(--muted); }
      .run-list {
        display: grid;
        gap: 12px;
        margin-top: 18px;
      }

      .run-card, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        box-shadow: 0 10px 30px rgba(40, 31, 20, 0.06);
      }

      .run-card {
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
      }

      .run-card:hover, .run-card.active {
        transform: translateY(-1px);
        border-color: rgba(13, 122, 95, 0.45);
        background: linear-gradient(180deg, rgba(255,252,247,0.98), rgba(247,243,235,0.98));
      }

      .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        margin-right: 6px;
      }

      .tag.alert {
        background: var(--danger-soft);
        color: var(--danger);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }

      .split {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.95fr);
        gap: 16px;
        align-items: start;
      }

      .metric {
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
        border: 1px solid var(--line);
        padding: 12px;
      }

      .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .metric .value { font-size: 28px; margin-top: 4px; }

      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      input, select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.8);
        color: var(--ink);
        font: inherit;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 12px;
      }

      th, td {
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        padding: 10px 8px;
      }

      tr.attempt-row {
        cursor: pointer;
      }

      tr.attempt-row:hover {
        background: rgba(13, 122, 95, 0.05);
      }

      tr.attempt-row.active {
        background: rgba(13, 122, 95, 0.1);
      }

      .empty {
        display: grid;
        place-items: center;
        min-height: 240px;
        color: var(--muted);
        background: repeating-linear-gradient(
          -45deg,
          rgba(255,255,255,0.55),
          rgba(255,255,255,0.55) 12px,
          rgba(255,249,240,0.7) 12px,
          rgba(255,249,240,0.7) 24px
        );
      }

      .detail-stack {
        display: grid;
        gap: 12px;
      }

      .detail-block {
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
        border-radius: 14px;
        padding: 14px;
      }

      .detail-block pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 12px;
      }

      .chart-stack {
        display: grid;
        gap: 12px;
      }

      .chart {
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
        border-radius: 14px;
        padding: 14px;
      }

      .chart-title {
        margin-bottom: 10px;
        font-size: 14px;
      }

      .bar-list {
        display: grid;
        gap: 8px;
      }

      .bar-row {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr) 52px;
        gap: 10px;
        align-items: center;
        font-size: 12px;
      }

      .bar-track {
        position: relative;
        height: 10px;
        border-radius: 999px;
        background: rgba(29, 27, 23, 0.08);
        overflow: hidden;
      }

      .bar-fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(13,122,95,0.82), rgba(217,108,61,0.82));
      }

      .diff-chip {
        display: inline-block;
        margin: 0 4px 4px 0;
        padding: 3px 7px;
        border-radius: 999px;
        background: rgba(29, 27, 23, 0.06);
      }

      .diff-chip.insert { background: rgba(13, 122, 95, 0.16); }
      .diff-chip.delete { background: rgba(185, 74, 50, 0.16); }
      .diff-chip.same { background: rgba(29, 27, 23, 0.06); }

      @media (max-width: 1180px) {
        .split { grid-template-columns: 1fr; }
      }

      @media (max-width: 920px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar { border-right: 0; border-bottom: 1px solid var(--line); }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <h1>ASR Bench</h1>
        <p class="subtitle">SQLite-backed runs, latency, retries, transcript accuracy, and failure triage in one place.</p>
        <div class="panel" style="margin-top:18px;">
          <h3 style="margin-bottom:10px;">Run Filters</h3>
          <div id="run-filter-controls" class="controls"></div>
        </div>
        <div class="panel" style="margin-top:16px;">
          <h3 style="margin-bottom:10px;">Create Run</h3>
          <div id="run-create-controls" class="controls"></div>
        </div>
        <div id="run-list" class="run-list"></div>
      </aside>
      <main class="content" id="content">
        <section class="panel empty">Loading benchmark runs...</section>
      </main>
    </div>
    <script>
      const state = {
        runs: [],
        providers: [],
        activeRunId: null,
        activeRun: null,
        rawAttemptById: {},
        runFilters: {
          provider: 'all',
          mode: 'all',
          failures: 'all',
          query: '',
        },
        runForm: {
          mode: 'once',
          providerIds: [],
          inputPath: '',
          rounds: '1',
          durationMs: '30000',
          concurrency: '1',
          intervalMs: '0',
          manifestPath: '',
          referenceSidecar: false,
          referenceDir: '',
        },
        isSubmittingRun: false,
        filters: {
          provider: 'all',
          status: 'all',
          search: '',
          sort: 'latency_desc',
          minLatency: '',
          minWer: '',
        },
        selectedAttemptId: null,
      };

      function fmt(value) {
        if (value === null || value === undefined || value === '') return '-';
        return String(value);
      }

      function metric(label, value) {
        return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + fmt(value) + '</div></div>';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function renderRunList() {
        const root = document.getElementById('run-list');
        if (!state.runs.length) {
          root.innerHTML = '<div class="run-card">No benchmark runs found in the selected SQLite database.</div>';
          return;
        }

        root.innerHTML = state.runs.map((run) => {
          const active = run.run_id === state.activeRunId ? 'active' : '';
          const failureTag = run.failure_count > 0 ? '<div class="tag alert">' + run.failure_count + ' failures</div>' : '';
          return '<div class="run-card ' + active + '" data-run-id="' + run.run_id + '">' +
            '<div class="tag">' + run.mode + '</div>' +
            '<div class="tag">' + run.attempt_count + ' attempts</div>' +
            failureTag +
            '<h3 style="margin-top:10px;font-size:16px;">' + run.run_id + '</h3>' +
            '<p class="muted" style="margin:8px 0 0;">' + new Date(run.created_at).toLocaleString() + '</p>' +
            '<p class="muted" style="margin:8px 0 0;">avg latency ' + fmt(run.average_latency_ms) + ' ms, avg WER ' + fmt(run.average_wer) + '</p>' +
          '</div>';
        }).join('');

        root.querySelectorAll('[data-run-id]').forEach((node) => {
          node.addEventListener('click', () => loadRun(node.getAttribute('data-run-id')));
        });
      }

      function renderRunSidebarControls() {
        renderRunFilterControls();
        renderRunCreateControls();
      }

      function renderRunFilterControls() {
        const root = document.getElementById('run-filter-controls');
        if (!root) return;
        const providers = state.providers.map((provider) => provider.provider_id);
        root.innerHTML =
          '<label>Provider<select id="run-filter-provider"><option value="all">All providers</option>' +
          providers.map((provider) => '<option value="' + escapeHtml(provider) + '"' + (provider === state.runFilters.provider ? ' selected' : '') + '>' + escapeHtml(provider) + '</option>').join('') +
          '</select></label>' +
          '<label>Mode<select id="run-filter-mode">' +
            '<option value="all"' + (state.runFilters.mode === 'all' ? ' selected' : '') + '>All modes</option>' +
            '<option value="once"' + (state.runFilters.mode === 'once' ? ' selected' : '') + '>Once</option>' +
            '<option value="duration"' + (state.runFilters.mode === 'duration' ? ' selected' : '') + '>Duration</option>' +
          '</select></label>' +
          '<label>Failures<select id="run-filter-failures">' +
            '<option value="all"' + (state.runFilters.failures === 'all' ? ' selected' : '') + '>Any</option>' +
            '<option value="yes"' + (state.runFilters.failures === 'yes' ? ' selected' : '') + '>Failures only</option>' +
            '<option value="no"' + (state.runFilters.failures === 'no' ? ' selected' : '') + '>No failures</option>' +
          '</select></label>' +
          '<label>Search<input id="run-filter-query" type="text" placeholder="run id or path" value="' + escapeHtml(state.runFilters.query) + '" /></label>';

        ['run-filter-provider', 'run-filter-mode', 'run-filter-failures', 'run-filter-query'].forEach((id) => {
          const node = document.getElementById(id);
          if (!node) return;
          node.addEventListener('input', updateRunFiltersFromDom);
          node.addEventListener('change', updateRunFiltersFromDom);
        });
      }

      function renderRunCreateControls() {
        const root = document.getElementById('run-create-controls');
        if (!root) return;
        const providerCheckboxes = state.providers.length
          ? state.providers.map((provider) =>
              '<label style="text-transform:none;letter-spacing:0;font-size:13px;">' +
                '<input type="checkbox" class="run-provider-checkbox" value="' + escapeHtml(provider.provider_id) + '"' +
                (state.runForm.providerIds.includes(provider.provider_id) ? ' checked' : '') +
                ' /> ' + escapeHtml(provider.provider_id) +
              '</label>'
            ).join('')
          : '<div class="muted">No providers loaded.</div>';

        root.innerHTML =
          '<label>Mode<select id="run-form-mode">' +
            '<option value="once"' + (state.runForm.mode === 'once' ? ' selected' : '') + '>Once</option>' +
            '<option value="duration"' + (state.runForm.mode === 'duration' ? ' selected' : '') + '>Duration</option>' +
          '</select></label>' +
          '<label>Input path<input id="run-form-input" type="text" placeholder="/path/to/audio" value="' + escapeHtml(state.runForm.inputPath) + '" /></label>' +
          '<label>Manifest path<input id="run-form-manifest" type="text" placeholder="/path/to/manifest.json" value="' + escapeHtml(state.runForm.manifestPath) + '" /></label>' +
          '<label>Reference dir<input id="run-form-reference-dir" type="text" placeholder="/path/to/references" value="' + escapeHtml(state.runForm.referenceDir) + '" /></label>' +
          '<label>Rounds<input id="run-form-rounds" type="number" min="1" value="' + escapeHtml(state.runForm.rounds) + '" /></label>' +
          '<label>Duration ms<input id="run-form-duration" type="number" min="1" value="' + escapeHtml(state.runForm.durationMs) + '" /></label>' +
          '<label>Concurrency<input id="run-form-concurrency" type="number" min="1" value="' + escapeHtml(state.runForm.concurrency) + '" /></label>' +
          '<label>Interval ms<input id="run-form-interval" type="number" min="0" value="' + escapeHtml(state.runForm.intervalMs) + '" /></label>' +
          '<label style="text-transform:none;letter-spacing:0;font-size:13px;"><input id="run-form-sidecar" type="checkbox"' + (state.runForm.referenceSidecar ? ' checked' : '') + ' /> Use sidecar reference txt</label>' +
          '<div style="display:grid;gap:6px;"><div class="muted" style="font-size:12px;">Providers</div>' + providerCheckboxes + '</div>' +
          '<button id="run-form-submit" style="margin-top:8px;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--accent);color:white;cursor:pointer;">' +
            (state.isSubmittingRun ? 'Running...' : 'Start Run') +
          '</button>';

        ['run-form-mode', 'run-form-input', 'run-form-manifest', 'run-form-reference-dir', 'run-form-rounds', 'run-form-duration', 'run-form-concurrency', 'run-form-interval', 'run-form-sidecar']
          .forEach((id) => {
            const node = document.getElementById(id);
            if (!node) return;
            node.addEventListener('input', updateRunFormFromDom);
            node.addEventListener('change', updateRunFormFromDom);
          });
        document.querySelectorAll('.run-provider-checkbox').forEach((node) => {
          node.addEventListener('change', updateRunFormFromDom);
        });
        const submit = document.getElementById('run-form-submit');
        if (submit) {
          submit.addEventListener('click', submitRunForm);
        }
      }

      async function loadRuns() {
        const params = new URLSearchParams();
        if (state.runFilters.provider !== 'all') params.set('provider', state.runFilters.provider);
        if (state.runFilters.mode !== 'all') params.set('mode', state.runFilters.mode);
        if (state.runFilters.failures !== 'all') params.set('failures', state.runFilters.failures);
        if (state.runFilters.query) params.set('query', state.runFilters.query);

        const response = await fetch('/api/runs?' + params.toString());
        const data = await response.json();
        state.runs = data.runs || [];
        renderRunSidebarControls();
        state.activeRunId = state.runs[0] ? state.runs[0].run_id : null;
        renderRunList();
        if (state.activeRunId) {
          await loadRun(state.activeRunId);
        } else {
          document.getElementById('content').innerHTML = '<section class="panel empty">Run a benchmark first, then refresh this page.</section>';
        }
      }

      async function loadProviders() {
        const response = await fetch('/api/providers');
        const data = await response.json();
        state.providers = data.providers || [];
        if (!state.runForm.providerIds.length && state.providers[0]) {
          state.runForm.providerIds = [state.providers[0].provider_id];
        }
        renderRunSidebarControls();
      }

      async function loadRun(runId) {
        if (!runId) return;
        state.activeRunId = runId;
        renderRunList();

        const response = await fetch('/api/runs/' + encodeURIComponent(runId));
        const data = await response.json();
        state.activeRun = data;
        state.rawAttemptById = {};
        state.selectedAttemptId = data.attempts?.[0]?.attempt_id || null;
        resetFiltersForRun(data);
        renderActiveRun();
        if (state.selectedAttemptId) {
          await ensureRawAttemptLoaded(state.selectedAttemptId);
          renderActiveRun();
        }
      }

      function resetFiltersForRun(data) {
        const providers = new Set((data.attempts || []).map((item) => item.provider_id));
        if (!providers.has(state.filters.provider)) {
          state.filters.provider = 'all';
        }
      }

      function renderActiveRun() {
        if (!state.activeRun) return;
        const summary = state.activeRun.summary;
        const attempts = filteredAttempts();
        const selectedAttempt = resolveSelectedAttempt(attempts, state.activeRun.attempts || []);

        document.getElementById('content').innerHTML =
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h2>' + summary.run_id + '</h2><p class="muted" style="margin-top:8px;">' + escapeHtml(summary.input_path) + '</p></div>' +
              '<div><span class="tag">' + summary.mode + '</span><span class="tag">' + summary.provider_ids.map(escapeHtml).join(', ') + '</span></div>' +
            '</div>' +
            '<div class="grid" style="margin-top:16px;">' +
              metric('Attempts', summary.attempt_count) +
              metric('Success', summary.success_count) +
              metric('Failures', summary.failure_count) +
              metric('Avg latency', summary.average_latency_ms === undefined ? '-' : summary.average_latency_ms + ' ms') +
              metric('P95 latency', summary.p95_latency_ms === undefined ? '-' : summary.p95_latency_ms + ' ms') +
              metric('Retries', summary.total_retry_count) +
              metric('Avg WER', summary.average_wer) +
              metric('Avg CER', summary.average_cer) +
            '</div>' +
          '</section>' +
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h3 style="margin-bottom:12px;">Provider Summary</h3></div>' +
              '<div class="tag">filtered attempts ' + attempts.length + '</div>' +
            '</div>' +
            renderProviderTable(summary.provider_summaries || []) +
          '</section>' +
          '<section class="panel">' +
            '<h3 style="margin-bottom:12px;">Visual Overview</h3>' +
            renderCharts(attempts) +
          '</section>' +
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h3 style="margin-bottom:6px;">Attempts</h3><p class="muted" style="margin:0;">Filter failures, high latency, high WER, and inspect one sample in detail.</p></div>' +
            '</div>' +
            renderAttemptFilters(state.activeRun.attempts || []) +
            '<div class="split" style="margin-top:16px;">' +
              '<div>' + renderAttemptTable(attempts, selectedAttempt) + '</div>' +
              '<div>' + renderAttemptDetail(selectedAttempt) + '</div>' +
            '</div>' +
          '</section>';

        bindFilters();
        bindAttemptRows();
      }

      function renderProviderTable(rows) {
        if (!rows.length) return '<div class="empty">No provider summaries.</div>';
        return '<table><thead><tr><th>provider</th><th>attempts</th><th>avg latency</th><th>retries</th><th>avg WER</th><th>avg CER</th></tr></thead><tbody>' +
          rows.map((row) => '<tr><td>' + escapeHtml(row.provider_id) + '</td><td>' + row.attempt_count + '</td><td>' + fmt(row.average_latency_ms) + '</td><td>' + fmt(row.total_retry_count) + '</td><td>' + fmt(row.average_wer) + '</td><td>' + fmt(row.average_cer) + '</td></tr>').join('') +
          '</tbody></table>';
      }

      function renderCharts(rows) {
        if (!rows.length) {
          return '<div class="empty">No attempts available for charting.</div>';
        }

        const latencyBuckets = [
          ['<250ms', (row) => Number(row.latency_ms) < 250],
          ['250-500', (row) => Number(row.latency_ms) >= 250 && Number(row.latency_ms) < 500],
          ['500-1000', (row) => Number(row.latency_ms) >= 500 && Number(row.latency_ms) < 1000],
          ['1-2s', (row) => Number(row.latency_ms) >= 1000 && Number(row.latency_ms) < 2000],
          ['>2s', (row) => Number(row.latency_ms) >= 2000],
        ];
        const werBuckets = [
          ['0-0.1', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0 && (row.evaluation?.word_error_rate ?? -1) < 0.1],
          ['0.1-0.2', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.1 && (row.evaluation?.word_error_rate ?? -1) < 0.2],
          ['0.2-0.4', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.2 && (row.evaluation?.word_error_rate ?? -1) < 0.4],
          ['0.4-0.6', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.4 && (row.evaluation?.word_error_rate ?? -1) < 0.6],
          ['>0.6', (row) => (row.evaluation?.word_error_rate ?? -1) >= 0.6],
        ];

        const failureCounts = Object.entries(
          rows.reduce((acc, row) => {
            if (!row.success) {
              const key = row.error?.type || 'failed';
              acc[key] = (acc[key] || 0) + 1;
            }
            return acc;
          }, {}),
        );

        return '<div class="chart-stack">' +
          renderBarChart('Latency Distribution', bucketCounts(rows, latencyBuckets)) +
          renderBarChart('WER Distribution', bucketCounts(rows.filter((row) => row.evaluation), werBuckets)) +
          renderBarChart('Failure Types', failureCounts) +
        '</div>';
      }

      function bucketCounts(rows, buckets) {
        return buckets.map(([label, predicate]) => [label, rows.filter(predicate).length]);
      }

      function renderBarChart(title, rows) {
        const filtered = rows.filter(([, value]) => value > 0);
        if (!filtered.length) {
          return '<div class="chart"><div class="chart-title">' + title + '</div><div class="muted">No data in this slice.</div></div>';
        }
        const maxValue = Math.max(...filtered.map(([, value]) => value), 1);
        return '<div class="chart">' +
          '<div class="chart-title">' + title + '</div>' +
          '<div class="bar-list">' +
            filtered.map(([label, value]) => {
              const pct = Math.max(4, Math.round((value / maxValue) * 100));
              return '<div class="bar-row">' +
                '<div>' + escapeHtml(label) + '</div>' +
                '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;"></div></div>' +
                '<div>' + value + '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
      }

      function renderAttemptFilters(rows) {
        const providers = Array.from(new Set(rows.map((row) => row.provider_id))).sort();
        return '<div class="controls">' +
          '<label>Provider<select id="provider-filter"><option value="all">All providers</option>' + providers.map((provider) => '<option value="' + escapeHtml(provider) + '"' + (provider === state.filters.provider ? ' selected' : '') + '>' + escapeHtml(provider) + '</option>').join('') + '</select></label>' +
          '<label>Status<select id="status-filter">' +
            optionMarkup('status', 'all', 'All attempts') +
            optionMarkup('status', 'success', 'Success only') +
            optionMarkup('status', 'failure', 'Failures only') +
            optionMarkup('status', 'high_latency', 'High latency') +
            optionMarkup('status', 'high_wer', 'High WER') +
          '</select></label>' +
          '<label>Search<input id="search-filter" type="text" placeholder="provider, text, error..." value="' + escapeHtml(state.filters.search) + '" /></label>' +
          '<label>Sort<select id="sort-filter">' +
            optionMarkup('sort', 'latency_desc', 'Latency desc') +
            optionMarkup('sort', 'latency_asc', 'Latency asc') +
            optionMarkup('sort', 'wer_desc', 'WER desc') +
            optionMarkup('sort', 'retry_desc', 'Retry desc') +
            optionMarkup('sort', 'recent_desc', 'Newest first') +
          '</select></label>' +
          '<label>Min latency ms<input id="latency-filter" type="number" min="0" step="1" placeholder="1000" value="' + escapeHtml(state.filters.minLatency) + '" /></label>' +
          '<label>Min WER<input id="wer-filter" type="number" min="0" max="1" step="0.01" placeholder="0.2" value="' + escapeHtml(state.filters.minWer) + '" /></label>' +
        '</div>';
      }

      function optionMarkup(group, value, label) {
        const selected = state.filters[group] === value ? ' selected' : '';
        return '<option value="' + value + '"' + selected + '>' + label + '</option>';
      }

      function bindFilters() {
        ['provider-filter', 'status-filter', 'search-filter', 'sort-filter', 'latency-filter', 'wer-filter'].forEach((id) => {
          const node = document.getElementById(id);
          if (!node) return;
          node.addEventListener('input', updateFiltersFromDom);
          node.addEventListener('change', updateFiltersFromDom);
        });
      }

      async function updateRunFiltersFromDom() {
        state.runFilters.provider = document.getElementById('run-filter-provider').value;
        state.runFilters.mode = document.getElementById('run-filter-mode').value;
        state.runFilters.failures = document.getElementById('run-filter-failures').value;
        state.runFilters.query = document.getElementById('run-filter-query').value.trim();
        await loadRuns();
      }

      function updateRunFormFromDom() {
        state.runForm.mode = document.getElementById('run-form-mode').value;
        state.runForm.inputPath = document.getElementById('run-form-input').value.trim();
        state.runForm.manifestPath = document.getElementById('run-form-manifest').value.trim();
        state.runForm.referenceDir = document.getElementById('run-form-reference-dir').value.trim();
        state.runForm.rounds = document.getElementById('run-form-rounds').value.trim();
        state.runForm.durationMs = document.getElementById('run-form-duration').value.trim();
        state.runForm.concurrency = document.getElementById('run-form-concurrency').value.trim();
        state.runForm.intervalMs = document.getElementById('run-form-interval').value.trim();
        state.runForm.referenceSidecar = document.getElementById('run-form-sidecar').checked;
        state.runForm.providerIds = Array.from(document.querySelectorAll('.run-provider-checkbox'))
          .filter((node) => node.checked)
          .map((node) => node.value);
      }

      async function submitRunForm() {
        updateRunFormFromDom();
        if (!state.runForm.inputPath || !state.runForm.providerIds.length) {
          alert('Input path and at least one provider are required.');
          return;
        }

        state.isSubmittingRun = true;
        renderRunCreateControls();
        try {
          const payload = {
            mode: state.runForm.mode,
            providerIds: state.runForm.providerIds,
            inputPath: state.runForm.inputPath,
            rounds: Number.parseInt(state.runForm.rounds || '1', 10),
            durationMs: Number.parseInt(state.runForm.durationMs || '30000', 10),
            concurrency: Number.parseInt(state.runForm.concurrency || '1', 10),
            intervalMs: Number.parseInt(state.runForm.intervalMs || '0', 10),
            manifestPath: state.runForm.manifestPath || undefined,
            referenceSidecar: state.runForm.referenceSidecar,
            referenceDir: state.runForm.referenceDir || undefined,
          };

          const response = await fetch('/api/run', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data && data.error ? data.error : 'Run creation failed');
          }
          await loadRuns();
          if (data.summary && data.summary.run_id) {
            await loadRun(data.summary.run_id);
          }
        } catch (error) {
          alert(error && error.message ? error.message : String(error));
        } finally {
          state.isSubmittingRun = false;
          renderRunCreateControls();
        }
      }

      function updateFiltersFromDom() {
        state.filters.provider = document.getElementById('provider-filter').value;
        state.filters.status = document.getElementById('status-filter').value;
        state.filters.search = document.getElementById('search-filter').value.trim().toLowerCase();
        state.filters.sort = document.getElementById('sort-filter').value;
        state.filters.minLatency = document.getElementById('latency-filter').value.trim();
        state.filters.minWer = document.getElementById('wer-filter').value.trim();
        renderActiveRun();
      }

      function filteredAttempts() {
        const attempts = state.activeRun?.attempts || [];
        const minLatency = Number.parseFloat(state.filters.minLatency);
        const minWer = Number.parseFloat(state.filters.minWer);

        const rows = attempts.filter((row) => {
          if (state.filters.provider !== 'all' && row.provider_id !== state.filters.provider) return false;
          if (state.filters.status === 'success' && !row.success) return false;
          if (state.filters.status === 'failure' && row.success) return false;
          if (state.filters.status === 'high_latency' && !(Number(row.latency_ms) >= (Number.isFinite(minLatency) ? minLatency : 1000))) return false;
          if (state.filters.status === 'high_wer' && !((row.evaluation?.word_error_rate ?? -1) >= (Number.isFinite(minWer) ? minWer : 0.2))) return false;

          const haystack = [
            row.provider_id,
            row.audio_id,
            row.audio_path,
            row.error?.type,
            row.normalized_result?.text,
            row.evaluation?.reference_text,
          ].filter(Boolean).join(' ').toLowerCase();

          if (state.filters.search && !haystack.includes(state.filters.search)) return false;
          if (Number.isFinite(minLatency) && Number(row.latency_ms) < minLatency) return false;
          if (Number.isFinite(minWer) && (row.evaluation?.word_error_rate ?? -1) < minWer) return false;
          return true;
        });

        return rows.sort(sortAttemptRows);
      }

      function sortAttemptRows(a, b) {
        switch (state.filters.sort) {
          case 'latency_asc':
            return Number(a.latency_ms) - Number(b.latency_ms);
          case 'wer_desc':
            return Number(b.evaluation?.word_error_rate ?? -1) - Number(a.evaluation?.word_error_rate ?? -1);
          case 'retry_desc':
            return Number(b.retry_count) - Number(a.retry_count);
          case 'recent_desc':
            return String(b.started_at).localeCompare(String(a.started_at));
          case 'latency_desc':
          default:
            return Number(b.latency_ms) - Number(a.latency_ms);
        }
      }

      function renderAttemptTable(rows, selectedAttempt) {
        if (!rows.length) return '<div class="empty">No attempts match the current filters.</div>';
        return '<table><thead><tr><th>provider</th><th>audio</th><th>latency</th><th>retry</th><th>status</th><th>WER</th><th>CER</th><th>text</th></tr></thead><tbody>' +
          rows.map((row) => {
            const active = selectedAttempt && row.attempt_id === selectedAttempt.attempt_id ? ' active' : '';
            const text = row.normalized_result?.text || '';
            return '<tr class="attempt-row' + active + '" data-attempt-id="' + row.attempt_id + '">' +
              '<td>' + escapeHtml(row.provider_id) + '</td>' +
              '<td>' + escapeHtml(row.audio_id) + '</td>' +
              '<td>' + fmt(row.latency_ms) + '</td>' +
              '<td>' + fmt(row.retry_count) + '</td>' +
              '<td>' + (row.success ? '<span class="tag">ok</span>' : '<span class="tag alert">' + escapeHtml(fmt(row.error?.type)) + '</span>') + '</td>' +
              '<td>' + fmt(row.evaluation?.word_error_rate) + '</td>' +
              '<td>' + fmt(row.evaluation?.char_error_rate) + '</td>' +
              '<td>' + escapeHtml(text.slice(0, 100)) + (text.length > 100 ? '...' : '') + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>';
      }

      function bindAttemptRows() {
        document.querySelectorAll('[data-attempt-id]').forEach((node) => {
          node.addEventListener('click', async () => {
            state.selectedAttemptId = node.getAttribute('data-attempt-id');
            await ensureRawAttemptLoaded(state.selectedAttemptId);
            renderActiveRun();
          });
        });
      }

      function resolveSelectedAttempt(filtered, allAttempts) {
        if (state.selectedAttemptId) {
          const match = filtered.find((item) => item.attempt_id === state.selectedAttemptId) || allAttempts.find((item) => item.attempt_id === state.selectedAttemptId);
          if (match) return match;
        }
        return filtered[0] || allAttempts[0] || null;
      }

      function renderAttemptDetail(row) {
        if (!row) {
          return '<div class="detail-block empty">Select an attempt to inspect transcript diff and failure details.</div>';
        }

        const text = row.normalized_result?.text || '';
        const reference = row.evaluation?.reference_text || '';
        const diffHtml = reference ? renderWordDiff(reference, text) : '<div class="muted">No reference transcript attached for this attempt.</div>';
        const rawAttempt = state.rawAttemptById[row.attempt_id];
        const metadata = {
          attempt_id: row.attempt_id,
          provider_id: row.provider_id,
          audio_id: row.audio_id,
          audio_path: row.audio_path,
          latency_ms: row.latency_ms,
          retry_count: row.retry_count,
          request_attempts: row.request_attempts,
          http_status: row.http_status,
          status: row.success ? 'ok' : row.error?.type || 'failed',
        };

        return '<div class="detail-stack">' +
          '<div class="detail-block">' +
            '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;">' +
              '<h3>Attempt Detail</h3>' +
              (row.success ? '<span class="tag">success</span>' : '<span class="tag alert">failure</span>') +
            '</div>' +
            '<pre style="margin-top:12px;">' + escapeHtml(JSON.stringify(metadata, null, 2)) + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Failure Diagnostics</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(row.error ? JSON.stringify(row.error, null, 2) : 'No error for this attempt.') + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Raw Attempt Artifact</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(rawAttempt ? JSON.stringify(rawAttempt, null, 2) : 'Loading raw attempt artifact...') + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Transcript Diff</h4>' +
            '<div style="margin-top:12px;">' + diffHtml + '</div>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Reference Transcript</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(reference || 'No reference transcript.') + '</pre>' +
          '</div>' +
          '<div class="detail-block">' +
            '<h4>Hypothesis Transcript</h4>' +
            '<pre style="margin-top:12px;">' + escapeHtml(text || 'No normalized transcript.') + '</pre>' +
          '</div>' +
        '</div>';
      }

      function renderWordDiff(referenceText, hypothesisText) {
        const ref = tokenize(referenceText);
        const hyp = tokenize(hypothesisText);
        const matrix = Array.from({ length: ref.length + 1 }, () => Array(hyp.length + 1).fill(0));

        for (let i = 0; i <= ref.length; i += 1) matrix[i][0] = i;
        for (let j = 0; j <= hyp.length; j += 1) matrix[0][j] = j;

        for (let i = 1; i <= ref.length; i += 1) {
          for (let j = 1; j <= hyp.length; j += 1) {
            const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
              matrix[i - 1][j] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j - 1] + cost,
            );
          }
        }

        const ops = [];
        let i = ref.length;
        let j = hyp.length;
        while (i > 0 || j > 0) {
          if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]) {
            ops.push({ type: 'same', ref: ref[i - 1], hyp: hyp[j - 1] });
            i -= 1;
            j -= 1;
            continue;
          }

          const sub = i > 0 && j > 0 ? matrix[i - 1][j - 1] : Number.POSITIVE_INFINITY;
          const del = i > 0 ? matrix[i - 1][j] : Number.POSITIVE_INFINITY;
          const ins = j > 0 ? matrix[i][j - 1] : Number.POSITIVE_INFINITY;
          const min = Math.min(sub, del, ins);

          if (min === sub) {
            ops.push({ type: 'replace', ref: ref[i - 1], hyp: hyp[j - 1] });
            i -= 1;
            j -= 1;
          } else if (min === del) {
            ops.push({ type: 'delete', ref: ref[i - 1] });
            i -= 1;
          } else {
            ops.push({ type: 'insert', hyp: hyp[j - 1] });
            j -= 1;
          }
        }

        return ops.reverse().map((op) => {
          if (op.type === 'same') return '<span class="diff-chip same">' + escapeHtml(op.hyp) + '</span>';
          if (op.type === 'delete') return '<span class="diff-chip delete">-' + escapeHtml(op.ref) + '</span>';
          if (op.type === 'insert') return '<span class="diff-chip insert">+' + escapeHtml(op.hyp) + '</span>';
          return '<span class="diff-chip delete">-' + escapeHtml(op.ref) + '</span><span class="diff-chip insert">+' + escapeHtml(op.hyp) + '</span>';
        }).join(' ');
      }

      function tokenize(text) {
        const normalized = String(text || '').toLowerCase().trim();
        if (!normalized) return [];
        return normalized.split(/\\s+/).filter(Boolean);
      }

      async function ensureRawAttemptLoaded(attemptId) {
        if (!attemptId || state.rawAttemptById[attemptId] || !state.activeRunId) {
          return;
        }
        try {
          const response = await fetch('/api/runs/' + encodeURIComponent(state.activeRunId) + '/attempts/' + encodeURIComponent(attemptId) + '/raw');
          if (!response.ok) {
            state.rawAttemptById[attemptId] = { error: 'raw_attempt_not_found' };
            return;
          }
          state.rawAttemptById[attemptId] = await response.json();
        } catch (error) {
          state.rawAttemptById[attemptId] = { error: error && error.message ? error.message : String(error) };
        }
      }

      Promise.all([loadProviders(), loadRuns()]).catch((error) => {
        document.getElementById('content').innerHTML = '<section class="panel empty">Failed to load runs: ' + escapeHtml(error.message || String(error)) + '</section>';
      });
    </script>
  </body>
</html>`;
}

async function readRawAttemptArtifact(attemptsPath: string, attemptId: string): Promise<unknown | undefined> {
  const rawPath = path.join(path.dirname(attemptsPath), 'raw', `${attemptId}.json`);
  try {
    const payload = await fs.readFile(rawPath, 'utf8');
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}
