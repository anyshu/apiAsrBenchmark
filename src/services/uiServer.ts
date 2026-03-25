import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { getRunDetailFromSqlite, listRunsFromSqlite } from './sqliteStore.js';

export interface UiServerOptions {
  dbPath: string;
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
      const runs = await listRunsFromSqlite(options.dbPath, Number.isFinite(limit) ? limit : 50);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ runs }, null, 2));
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

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }

      .metric {
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
        border: 1px solid var(--line);
        padding: 12px;
      }

      .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .metric .value { font-size: 28px; margin-top: 4px; }
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
        <p class="subtitle">SQLite-backed runs, latency, retries, and transcript accuracy in one place.</p>
        <div id="run-list" class="run-list"></div>
      </aside>
      <main class="content" id="content">
        <section class="panel empty">Loading benchmark runs...</section>
      </main>
    </div>
    <script>
      const state = { runs: [], activeRunId: null };

      function fmt(value) {
        if (value === null || value === undefined || value === '') return '-';
        return String(value);
      }

      function metric(label, value) {
        return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + fmt(value) + '</div></div>';
      }

      function renderRunList() {
        const root = document.getElementById('run-list');
        if (!state.runs.length) {
          root.innerHTML = '<div class="run-card">No benchmark runs found in the selected SQLite database.</div>';
          return;
        }

        root.innerHTML = state.runs.map((run) => {
          const active = run.run_id === state.activeRunId ? 'active' : '';
          return '<div class="run-card ' + active + '" data-run-id="' + run.run_id + '">' +
            '<div class="tag">' + run.mode + '</div>' +
            '<div class="tag">' + run.attempt_count + ' attempts</div>' +
            '<h3 style="margin-top:10px;font-size:16px;">' + run.run_id + '</h3>' +
            '<p class="muted" style="margin:8px 0 0;">' + new Date(run.created_at).toLocaleString() + '</p>' +
            '<p class="muted" style="margin:8px 0 0;">avg latency ' + fmt(run.average_latency_ms) + ' ms, avg WER ' + fmt(run.average_wer) + '</p>' +
          '</div>';
        }).join('');

        root.querySelectorAll('[data-run-id]').forEach((node) => {
          node.addEventListener('click', () => loadRun(node.getAttribute('data-run-id')));
        });
      }

      async function loadRuns() {
        const response = await fetch('/api/runs');
        const data = await response.json();
        state.runs = data.runs || [];
        state.activeRunId = state.runs[0] ? state.runs[0].run_id : null;
        renderRunList();
        if (state.activeRunId) {
          await loadRun(state.activeRunId);
        } else {
          document.getElementById('content').innerHTML = '<section class="panel empty">Run a benchmark first, then refresh this page.</section>';
        }
      }

      async function loadRun(runId) {
        if (!runId) return;
        state.activeRunId = runId;
        renderRunList();

        const response = await fetch('/api/runs/' + encodeURIComponent(runId));
        const data = await response.json();
        const summary = data.summary;
        const attempts = data.attempts || [];

        document.getElementById('content').innerHTML =
          '<section class="panel">' +
            '<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">' +
              '<div><h2>' + summary.run_id + '</h2><p class="muted" style="margin-top:8px;">' + summary.input_path + '</p></div>' +
              '<div><span class="tag">' + summary.mode + '</span><span class="tag">' + summary.provider_ids.join(', ') + '</span></div>' +
            '</div>' +
            '<div class="grid" style="margin-top:16px;">' +
              metric('Attempts', summary.attempt_count) +
              metric('Success', summary.success_count) +
              metric('Avg latency', summary.average_latency_ms === undefined ? '-' : summary.average_latency_ms + ' ms') +
              metric('P95 latency', summary.p95_latency_ms === undefined ? '-' : summary.p95_latency_ms + ' ms') +
              metric('Retries', summary.total_retry_count) +
              metric('Avg WER', summary.average_wer) +
              metric('Avg CER', summary.average_cer) +
            '</div>' +
          '</section>' +
          '<section class="panel">' +
            '<h3 style="margin-bottom:12px;">Provider Summary</h3>' +
            renderProviderTable(summary.provider_summaries || []) +
          '</section>' +
          '<section class="panel">' +
            '<h3 style="margin-bottom:12px;">Attempts</h3>' +
            renderAttemptTable(attempts) +
          '</section>';
      }

      function renderProviderTable(rows) {
        if (!rows.length) return '<div class="empty">No provider summaries.</div>';
        return '<table><thead><tr><th>provider</th><th>attempts</th><th>avg latency</th><th>retries</th><th>avg WER</th><th>avg CER</th></tr></thead><tbody>' +
          rows.map((row) => '<tr><td>' + row.provider_id + '</td><td>' + row.attempt_count + '</td><td>' + fmt(row.average_latency_ms) + '</td><td>' + fmt(row.total_retry_count) + '</td><td>' + fmt(row.average_wer) + '</td><td>' + fmt(row.average_cer) + '</td></tr>').join('') +
          '</tbody></table>';
      }

      function renderAttemptTable(rows) {
        if (!rows.length) return '<div class="empty">No attempts stored for this run.</div>';
        return '<table><thead><tr><th>provider</th><th>audio</th><th>latency</th><th>retry</th><th>status</th><th>WER</th><th>CER</th><th>text</th></tr></thead><tbody>' +
          rows.map((row) => '<tr><td>' + row.provider_id + '</td><td>' + row.audio_id + '</td><td>' + fmt(row.latency_ms) + '</td><td>' + fmt(row.retry_count) + '</td><td>' + (row.success ? 'ok' : fmt(row.error && row.error.type)) + '</td><td>' + fmt(row.evaluation && row.evaluation.word_error_rate) + '</td><td>' + fmt(row.evaluation && row.evaluation.char_error_rate) + '</td><td>' + escapeHtml(row.normalized_result && row.normalized_result.text || '') + '</td></tr>').join('') +
          '</tbody></table>';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      loadRuns().catch((error) => {
        document.getElementById('content').innerHTML = '<section class="panel empty">Failed to load runs: ' + escapeHtml(error.message || String(error)) + '</section>';
      });
    </script>
  </body>
</html>`;
}
