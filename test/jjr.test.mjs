import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, createServer } from '../server.mjs';
import {
  JevClient,
  JjrGraph,
  JjrGuardrailPipeline,
  JjrJevAssistant,
  JjrNarrator,
  JjrPatterns,
  JjrRunner,
  JjrTypeError,
  asBookmark,
  asChangeId,
  asCommitId,
  asOpId,
  buildDagGraphViewModel,
  buildDependencyGate,
  buildGuardrailBanner,
  buildTriageCard,
  choice,
  noul,
  planTimeTravelRecovery,
  renderDagTui,
  renderDependencyGateTui,
  renderGuardrailBannerTui,
  renderTriageTui,
  score,
  toGuiAlertProps,
  toGuiDagRows,
  toGuiDependencyCard,
  toGuiTriageProps,
} from '../jjr/index.mjs';

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jjr-test-'));
  const jj = (...args) =>
    execFileSync('jj', ['--color', 'never', '--no-pager', ...args], { cwd: dir, stdio: 'pipe' }).toString();
  jj('git', 'init');
  jj('config', 'set', '--repo', 'user.name', 'Test');
  jj('config', 'set', '--repo', 'user.email', 'test@example.com');
  writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  jj('commit', '-m', 'base');
  jj('bookmark', 'create', 'main', '-r', '@-');
  return { dir, jj };
}

test('branded identity-state validators separate ChangeId, CommitId, OpId, and BookmarkName', () => {
  assert.equal(asChangeId('KMPQRSTU'), 'kmpqrstu');
  assert.equal(asCommitId('017147EF9A2C'), '017147ef9a2c');
  assert.equal(asOpId('abcdef0123456789'), 'abcdef0123456789');
  assert.equal(asBookmark('feat/auth'), 'feat/auth');

  assert.throws(
    () => asChangeId('017147ef9a2c'),
    (err) => err instanceof JjrTypeError && /CommitId/.test(err.message),
  );
  assert.throws(
    () => asCommitId('kmpqrstu'),
    (err) => err instanceof JjrTypeError && /ChangeId/.test(err.message),
  );
  assert.throws(() => asBookmark('bad name'), JjrTypeError);
});

test('Two-Part Dependency Test handles all verdicts including calibrated uncertainty band', () => {
  const par = JjrGraph.evaluateDependency({
    base: 'kkkkkkkk',
    child: 'mmmmmmmm',
    causalProbability: 0.12,
    reviewabilityProbability: 0.88,
  });
  assert.equal(par.outcome, 'parallelize');
  assert.deepEqual(par.suggestedArgs, ['parallelize', 'kkkkkkkk', 'mmmmmmmm']);

  const col = JjrGraph.evaluateDependency({
    base: 'kkkkkkkk',
    child: 'mmmmmmmm',
    causalProbability: 0.91,
    reviewabilityProbability: 0.15,
  });
  assert.equal(col.outcome, 'collapse');
  assert.deepEqual(col.suggestedArgs, ['squash', '--from', 'mmmmmmmm', '--into', 'kkkkkkkk']);

  const stk = JjrGraph.evaluateDependency({
    base: 'kkkkkkkk',
    child: 'mmmmmmmm',
    causalProbability: 0.89,
    reviewabilityProbability: 0.85,
  });
  assert.equal(stk.outcome, 'stack');

  const amb = JjrGraph.evaluateDependency({
    base: 'kkkkkkkk',
    child: 'mmmmmmmm',
    causalProbability: 0.52,
    reviewabilityProbability: 0.85,
  });
  assert.equal(amb.outcome, 'confirm');
  assert.equal(amb.suggestedArgs, null);
});

