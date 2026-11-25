#!/usr/bin/env node
/**
 * Captures design-review PNG snapshots of jj-graph's UI surfaces into docs/snapshots/.
 *
 * Uses a deterministic throwaway jj fixture repository, runs the real `jj-graph`
 * backend for `/api/*`, serves `public/` directly from disk so CSS/JS design edits
 * appear immediately without recompiling Rust, and drives headless Google Chrome
 * over CDP (zero external npm dependencies; requires Node >= 22, jj, and Chrome).
 *
 * Usage:
 *   node docs/snapshots/capture.mjs
 *   JJ_GRAPH_BIN=./target/debug/jj-graph CHROME_BIN=google-chrome node docs/snapshots/capture.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../../.opencode/plugins/jj-graph/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PUBLIC_DIR = join(ROOT, 'public');
const GUI_CSS_PATH = join(ROOT, '.opencode/plugins/jj-graph/gui.css');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function findBinary() {
  if (process.env.JJ_GRAPH_BIN) return process.env.JJ_GRAPH_BIN;
  for (const candidate of [
    join(ROOT, 'target/debug/jj-graph'),
    join(ROOT, 'target/release/jj-graph'),
    'jj-graph',
  ]) {
    if (candidate === 'jj-graph' || existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find jj-graph binary. Build it (`cargo build -p jj-graph`) or set JJ_GRAPH_BIN.');
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // try next
    }
  }
  throw new Error('Could not find google-chrome or chromium on PATH. Set CHROME_BIN.');
}

// ---------------------------------------------------------------- fixture repo

function createFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'jj-graph-snapshots-'));
  const baseTime = Date.now() - 45 * 60 * 1000;
  let step = 0;

  const jj = (args) => {
    const ts = new Date(baseTime + step++ * 3 * 60 * 1000).toISOString();
    return execFileSync('jj', ['--color', 'never', '--no-pager', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        JJ_TIMESTAMP: ts,
        JJ_OP_TIMESTAMP: ts,
      },
    }).trim();
  };

  const write = (rel, content) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  const changeId = (rev) => jj(['log', '-r', rev, '--no-graph', '-T', 'change_id']);

  jj(['git', 'init']);
  jj(['config', 'set', '--repo', 'user.name', 'Ada Lovelace']);
  jj(['config', 'set', '--repo', 'user.email', 'ada@example.com']);
  jj(['metaedit', '--update-author']);

  // Immutable trunk bedrock (3 commits)
  write('README.md', '# pulse\n\nStreaming revision graph tools.\n');
  write('src/config.js', 'export const DEFAULT_PORT = 7777;\nexport const MAX_LANES = 12;\n');
  jj(['commit', '-m', 'chore: seed workspace config and lint rules']);

  write(
    'src/layout.js',
    [
      'export const LANE_WIDTH = 28;',
      'export const ROW_HEIGHT = 64;',
      '',
      'export function laneX(lane) {',
      '  return 18 + lane * LANE_WIDTH;',
      '}',
      '',
      'export function edgeCurve(x1, y1, x2, y2) {',
      '  const mid = (y1 + y2) / 2;',
      '  return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;',
      '}',
      '',
    ].join('\n'),
  );
  jj(['commit', '-m', 'feat: add graph layout lane solver']);

  write(
    'src/bookmarks.js',
    [
      'export function formatBookmark(bm) {',
      '  return bm.conflict ? `${bm.name}??` : bm.name;',
      '}',
      '',
    ].join('\n'),
  );
  jj(['commit', '-m', 'fix: keep bookmarks attached across rebase']);
  jj(['bookmark', 'create', 'main', '-r', '@-']);
  jj(['config', 'set', '--repo', 'revset-aliases."trunk()"', 'main']);
  jj(['config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'trunk()']);

  // Parallel arm off trunk: fix/edges (with 2 evolog versions + conflicting line in src/layout.js)
  jj(['new', 'main', '-m', 'fix: route merge curves cleanly on narrow screens']);
  write(
    'src/layout.js',
    [
      'export const LANE_WIDTH = 24;',
      'export const ROW_HEIGHT = 64;',
      '',
      'export function laneX(lane) {',
      '  return 16 + lane * LANE_WIDTH;',
      '}',
      '',
      'export function edgeCurve(x1, y1, x2, y2) {',
      '  const dy = Math.min(26, Math.abs(y2 - y1) * 0.45);',
      '  return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;',
      '}',
      '',
    ].join('\n'),
  );
  jj(['describe', '-m', 'fix: route merge curves cleanly on narrow viewports']);
  const fixEdgesChange = changeId('@');
  jj(['bookmark', 'create', 'fix/edges', '-r', '@']);

  // Empty scratch child on fix/edges so the dashed empty-card look is visible
  jj(['new', '--no-edit', fixEdgesChange]);
  const emptyChange = changeId(`children(${fixEdgesChange})`);

  // Stacked feature off trunk: refactor -> feat/badges -> @ working copy
  jj(['new', 'main', '-m', 'refactor: extract card state badge helper']);
  write(
    'src/badges.js',
    [
      'export function statusTab(status) {',
      '  if (status === "edited") return "rewritten";',
      '  if (status === "followed") return "auto-rebased";',
      '  return status;',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'src/layout.js',
    [
      'export const LANE_WIDTH = 32;',
      'export const ROW_HEIGHT = 66;',
      '',
      'export function laneX(lane) {',
      '  return 20 + lane * LANE_WIDTH;',
      '}',
      '',
      'export function edgeCurve(x1, y1, x2, y2) {',
      '  const mid = (y1 + y2) / 2;',
      '  return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;',
      '}',
      '',
    ].join('\n'),
  );
  const refactorChange = changeId('@');

  jj(['new', refactorChange, '-m', 'feat: show commit swap diff on rewritten cards']);
  write(
    'src/cards.js',
    [
      'import { statusTab } from "./badges.js";',
      '',
      'export function renderSwap(before, after) {',
      '  return `${before.slice(0, 4)}→${after.slice(0, 4)}`;',
      '}',
      '',
      'export function renderStatusTab(status) {',
      '  const label = statusTab(status);',
      '  return label ? `<span class="tab st">${label}</span>` : "";',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'src/style.css',
    [
      '.card.changed {',
      '  border-color: var(--dry);',
      '  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dry) 22%, transparent);',
      '}',
      '',
    ].join('\n'),
  );
  const featBadgesChange = changeId('@');
  jj(['bookmark', 'create', 'feat/badges', '-r', featBadgesChange]);

  // Working copy @ on top of feat/badges
  jj(['new', featBadgesChange, '-m', 'wip: tighten timeline dot hit targets on mobile']);
  write(
    'src/timeline.js',
    [
      'export const MAX_TIMELINE_OPS = 14;',
      '',
      'export function timelineCaption(viewed, steps, head) {',
      '  if (viewed) return viewed.description;',
      '  if (steps.length) return `now + ${steps.length} planned`;',
      '  return `now · ${head?.description ?? ""}`;',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'src/style.css',
    [
      '.card.changed {',
      '  border-color: var(--dry);',
      '  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dry) 22%, transparent);',
      '}',
      '#timeline .op { width: 24px; min-height: 36px; }',
      '',
    ].join('\n'),
  );
  const wcChange = changeId('@');

  return {
    dir,
    ids: {
      fixEdgesChange,
      emptyChange,
      refactorChange,
      featBadgesChange,
      wcChange,
    },
  };
}

// ---------------------------------------------------------------- backend + proxy

async function startJjGraph(bin, repoDir) {
  const port = await freePort();
  const proc = spawn(bin, [repoDir, '--host', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`jj-graph exited early (${proc.exitCode}): ${stderr}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      if (res.ok) return { proc, baseUrl };
    } catch {
      // keep waiting
    }
    await sleep(80);
  }
  proc.kill();
  throw new Error(`Timed out waiting for jj-graph on ${baseUrl}: ${stderr}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

function startProxyServer(backendUrl) {
  const guiCss = readFileSync(GUI_CSS_PATH, 'utf8');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${backendUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers['content-type']
          ? { 'content-type': req.headers['content-type'] }
          : undefined,
        body,
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    if (url.pathname === '/__snapshot/opencode-gui') {
      const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
      const state = await fetch(`${backendUrl}/api/state`).then((r) => r.json());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderOpenCodeGuiHtml(state, guiCss, theme));
      return;
    }

    if (url.pathname === '/__snapshot/opencode-tui') {
      const state = await fetch(`${backendUrl}/api/state`).then((r) => r.json());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderOpenCodeTuiHtml(state));
      return;
    }

    // Serve public/ directly from disk so design edits show immediately without recompiling Rust.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = join(PUBLIC_DIR, rel);
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath)) {
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------- OpenCode plugin renderers

function renderOpenCodeGuiPanel({ state, section, mode = 'normal', selectedIndex = 0, focused = true }) {
  const rowsBySection = {
    graph: M.graphRows(state),
    plan: M.planRows(state),
    jjr: M.diagnosticRows(state),
    ops: M.opRows(state),
  };
  const summary = M.summarize(state);
  const sections = ['graph', 'plan', 'jjr', 'ops'];
  const titles = { graph: 'Graph', plan: 'Plan', jjr: 'jjr', ops: 'Ops' };
  const empty = {
    graph: 'No revisions in the revset.',
    plan: 'No dry run is open.',
    jjr: 'No diagnostics.',
    ops: 'No operations.',
  };
  const tabTone = (id) => {
    if (id === 'plan') return summary.plan.stale ? 'warn' : summary.plan.active ? 'busy' : undefined;
    if (id === 'jjr') return summary.diagnostics.errors ? 'error' : summary.diagnostics.warnings ? 'warn' : undefined;
    if (id === 'graph') return summary.conflicted ? 'error' : summary.divergent ? 'warn' : undefined;
    return undefined;
  };
  const list = rowsBySection[section];
  const idx = Math.min(Math.max(selectedIndex, 0), Math.max(list.length - 1, 0));
  const selected = list[idx];
  const badge = !focused ? 'PROMPT' : mode === 'detail' ? 'DETAIL' : 'NORMAL';
  const hints = !focused
    ? [
        { key: 'Click', label: 'focus this panel' },
        { key: '⌘⇧J', label: 'toggle panel' },
      ]
    : mode === 'detail'
      ? [
          { key: 'j/k', label: 'scroll' },
          { key: 'y', label: 'copy' },
          { key: 'esc', label: 'back' },
        ]
      : [
          { key: 'j/k', label: 'move' },
          { key: 'h/l', label: 'section' },
          { key: '⏎', label: 'details' },
          { key: 'y', label: 'copy' },
          { key: 'r', label: 'refresh' },
        ];

  const tabsHtml = sections
    .map((id, pos) => {
      const tone = tabTone(id);
      return `<button type="button" class="jjg-tab${id === section ? ' jjg-tab-on' : ''}">`
        + `<span class="jjg-muted">${pos + 1}</span> ${titles[id]}`
        + (tone ? `<span class="jjg-tone-${tone}"> ${M.glyph[tone]}</span>` : '')
        + `</button>`;
    })
    .join('');

  const bodyHtml =
    mode === 'detail' && selected
      ? `<div class="jjg-detail"><strong>${esc(selected.label)}</strong><pre>${esc(selected.lines.join('\n'))}</pre></div>`
      : `<div class="jjg-list" role="listbox">${
          list.length === 0
            ? `<p class="jjg-muted jjg-empty">${esc(empty[section])}</p>`
            : list
                .map(
                  (row, pos) =>
                    `<div role="option" class="jjg-row${pos === idx ? ' jjg-row-on' : ''}">`
                    + `<span class="jjg-lanes">${esc(row.lanes?.before ?? '')}</span>`
                    + `<span class="jjg-glyph jjg-tone-${row.tone}">${esc(row.glyph ?? M.glyph[row.tone])}</span>`
                    + `<span class="jjg-lanes">${esc(row.lanes?.after ?? '')}</span> `
                    + `<span class="jjg-label">${esc(row.label)}</span>`
                    + (row.detail ? `<span class="jjg-muted"> ${esc(row.detail)}</span>` : '')
                    + `</div>`,
                )
                .join('')
        }</div>`;

  const hintsHtml = hints
    .map(
      (h) =>
        `<span class="jjg-hint"><kbd class="oc-kbd">${esc(h.key)}</kbd><span class="jjg-muted">${esc(h.label)}</span></span>`,
    )
    .join('');

  return `<div class="jjg${focused ? ' is-focused' : ''}">
    <header class="jjg-head">
      <strong>jj graph</strong>
      <span class="jjg-muted">pulse</span>
      <span class="jjg-status jjg-muted">${esc(M.heading(state))}</span>
    </header>
    <nav class="jjg-tabs">${tabsHtml}</nav>
    ${bodyHtml}
    <footer class="jjg-hints">
      <span class="jjg-mode jjg-mode-${badge.toLowerCase()}">${badge}</span>
      ${hintsHtml}
    </footer>
  </div>`;
}

function renderOpenCodeGuiHtml(state, guiCss, theme) {
  const dark = theme === 'dark';
  const graphRows = M.graphRows(state);
  const wcIndex = Math.max(0, graphRows.findIndex((r) => r.glyph === '@'));
  const panels = [
    {
      title: '1 · Graph tab (NORMAL · focused)',
      html: renderOpenCodeGuiPanel({ state, section: 'graph', mode: 'normal', selectedIndex: wcIndex, focused: true }),
    },
    {
      title: '2 · Plan tab (NORMAL · dry run)',
      html: renderOpenCodeGuiPanel({ state, section: 'plan', mode: 'normal', selectedIndex: 0, focused: true }),
    },
    {
      title: '3 · jjr tab (NORMAL · diagnostics)',
      html: renderOpenCodeGuiPanel({ state, section: 'jjr', mode: 'normal', selectedIndex: 0, focused: true }),
    },
    {
      title: '4 · Graph row DETAIL mode',
      html: renderOpenCodeGuiPanel({ state, section: 'graph', mode: 'detail', selectedIndex: wcIndex, focused: true }),
    },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    --canvas: ${dark ? '#0d0f13' : '#efede7'};
    --frame: ${dark ? '#171a20' : '#ffffff'};
    --frame-border: ${dark ? '#2a303a' : '#d5d0c4'};
    --label: ${dark ? '#8d95a5' : '#646a76'};
    --v2-text-text-base: ${dark ? '#e6e8ed' : '#1b1d22'};
    --v2-text-text-muted: ${dark ? '#8a919f' : '#69707d'};
    --v2-background-bg-base: ${dark ? '#15181e' : '#ffffff'};
    --v2-background-bg-layer-01: ${dark ? '#222732' : '#eef0f4'};
    --v2-border-border-muted: ${dark ? '#2b303c' : '#e0ddd4'};
    --icon-success-base: ${dark ? '#52d6a8' : '#0b7a5c'};
    --icon-warning-base: ${dark ? '#f5aa4a' : '#b25e00'};
    --icon-critical-base: ${dark ? '#ff7a6e' : '#c0322b'};
    --icon-info-base: ${dark ? '#6ca8ff' : '#3568c9'};
    --jjg-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: var(--canvas);
    color: var(--v2-text-text-base);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
  .slot {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .slot-title {
    font: 600 11.5px var(--jjg-mono);
    color: var(--label);
    letter-spacing: 0.03em;
  }
  .pane {
    height: 340px;
    border: 1px solid var(--frame-border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--frame);
    box-shadow: ${dark ? '0 8px 24px rgb(0 0 0 / 0.35)' : '0 4px 16px rgb(0 0 0 / 0.08)'};
  }
  ${guiCss}
  .jjg.is-focused .jjg-row-on { background: var(--jjg-raised); }
  .oc-kbd {
    font: 600 11px var(--jjg-mono);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--jjg-border);
    background: var(--jjg-raised);
    color: var(--jjg-text);
  }
</style>
</head>
<body>
  <div class="grid">
    ${panels
      .map((p) => `<div class="slot"><div class="slot-title">${esc(p.title)}</div><div class="pane">${p.html}</div></div>`)
      .join('')}
  </div>
</body>
</html>`;
}

function renderOpenCodeTuiHtml(state) {
  const summary = M.summarize(state);
  const lines = M.summaryLines(summary);
  const graphRows = M.graphRows(state);
  const jjrRows = M.diagnosticRows(state);
  const wcIndex = Math.max(0, graphRows.findIndex((r) => r.glyph === '@'));

  const toneColor = (tone) =>
    ({ ok: '#52d6a8', warn: '#f5aa4a', error: '#ff7a6e', busy: '#6ca8ff', idle: '#7c8494' }[tone] ?? '#7c8494');

  const sidebarHtml = lines
    .map(
      (l) =>
        `<div class="t-row"><span style="color:${toneColor(l.tone)}">${M.glyph[l.tone]}</span> `
        + `<span class="muted">${esc(l.label.padEnd(5, ' '))}</span> <span>${esc(l.text)}</span></div>`,
    )
    .join('');

  const graphHtml = graphRows
    .map(
      (r, i) =>
        `<div class="t-row${i === wcIndex ? ' sel' : ''}">`
        + `<span class="muted">${esc(r.lanes?.before ?? '')}</span>`
        + `<span style="color:${toneColor(r.tone)}">${esc(r.glyph ?? M.glyph[r.tone])}</span>`
        + `<span class="muted">${esc(r.lanes?.after ?? '')}</span> `
        + `<span>${esc(r.label)}</span>`
        + (r.detail ? `<span class="muted">  ${esc(r.detail)}</span>` : '')
        + `</div>`,
    )
    .join('');

  const jjrHtml = jjrRows
    .map(
      (r, i) =>
        `<div class="t-row${i === 0 ? ' sel' : ''}">`
        + `<span style="color:${toneColor(r.tone)}">${esc(M.glyph[r.tone])}</span> `
        + `<span>${esc(r.label)}</span>`
        + (r.detail ? `<span class="muted">  ${esc(r.detail)}</span>` : '')
        + `</div>`,
    )
    .join('');

  const footerText = [
    summary.workingCopy ? `@ ${M.short(summary.workingCopy.change)}` : 'jj',
    `${summary.mutable} mutable`,
    summary.plan.active ? `plan ${summary.plan.steps.length}` : null,
    summary.diagnostics.errors ? `${summary.diagnostics.errors} error` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #0c0e12;
    color: #e6e8ed;
    font: 13px/1.55 "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }
  .layout {
    display: grid;
    grid-template-columns: 360px minmax(0, 1fr);
    gap: 16px;
    height: 700px;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }
  .term {
    background: #13161c;
    border: 1px solid #282e39;
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .term.grow { flex: 1; }
  .cap {
    font-size: 11px;
    color: #7c8494;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 10px;
  }
  .hdr {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 4px;
  }
  .tabs {
    display: flex;
    gap: 16px;
    margin-bottom: 10px;
  }
  .muted { color: #7c8494; }
  .rows { flex: 1; overflow: hidden; }
  .t-row {
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 1px 6px;
    margin: 0 -6px;
    border-radius: 3px;
  }
  .t-row.sel { background: #232936; }
  .hints {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #242a34;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    align-items: center;
    font-size: 12px;
  }
  .mode {
    background: #e6e8ed;
    color: #13161c;
    font-weight: 700;
    padding: 0 7px;
    border-radius: 2px;
  }
  .footer-bar {
    display: flex;
    justify-content: space-between;
    padding: 8px 12px;
    background: #181c24;
    border-radius: 6px;
    border: 1px solid #242a34;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div class="layout">
    <div class="col">
      <div class="term">
        <div class="cap">TUI · Session Sidebar Section</div>
        <div style="font-weight:700;margin-bottom:6px">jj graph</div>
        ${sidebarHtml}
      </div>
      <div class="term">
        <div class="cap">TUI · Home Footer Item</div>
        <div class="footer-bar">
          <span><span style="color:${toneColor(summary.tone)}">◆ </span>${esc(footerText)}</span>
          <span class="muted">ctrl+x j</span>
        </div>
      </div>
      <div class="term grow">
        <div class="cap">TUI · Panel (jjr tab)</div>
        <div class="hdr">
          <span><b>jj graph</b> <span class="muted">pulse</span></span>
          <span class="muted">${esc(M.heading(state))}</span>
        </div>
        <div class="tabs">
          <span class="muted">1 Graph</span>
          <span class="muted">2 Plan <span style="color:#6ca8ff">◐</span></span>
          <span><span class="muted">3 </span><b>jjr</b>${summary.diagnostics.warnings || summary.diagnostics.errors ? ` <span style="color:${summary.diagnostics.errors ? '#ff7a6e' : '#f5aa4a'}">${summary.diagnostics.errors ? '✖' : '▲'}</span>` : ''}</span>
          <span class="muted">4 Ops</span>
        </div>
        <div class="rows">${jjrHtml || '<div class="muted">no diagnostics</div>'}</div>
        <div class="hints">
          <span class="mode">NORMAL</span>
          <span>j/k <span class="muted">move</span></span>
          <span>h/l <span class="muted">section</span></span>
          <span>⏎ <span class="muted">details</span></span>
          <span>y <span class="muted">copy</span></span>
          <span>esc <span class="muted">close</span></span>
        </div>
      </div>
    </div>
    <div class="col">
      <div class="term grow">
        <div class="cap">TUI · Docked Panel (Graph tab · NORMAL)</div>
        <div class="hdr">
          <span><b>jj graph</b> <span class="muted">pulse</span></span>
          <span class="muted">${esc(M.heading(state))}</span>
        </div>
        <div class="tabs">
          <span><span class="muted">1 </span><b>Graph</b></span>
          <span class="muted">2 Plan <span style="color:#6ca8ff">◐</span></span>
          <span class="muted">3 jjr${summary.diagnostics.warnings || summary.diagnostics.errors ? ` <span style="color:${summary.diagnostics.errors ? '#ff7a6e' : '#f5aa4a'}">${summary.diagnostics.errors ? '✖' : '▲'}</span>` : ''}</span>
          <span class="muted">4 Ops</span>
        </div>
        <div class="rows">${graphHtml}</div>
        <div class="hints">
          <span class="mode">NORMAL</span>
          <span>j/k <span class="muted">move</span></span>
          <span>h/l <span class="muted">section</span></span>
          <span>⏎ <span class="muted">details</span></span>
          <span>y <span class="muted">copy</span></span>
          <span>r <span class="muted">refresh</span></span>
          <span>f <span class="muted">full screen</span></span>
          <span>esc <span class="muted">close</span></span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------- CDP driver

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startChrome(chromeBin) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jj-graph-chrome-'));
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const port = await new Promise((resolvePort, reject) => {
    let buf = '';
    const timeout = setTimeout(() => reject(new Error(`Chrome startup timed out: ${buf}`)), 15_000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited (${code}): ${buf}`));
    });
  });

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target found.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', rejectOpen, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      const fns = listeners.get(msg.method);
      if (fns) for (const fn of fns) fn(msg.params);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolveCmd, rejectCmd) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const once = (method, timeoutMs = 10_000) =>
    new Promise((resolveEv, rejectEv) => {
      const timer = setTimeout(() => rejectEv(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const fn = (params) => {
        clearTimeout(timer);
        listeners.get(method)?.delete(fn);
        resolveEv(params);
      };
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
    });

  await send('Page.enable');
  await send('Runtime.enable');

  let isMobile = false;

  return {
    send,
    async eval(expression) {
      const res = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`Eval error: ${res.exceptionDetails.text ?? JSON.stringify(res.exceptionDetails)}`);
      }
      return res.result?.value;
    },
    async open(url, { width, height, theme = 'dark', mobile = false }) {
      isMobile = mobile;
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 2,
        mobile,
      });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      await send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: theme },
          ...(mobile ? [] : [{ name: 'prefers-reduced-motion', value: 'reduce' }]),
        ],
      });
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url });
      await loaded;
    },
    async tapPoint(x, y) {
      if (isMobile) {
        await send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y, id: 1 }],
        });
        await send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
    },
    async tapCard(text) {
      const pt = await this.eval(`
        (() => {
          const vp = document.querySelector('#viewport').getBoundingClientRect();
          const card = [...document.querySelectorAll('#labels .card')]
            .find((el) => el.textContent.includes(${JSON.stringify(text)}));
          const target = card?.querySelector('.desc') ?? card?.querySelector('.body') ?? card;
          if (!target) return null;
          const r = target.getBoundingClientRect();
          const x = Math.min(vp.right - 12, Math.max(vp.left + 12, r.left + r.width / 2));
          const y = Math.min(vp.bottom - 12, Math.max(vp.top + 12, r.top + r.height / 2));
          return { x, y, rTop: r.top, rBottom: r.bottom, vpTop: vp.top, vpBottom: vp.bottom };
        })()
      `);
      if (!pt) throw new Error(`Could not find card containing "${text}"`);
      await this.tapPoint(pt.x, pt.y);
    },
    async dragGripToCard(fromText, toText) {
      const pts = await this.eval(`
        (() => {
          const find = (t) => [...document.querySelectorAll('#labels .card')].find((el) => el.textContent.includes(t));
          const a = find(${JSON.stringify(fromText)})?.querySelector('[data-grip]');
          const b = find(${JSON.stringify(toText)})?.querySelector('.desc');
          if (!a || !b) return null;
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return {
            x1: ra.left + ra.width / 2,
            y1: ra.top + ra.height / 2,
            x2: rb.left + rb.width / 2,
            y2: rb.top + rb.height / 2,
          };
        })()
      `);
      if (!pts) throw new Error(`Could not find drag endpoints "${fromText}" -> "${toText}"`);
      const { x1, y1, x2, y2 } = pts;
      if (isMobile) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1 }] });
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          await send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, id: 1 }],
          });
          await sleep(18);
        }
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x1 + (x2 - x1) * t,
            y: y1 + (y2 - y1) * t,
            buttons: 1,
          });
          await sleep(18);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
      }
    },
    async waitFor(fnExpr, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await this.eval(`Boolean(${fnExpr})`);
        if (ok) return;
        await sleep(60);
      }
      const diag = await this.eval(`({
        mode: document.querySelector('#mode')?.textContent,
        sheetOpen: document.querySelector('#sheet')?.open,
        sheetTitle: document.querySelector('#sheetTitle')?.textContent,
        opts: document.querySelectorAll('#sheetBody .opt').length,
        toast: document.querySelector('#toast')?.textContent,
      })`);
      throw new Error(`waitFor timed out: ${fnExpr} (state=${JSON.stringify(diag)})`);
    },
    async shot(filename) {
      await sleep(160);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const outPath = join(HERE, filename);
      writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log(`  captured ${filename}`);
    },
    async close() {
      try {
        ws.close();
      } catch {
        // ignore
      }
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, sleep(2000)]);
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore temp cleanup races
      }
    },
  };
}

// ---------------------------------------------------------------- API helpers

async function apiPost(baseUrl, path, body = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

// ---------------------------------------------------------------- main

async function main() {
  const bin = findBinary();
  const chromeBin = findChrome();
  console.log(`Using jj-graph: ${bin}`);
  console.log(`Using Chrome:   ${chromeBin}`);

  const fixture = createFixtureRepo();
  const { proc: backend, baseUrl: backendUrl } = await startJjGraph(bin, fixture.dir);
  const { server: proxy, url: appUrl } = await startProxyServer(backendUrl);
  const chrome = await startChrome(chromeBin);

  const MOBILE = { width: 390, height: 844, mobile: true };
  const DESKTOP = { width: 1280, height: 800, mobile: false };

  const openWeb = async (opts) => {
    await chrome.open(`${appUrl}/`, opts);
    await chrome.waitFor(`document.querySelectorAll('#labels .row').length >= 5`);
    // Fit graph neatly in viewport for consistent framing
    await chrome.eval(`document.querySelector('#fitBtn')?.click()`);
    await sleep(120);
  };

  try {
    console.log('\n1. Web UI — Live states');
    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.shot('web-mobile-dark-live.png');

    await openWeb({ ...MOBILE, theme: 'light' });
    await chrome.shot('web-mobile-light-live.png');

    // Mobile Inspector (select feat/badges card)
    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.tapCard('feat/badges');
    await chrome.waitFor(`!document.querySelector('#inspector').hidden`);
    await chrome.shot('web-mobile-dark-inspector.png');

    // Mobile Bottom Sheet: Drag grip -> drop menu
    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.dragGripToCard('feat/badges', 'fix/edges');
    await chrome.waitFor(`document.querySelector('#sheet')?.open && document.querySelectorAll('#sheetBody .opt').length > 2`);
    await chrome.shot('web-mobile-dark-sheet-menu.png');

    // Mobile Bottom Sheet: jjr Framework diagnostics
    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.eval(`document.querySelector('#jjrBtn')?.click()`);
    await chrome.waitFor(`document.querySelector('#sheet')?.open && !document.querySelector('#sheetBody').textContent.includes('Loading')`);
    await chrome.shot('web-mobile-dark-sheet-jjr.png');

    // Mobile History / Time-travel view
    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.eval(`
      (() => {
        const ops = [...document.querySelectorAll('#timeline .op:not(.snap)')];
        // Pick an earlier non-head operation so history visibly differs
        const target = ops[Math.max(0, ops.length - 4)];
        target?.click();
      })()
    `);
    await chrome.waitFor(`document.body.classList.contains('history')`);
    await chrome.eval(`document.querySelector('#fitBtn')?.click()`);
    await chrome.shot('web-mobile-dark-history.png');

    // Desktop Live (Light) + Inspector
    await openWeb({ ...DESKTOP, theme: 'light' });
    await chrome.tapCard('feat/badges');
    await chrome.waitFor(`!document.querySelector('#inspector').hidden`);
    await chrome.shot('web-desktop-light-live.png');

    // Desktop Wide Diff dialog (Dark)
    await openWeb({ ...DESKTOP, theme: 'dark' });
    await chrome.tapCard('feat/badges');
    await chrome.waitFor(`!document.querySelector('#inspector').hidden`);
    await chrome.eval(`document.querySelector('#inspector [data-action="v"]')?.click()`);
    await chrome.waitFor(`document.querySelector('#sheet')?.open && !document.querySelector('pre.diff')?.textContent.includes('Loading')`);
    await chrome.eval(`
      (() => {
        const btn = [...document.querySelectorAll('#sheetBody button')].find((b) => b.textContent.includes('Full diff'));
        btn?.click();
      })()
    `);
    await chrome.waitFor(`document.querySelector('pre.diff .add') !== null`);
    await chrome.shot('web-desktop-dark-diff.png');

    console.log('\n2. Web UI — Dry-run states');
    // Build a realistic 2-step dry run:
    // Step 1: describe feat/badges (marks feat/badges as rewritten, @ as auto-rebased)
    // Step 2: rebase empty scratch card onto main (marks empty card as rewritten)
    await apiPost(backendUrl, '/api/dry', {
      args: [
        'describe',
        fixture.ids.featBadgesChange,
        '-m',
        'feat: show commit swap diff on rewritten cards (polished)',
      ],
    });
    await apiPost(backendUrl, '/api/dry', {
      args: ['rebase', '-r', fixture.ids.emptyChange, '-o', 'main'],
    });

    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.shot('web-mobile-dark-dry-run.png');

    await openWeb({ ...DESKTOP, theme: 'dark' });
    await chrome.tapCard('feat/badges');
    await chrome.waitFor(`!document.querySelector('#inspector').hidden`);
    await chrome.shot('web-desktop-dark-dry-run.png');

    console.log('\n3. OpenCode Plugin — Desktop GUI & TUI');
    await chrome.open(`${appUrl}/__snapshot/opencode-gui?theme=dark`, {
      width: 1120,
      height: 770,
      theme: 'dark',
      mobile: false,
    });
    await chrome.shot('opencode-gui-dark.png');

    await chrome.open(`${appUrl}/__snapshot/opencode-gui?theme=light`, {
      width: 1120,
      height: 770,
      theme: 'light',
      mobile: false,
    });
    await chrome.shot('opencode-gui-light.png');

    await chrome.open(`${appUrl}/__snapshot/opencode-tui`, {
      width: 1120,
      height: 740,
      theme: 'dark',
      mobile: false,
    });
    await chrome.shot('opencode-tui-dark.png');

    console.log('\n4. Web UI — Conflict dry-run state');
    // Rebase refactor (edits src/layout.js) onto fix/edges (also edits src/layout.js) -> real conflict!
    await apiPost(backendUrl, '/api/dry', {
      args: ['rebase', '-s', fixture.ids.refactorChange, '-o', fixture.ids.fixEdgesChange],
    });
    await openWeb({ ...MOBILE, theme: 'dark' });
    await chrome.waitFor(`document.querySelector('.card.conflict') !== null`);
    await chrome.shot('web-mobile-dark-conflict.png');

    console.log('\nDone! All snapshots written to docs/snapshots/.');
  } finally {
    await chrome.close();
    proxy.close();
    backend.kill();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