test('JjrGuardrailPipeline enforces all 6 deterministic rules and permits divergence recovery', () => {
  const graph = new JjrGraph(
    [
      {
        changeId: 'kkkkkkkk',
        currentCommit: { commitId: '11111111', changeId: 'kkkkkkkk', parentCommits: [], isEmpty: false, conflict: { isConflicted: false }, author: 't', timestamp: '', touchedPaths: [], description: 'main' },
        zone: 'immutable',
        parents: [],
        children: ['mmmmmmmm', 'nnnnnnnn'],
        bookmarks: ['main'],
        isWorkingCopy: false,
        intent: 'behavioral',
        verification: { formatted: true, builds: true, testsPass: true },
        isDivergent: false,
      },
      {
        changeId: 'mmmmmmmm',
        currentCommit: { commitId: '22222222', changeId: 'mmmmmmmm', parentCommits: ['11111111'], isEmpty: false, conflict: { isConflicted: false }, author: 't', timestamp: '', touchedPaths: ['a.js'], description: 'feat: arm A' },
        zone: 'mutable',
        parents: ['kkkkkkkk'],
        children: ['pppppppp'],
        bookmarks: [],
        isWorkingCopy: false,
        intent: 'behavioral',
        verification: { formatted: true, builds: true, testsPass: true },
        isDivergent: false,
      },
      {
        changeId: 'nnnnnnnn',
        currentCommit: { commitId: '33333333', changeId: 'nnnnnnnn', parentCommits: ['11111111'], isEmpty: false, conflict: { isConflicted: true, conflictedPaths: ['b.js'] }, author: 't', timestamp: '', touchedPaths: ['b.js'], description: 'feat: arm B' },
        zone: 'mutable',
        parents: ['kkkkkkkk'],
        children: ['pppppppp'],
        bookmarks: [],
        isWorkingCopy: false,
        intent: 'behavioral',
        verification: { formatted: true, builds: false, testsPass: false },
        isDivergent: false,
      },
      {
        changeId: 'pppppppp',
        currentCommit: { commitId: '44444444', changeId: 'pppppppp', parentCommits: ['22222222', '33333333'], isEmpty: true, conflict: { isConflicted: false }, author: 't', timestamp: '', touchedPaths: [], description: 'local: dev megamerge' },
        zone: 'mutable',
        parents: ['mmmmmmmm', 'nnnnnnnn'],
        children: [],
        bookmarks: ['oops-mega'],
        isWorkingCopy: true,
        intent: 'megamerge',
        verification: { formatted: true, builds: true, testsPass: true },
        isDivergent: false,
      },
    ],
    { colocated: true },
  );

  const pipeline = new JjrGuardrailPipeline();
  assert.equal(pipeline.evaluate(graph, { type: 'mutate', targetChanges: ['kkkkkkkk'], command: 'jj describe kkkkkkkk' }).blockers[0].ruleName, 'ImmutableBedrockGuard');
  assert.equal(pipeline.evaluate(graph, { type: 'push', targetChanges: ['pppppppp'] }).blockers[0].ruleName, 'MegamergeFence');
  assert.equal(pipeline.evaluate(graph, { type: 'push', targetChanges: ['nnnnnnnn'] }).blockers[0].ruleName, 'PublishingGate');
  assert.equal(pipeline.evaluate(graph, { type: 'git-interop', rawGitCommand: 'git checkout main' }).blockers[0].ruleName, 'ColocatedGitGuard');
  assert.equal(pipeline.evaluate(graph, { type: 'workspace-add', reason: 'switch-branch' }).blockers[0].ruleName, 'WorkspaceDisciplineGuard');
  assert.equal(pipeline.evaluate(graph, { type: 'push', targetChanges: ['mmmmmmmm'] }).allowed, true);

  // Graph diagnostics should catch megamerge carrying a bookmark
  assert.ok(graph.diagnose().some((d) => d.code === 'MEGAMERGE_WITH_BOOKMARK'));

  // DivergenceGuard blocks rebase but allows converge/abandon recovery
  const divGraph = new JjrGraph([
    {
      changeId: 'zzzzzzzz',
      currentCommit: { commitId: 'aaaaaaaa', changeId: 'zzzzzzzz', parentCommits: [], isEmpty: false, conflict: { isConflicted: false }, author: 't', timestamp: '', touchedPaths: [], description: 'div 1' },
      zone: 'mutable', parents: [], children: [], bookmarks: [], isWorkingCopy: false, intent: 'behavioral',
      verification: { formatted: true, builds: true, testsPass: true }, isDivergent: true,
    },
  ]);
  assert.equal(pipeline.evaluate(divGraph, { type: 'mutate', targetChanges: ['zzzzzzzz'], command: 'jj rebase -s zzzzzzzz -o main' }).allowed, false);
  assert.equal(pipeline.evaluate(divGraph, { type: 'mutate', targetChanges: ['zzzzzzzz'], command: 'jj converge' }).allowed, true);
});

test('JevClient uses exact POST /v1/systemone wire format and JjrJevAssistant powers System-One workflows', async () => {
  let capturedUrl = '';
  let capturedBody = null;
  let capturedAuth = '';

  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedAuth = init.headers.authorization;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        answers: {
          intent: { choice: 'structural', probabilities: { structural: 0.92, behavioral: 0.08 }, confidence: 0.92 },
          entangled: { noul: 0.14 },
          publishReadiness: { score: 2.75, legend: 'ready-to-land', probabilities: [0.02, 0.05, 0.2, 0.73], confidence: 0.73 },
          hasDebugOrSecrets: { noul: 0.03 },
        },
        usage: { input_tokens: 180 },
      }),
    };
  };

  const client = new JevClient({ apiKey: 'ts_test_key', baseURL: 'https://api.typesafe.ai', defaultModel: 'jev-latest', fetchImpl: mockFetch });
  const jev = new JjrJevAssistant(client);
  assert.equal(jev.mode, 'live-jev');

  const triage = await jev.triageChange({
    changeId: 'kmpqrstu',
    description: 'refactor: extract token parser',
    touchedPaths: ['src/token.ts'],
    diffExcerpt: 'export function parseToken() {}',
  });

  assert.equal(capturedUrl, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(capturedAuth, 'Bearer ts_test_key');
  assert.equal(capturedBody.model, 'jev-latest');
  assert.equal(capturedBody.questions.intent.type, 'choice');
  assert.equal(capturedBody.questions.entangled.type, 'noul');
  assert.equal(capturedBody.questions.publishReadiness.type, 'score');
  assert.equal(triage.source, 'live-jev');
  assert.equal(triage.answers.intent.choice, 'structural');

  // Also check question builders & offline workflows
  assert.equal(choice('q', { a: 'A' }).type, 'choice');
  assert.equal(score('q', ['low', 'high']).type, 'score');
  assert.equal(noul('q').type, 'noul');

  const offlineJev = new JjrJevAssistant(null);
  const routed = await offlineJev.routeHunk('diff --git a/src/billing/invoice.ts', [
    { changeId: 'kkkkkkkk', description: 'feat: auth cookies', touchedPaths: ['src/auth/cookie.ts'] },
    { changeId: 'mmmmmmmm', description: 'feat: billing invoice export', touchedPaths: ['src/billing/invoice.ts'] },
  ]);
  assert.equal(routed.decision.choice, 'mmmmmmmm');

  const rec = await offlineJev.recommendRecovery({
    symptom: 'Regression in arm A',
    targetChangeId: 'kkkkkkkk',
    siblingArmsModifiedSince: true,
    bookmarkOrTopologyCorrupted: false,
  });
  assert.equal(rec.decision.choice, 'evolog');
});

test('JjrNarrator combines Jev classification with light LLM transport and offline fallback', async () => {
  const narratorWithLlm = new JjrNarrator({
    jev: new JjrJevAssistant(null),
    transport: {
      isConfigured: true,
      async complete() {
        return JSON.stringify({
          conventionalTitle: 'refactor(session): extract cookie signature verifier',
          bookmarkSlug: 'refactor/session-verifier',
          rationale: 'Pure structural extraction with zero behavioral changes.',
        });
      },
    },
  });
  const named = await narratorWithLlm.suggestChangeName({
    changeId: 'kmpqrstu',
    description: 'refactor: extract verifier',
    touchedPaths: ['src/session.ts'],
    diffExcerpt: 'function verifyCookie() {}',
  });
  assert.equal(named.source, 'llm');
  assert.equal(named.detectedIntent, 'structural');
  assert.equal(named.bookmarkSlug, 'refactor/session-verifier');

  const offlineNarrator = new JjrNarrator({ jev: new JjrJevAssistant(null), transport: null });
  const fallback = await offlineNarrator.suggestChangeName({
    touchedPaths: ['src/auth/login.test.ts'],
    diffExcerpt: 'test("logs in")',
  });
  assert.equal(fallback.source, 'deterministic');
  assert.equal(fallback.detectedIntent, 'test-harness');
});

test('Portable TUI and GUI adapters consume shared ViewModels consistently', async () => {
  const graph = new JjrGraph([
    {
      changeId: 'kkkkkkkk',
      currentCommit: { commitId: '11111111', changeId: 'kkkkkkkk', parentCommits: [], isEmpty: false, conflict: { isConflicted: false }, author: 't', timestamp: '', touchedPaths: [], description: 'main' },
      zone: 'immutable', parents: [], children: ['mmmmmmmm'], bookmarks: ['main'], isWorkingCopy: false, intent: 'behavioral',
      verification: { formatted: true, builds: true, testsPass: true }, isDivergent: false,
    },
    {
      changeId: 'mmmmmmmm',
      currentCommit: { commitId: '22222222', changeId: 'mmmmmmmm', parentCommits: ['11111111'], isEmpty: false, conflict: { isConflicted: false }, author: 't', timestamp: '', touchedPaths: ['a.js'], description: 'feat: session store' },
      zone: 'mutable', parents: ['kkkkkkkk'], children: [], bookmarks: ['feat/session'], isWorkingCopy: true, intent: 'behavioral',
      verification: { formatted: true, builds: true, testsPass: true }, isDivergent: false,
    },
  ]);

  const vm = buildDagGraphViewModel(graph, 'mmmmmmmm');
  const tui = renderDagTui(vm, false);
  const guiRows = toGuiDagRows(vm);
  assert.match(tui, /JJR REVISION GRAPH/);
  assert.match(tui, /▸\s+@ mmmmmmmm/);
  assert.equal(guiRows.length, 2);
  assert.equal(guiRows[0].selected, true);

  const banner = buildGuardrailBanner([{ allowed: false, ruleName: 'MegamergeFence', severity: 'block', message: 'Blocked', remediation: 'Push arm' }]);
  assert.match(renderGuardrailBannerTui(banner), /MegamergeFence/);
  assert.equal(toGuiAlertProps(banner).tone, 'danger');

  const depVm = buildDependencyGate({
    baseLabel: 'kkkkkkkk',
    childLabel: 'mmmmmmmm',
    verdict: JjrGraph.evaluateDependency({ base: 'kkkkkkkk', child: 'mmmmmmmm', childCausallyDependsOnBase: false, baseIndependentlyReviewable: true }),
  });
  assert.match(renderDependencyGateTui(depVm), /PARALLELIZE/);
  assert.equal(toGuiDependencyCard(depVm).outcome, 'parallelize');

  const triage = await new JjrJevAssistant(null).triageChange({ changeId: 'mmmmmmmm', description: 'feat: session store', touchedPaths: ['a.js'] });
  const triageVm = buildTriageCard('mmmmmmmm', triage);
  assert.match(renderTriageTui(triageVm), /JEV CHANGE TRIAGE/);
  assert.equal(toGuiTriageProps(triageVm).intent.label, 'behavioral');

  const plan = planTimeTravelRecovery({ scope: 'single-change', targetChangeId: 'mmmmmmmm', targetEvologCommit: '1234567890abcdef' });
  assert.equal(plan.axis, 'evolog');
  assert.match(JjrPatterns.publishCommand('gerrit', 'mmmmmmmm'), /jj gerrit upload/);
});

test('server.mjs exposes jjr endpoints, serves /docs, and enforces guardrails on /api/dry', async (t) => {
  const { dir, jj } = makeTempRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  jj('config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'main');
  writeFileSync(path.join(dir, 'auth.js'), 'export const auth = true;\n');
  jj('commit', '-m', 'feat: add auth');
  writeFileSync(path.join(dir, 'cleanup.js'), 'export const tidy = true;\n');
  jj('commit', '-m', 'refactor: extract cleanup');

  const app = createApp(dir);
  const st = await app.handle('GET', '/api/state', new URLSearchParams({ revset: 'all()' }), null);
  assert.ok(st.jjr);
  assert.equal(st.jjr.summary.warnings, 1);

  const diag = await app.handle('GET', '/api/jjr/diagnose', new URLSearchParams({ revset: 'all()' }), null);
  assert.ok(diag.diagnostics.some((d) => d.code === 'UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL'));

  const ui = await app.handle('GET', '/api/jjr/ui', new URLSearchParams({ revset: 'all()' }), null);
  assert.match(ui.tui, /JJR REVISION GRAPH/);
  assert.ok(ui.guiRows.length >= 3);

  const auth = st.nodes.find((n) => n.description.startsWith('feat: add auth'));
  const cleanup = st.nodes.find((n) => n.description.startsWith('refactor: extract cleanup'));
  const base = st.nodes.find((n) => n.description.startsWith('base'));

  const triage = await app.handle('POST', '/api/jjr/triage', new URLSearchParams(), { rev: cleanup.change, revset: 'all()' });
  assert.equal(triage.answers.intent.choice, 'structural');

  const naming = await app.handle('POST', '/api/jjr/suggest-name', new URLSearchParams(), { rev: auth.change, revset: 'all()' });
  assert.ok(naming.conventionalTitle.includes('auth'));

  const dep = await app.handle('POST', '/api/jjr/dependency', new URLSearchParams(), { base: auth.change, child: cleanup.change, revset: 'all()' });
  assert.equal(dep.verdict.outcome, 'parallelize');

  // Guardrail blocks mutating immutable base via /api/dry
  await assert.rejects(
    app.handle('POST', '/api/dry', new URLSearchParams(), { args: ['describe', base.change, '-m', 'nope'], revset: 'all()' }),
    /ImmutableBedrockGuard/,
  );

  // JjrRunner dry-run works end-to-end on mutable revisions
  const runner = new JjrRunner({ app });
  const dryRes = await runner.dryRun(['rebase', '-r', cleanup.change, '-B', auth.change]);
  assert.equal(dryRes.blocked, false);
  assert.equal(dryRes.result.changed, true);

  // HTTP server serves /docs
  const server = createServer(dir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/docs`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /jjr — A Framework for Jujutsu/);
  assert.equal(/django/i.test(html), false, 'docs must never mention Django');
});
