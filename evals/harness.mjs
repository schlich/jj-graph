#!/usr/bin/env node
/**
 * Runnable deterministic jjr eval harness.
 *
 * Spins up ephemeral real Jujutsu repositories, injects fault conditions from
 * `evals/scenarios.json`, exercises `JjrGraph`, `JjrGuardrailPipeline`,
 * `JjrJevAssistant`, `JjrPatterns`, and `JjrRunner` against `server.mjs`'s
 * dry-run engine, and prints a structured scorecard.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import {
  JjrGraph,
  JjrGuardrailPipeline,
  JjrJevAssistant,
  JjrPatterns,
  JjrRunner,
  planTimeTravelRecovery,
} from '../jjr/index.mjs';

/**
 * A throwaway colocated repository with an immutable `main` holding `seed`
 * files. Without `remote`, trunk() is root() and immutable_heads() is `main`.
 * With `remote`, `main` is pushed to a bare `origin`, so trunk() is
 * main@origin exactly as after `jj git clone`.
 */
function makeTempRepo({ seed = { 'README.md': '# seed\n' }, remote = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jjr-eval-'));
  const dir = remote ? path.join(root, 'local') : root;
  if (remote) {
    execFileSync('git', ['init', '--bare', '--initial-branch=main', path.join(root, 'origin.git')], { stdio: 'pipe' });
    mkdirSync(dir);
  }
  const jj = (...args) =>
    execFileSync('jj', ['--color', 'never', '--no-pager', ...args], { cwd: dir, stdio: 'pipe' }).toString();
  jj('git', 'init', '--colocate');
  jj('config', 'set', '--repo', 'user.name', 'jjr Eval');
  jj('config', 'set', '--repo', 'user.email', 'eval@jjr.local');
  for (const [file, text] of Object.entries(seed)) write(dir, file, text);
  jj('commit', '-m', 'seed trunk');
  jj('bookmark', 'create', 'main', '-r', '@-');
  if (remote) {
    jj('git', 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    jj('git', 'push', '--bookmark', 'main');
  } else {
    jj('config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'main');
  }
  const id = (rev, field = 'change_id') => jj('log', '--no-graph', '-r', rev, '-T', field).trim();
  return { root, dir, jj, id, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function write(dir, file, text) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

const getState = (app) => app.handle('GET', '/api/state', new URLSearchParams({ revset: 'all()' }), null);
const dry = (app, args) => app.handle('POST', '/api/dry', new URLSearchParams(), { args, revset: 'all()' });
const post = (app, route, body = {}) => app.handle('POST', route, new URLSearchParams(), { revset: 'all()', ...body });
const byDesc = (state, prefix) => state.nodes.find((n) => n.description.startsWith(prefix));
const byChange = (state, change) => state.nodes.find((n) => n.change === change);
const codes = (state) => state.jjr.diagnostics.map((d) => d.code);

const EVALUATORS = [
  {
    id: 'topo-01',
    name: 'Flatten accidental linear chain via Two-Part Dependency Test + parallelize',
    async run() {
      const repo = makeTempRepo();
      try {
        writeFileSync(path.join(repo.dir, 'auth.js'), 'export const logAuth = () => true;\n');
        repo.jj('commit', '-m', 'feat: add auth logging');
        writeFileSync(path.join(repo.dir, 'theme.css'), ':root { --dark: 1; }\n');
        repo.jj('commit', '-m', 'feat: add dark mode css');

        const app = createApp(repo.dir);
        const s0 = await getState(app);
        const auth = byDesc(s0, 'feat: add auth logging');
        const css = byDesc(s0, 'feat: add dark mode css');

        const dep = await app.handle('POST', '/api/jjr/dependency', new URLSearchParams(), {
          base: auth.change,
          child: css.change,
          revset: 'all()',
        });
        assert.equal(dep.verdict.outcome, 'parallelize');
        assert.ok(Array.isArray(dep.verdict.suggestedArgs));

        const runner = new JjrRunner({ app });
        const dry = await runner.dryRun(dep.verdict.suggestedArgs);
        assert.equal(dry.blocked, false);
        const graph = JjrGraph.fromJjGraphNodes(dry.state.nodes);
        const authAfter = graph.get(auth.change);
        const cssAfter = graph.get(css.change);
        assert.deepEqual(authAfter.parents, cssAfter.parents, 'both arms share the same trunk parent');
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'topo-02',
    name: 'Collapse mutually entangled helper rename + sole caller',
    async run() {
      const jev = new JjrJevAssistant(null);
      const res = await jev.assessDependency({
        base: {
          changeId: 'kkkkkkkk',
          description: 'wip: rename helper without caller update',
          touchedPaths: ['src/util.js'],
          diffExcerpt: '-function oldHelper()\n+function newHelper()',
        },
        child: {
          changeId: 'mmmmmmmm',
          description: 'update caller for newHelper',
          touchedPaths: ['src/util.js'],
          diffExcerpt: '-oldHelper()\n+newHelper()',
        },
      });
      assert.equal(res.verdict.outcome, 'collapse');
      assert.match(res.verdict.suggestedCommand, /jj squash/);
    },
  },
  {
    id: 'guard-01',
    name: 'MegamergeFence hard-blocks pushing local octopus megamerge',
    async run() {
      const repo = makeTempRepo();
      try {
        writeFileSync(path.join(repo.dir, 'arm1.js'), 'export const a = 1;\n');
        repo.jj('commit', '-m', 'feat: arm 1');
        repo.jj('new', 'main', '-m', 'feat: arm 2');
        writeFileSync(path.join(repo.dir, 'arm2.js'), 'export const b = 2;\n');
        repo.jj('commit', '-m', 'feat: arm 2');
        const app = createApp(repo.dir);
        const s0 = await getState(app);
        const arm1 = byDesc(s0, 'feat: arm 1');
        const arm2 = byDesc(s0, 'feat: arm 2');
        repo.jj('new', arm1.change, arm2.change, '-m', 'local: dev megamerge');

        const s1 = await getState(app);
        const mega = byDesc(s1, 'local: dev megamerge');
        const guard = await app.handle('POST', '/api/jjr/guard', new URLSearchParams(), {
          revset: 'all()',
          action: { type: 'push', targetChanges: [mega.change] },
          useJev: true,
        });
        assert.equal(guard.allowed, false);
        assert.ok(guard.blockers.some((b) => b.ruleName === 'MegamergeFence'));
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'guard-02',
    name: 'ImmutableBedrockGuard blocks mutating immutable() revision in dry-run',
    async run() {
      const repo = makeTempRepo();
      try {
        // Mark `main` immutable via repo config
        repo.jj('config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'main');
        const app = createApp(repo.dir);
        const s0 = await getState(app);
        const base = byDesc(s0, 'seed trunk');
        assert.equal(base.immutable, true);

        await assert.rejects(
          app.handle('POST', '/api/dry', new URLSearchParams(), {
            args: ['describe', base.change, '-m', 'illegal rewrite'],
            revset: 'all()',
          }),
          /ImmutableBedrockGuard/,
        );
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'guard-03',
    name: 'ColocatedGitGuard blocks `git checkout` in colocated repo',
    async run() {
      const graph = new JjrGraph([], { colocated: true });
      const pipeline = new JjrGuardrailPipeline();
      const res = pipeline.evaluate(graph, { type: 'git-interop', rawGitCommand: 'git checkout main' });
      assert.equal(res.allowed, false);
      assert.equal(res.blockers[0].ruleName, 'ColocatedGitGuard');
      // git is read-only: inspection passes, every other write is refused.
      assert.equal(pipeline.evaluate(graph, { type: 'git-interop', rawGitCommand: 'git log --oneline' }).allowed, true);
      for (const cmd of ['git fetch', 'git tag -a v1 -m v1', 'git stash', 'git submodule update']) {
        assert.equal(pipeline.evaluate(graph, { type: 'git-interop', rawGitCommand: cmd }).allowed, false, cmd);
      }
    },
  },
  {
    id: 'guard-04',
    name: 'DivergenceGuard halts stacking on divergent() and keeps recovery open',
    async run() {
      const repo = makeTempRepo();
      try {
        write(repo.dir, 'a.js', 'export const a = 1;\n');
        repo.jj('describe', '-m', 'feat: arm a');
        const a = repo.id('@');
        repo.jj('new', 'main');
        // Rewrite the change twice from the same operation: two visible commits, one change id.
        const before = repo.jj('op', 'log', '--no-graph', '-n', '1', '-T', 'id', '--ignore-working-copy').trim();
        repo.jj('describe', a, '-m', 'feat: arm a (one)');
        repo.jj('--at-op', before, 'describe', a, '-m', 'feat: arm a (two)');

        const app = createApp(repo.dir);
        const s0 = await getState(app);
        const divergent = s0.nodes.filter((n) => n.divergent);
        assert.equal(divergent.length, 2, 'two visible commits share one change id');
        assert.ok(codes(s0).includes('DIVERGENT_CHANGE'));

        // Stacking new work is halted, even though `jj new` rewrites nothing.
        await assert.rejects(dry(app, ['new', divergent[0].id, '-m', 'more work']), /DivergenceGuard/);

        // Recovery stays open: converge passes the guard, abandon restores 1:1 cardinality.
        const graph = JjrGraph.fromJjGraphNodes(s0.nodes);
        const pipeline = new JjrGuardrailPipeline();
        assert.equal(pipeline.evaluate(graph, { type: 'mutate', args: ['converge', '--no-interactive'], targetChanges: [] }).allowed, true);
        const drop = divergent.find((n) => n.description.startsWith('feat: arm a (two)'));
        const r = await dry(app, ['abandon', drop.id]);
        assert.equal(r.result.changed, true);
        assert.equal(r.state.nodes.filter((n) => n.divergent).length, 0, 'finalDivergentCount === 0');
        assert.ok(byDesc(r.state, 'feat: arm a (one)'));
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'guard-05',
    name: 'Never force-rewrite immutable(): --ignore-immutable and squash --into bedrock are refused',
    async run() {
      const repo = makeTempRepo();
      try {
        write(repo.dir, 'fix.js', 'export const fix = 1;\n');
        repo.jj('describe', '-m', 'fix: patch');
        const app = createApp(repo.dir);
        const s0 = await getState(app);
        const base = byDesc(s0, 'seed trunk');
        await assert.rejects(dry(app, ['describe', '--ignore-immutable', base.change, '-m', 'rewrite']), /--ignore-immutable/);
        // `--into` is a destination jj rewrites, not a read-only parent.
        await assert.rejects(dry(app, ['squash', '--into', base.change]), /ImmutableBedrockGuard/);
        // A guarded runner refuses the flag before it reaches jj.
        const runner = new JjrRunner({ app });
        const planned = runner.planMutation(JjrGraph.fromJjGraphNodes(s0.nodes), [], 'jj abandon', ['--ignore-immutable', 'abandon', base.change]);
        assert.equal(planned.blocked, true);
        assert.equal(planned.guardResult.blockers[0].ruleName, 'ImmutableBedrockGuard');
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'sdlc-01',
    name: 'Tidy First?: detect structural refactor above behavioral and dry-run slip-below',
    async run() {
      const repo = makeTempRepo();
      try {
        writeFileSync(path.join(repo.dir, 'feat.js'), 'export const feature = 1;\n');
        repo.jj('commit', '-m', 'feat: add billing feature');
        writeFileSync(path.join(repo.dir, 'clean.js'), 'export const clean = 1;\n');
        repo.jj('commit', '-m', 'refactor: extract billing helper');

        const app = createApp(repo.dir);
        const diag = await app.handle('GET', '/api/jjr/diagnose', new URLSearchParams({ revset: 'all()' }), null);
        const issue = diag.diagnostics.find((d) => d.code === 'UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL');
        assert.ok(issue, 'should flag structural commit above behavioral commit');

        const runner = new JjrRunner({ app });
        const fixed = await runner.dryRun(issue.suggestedArgs);
        assert.equal(fixed.blocked, false);
        const after = JjrGraph.fromJjGraphNodes(fixed.state.nodes).diagnose();
        assert.equal(
          after.some((d) => d.code === 'UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL'),
          false,
          'ordering warning resolved in dry-run preview',
        );
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'sdlc-02',
    name: 'TDD red-test verification: split --parallel, prove red with jj run, fold back under the same change id',
    async run() {
      const repo = makeTempRepo();
      try {
        write(repo.dir, 'answer.js', 'export const answer = 42;\n');
        write(repo.dir, 'test/answer.sh', 'grep -q "answer = 42" answer.js\n');
        repo.jj('describe', '-m', 'feat: answer with its test');
        const change = repo.id('@');
        const app = createApp(repo.dir, { verifyCommand: 'sh test/answer.sh' });
        const runner = new JjrRunner({ app });
        const recipe = JjrPatterns.verifyRedTest(['answer.js'], { changeId: change, description: 'feat: answer with its test' });
        const [, split, runTests, fold, back] = recipe.steps;
        assert.equal(runTests.dryRunnable, false, 'running tests is not a repository operation');

        const lifted = await runner.dryRun(split.args);
        assert.equal(lifted.blocked, false);
        const tests = lifted.state.nodes.find((n) => n.wc);
        assert.notEqual(tests.change, change, '@ is the tests-only sibling');
        assert.deepEqual(byChange(lifted.state, change).paths, ['answer.js'], 'the implementation keeps the change id');

        // Red: the tests fail without the implementation.
        const red = await post(app, '/api/jjr/verify', { range: '@' });
        assert.equal(red.results.length, 1);
        assert.equal(red.results[0].state, 'red', 'test verified red in isolation');

        await runner.dryRun(fold.args);
        const done = await runner.dryRun(back.args);
        const work = done.state.nodes.filter((n) => !n.immutable && !(n.empty && !n.description.trim()));
        assert.equal(work.length, 1, 'finalMutableCount === 1');
        assert.equal(work[0].change, change, 'the change id survived the round trip');
        assert.deepEqual([...work[0].paths].sort(), ['answer.js', 'test/answer.sh']);
        assert.ok(work[0].wc, '@ is back on the change');

        // Green: the folded change passes.
        const green = await post(app, '/api/jjr/verify', { range: change });
        assert.equal(green.results[0].state, 'green', `allCommitsPassTests === true (${green.results[0].output})`);
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'sdlc-03',
    name: 'Branch by Abstraction previews 5 clean steps via dry-run',
    async run() {
      const repo = makeTempRepo();
      try {
        const app = createApp(repo.dir);
        const runner = new JjrRunner({ app });
        const recipe = JjrPatterns.branchByAbstraction('payments');
        // Replace trunk() with main for throwaway repo without remote
        const adapted = {
          ...recipe,
          steps: recipe.steps.map((s) => ({ ...s, args: s.args?.map((a) => (a === 'trunk()' ? 'main' : a)) ?? null })),
        };
        const outcomes = await runner.previewPattern(adapted);
        assert.equal(outcomes.length, 5);
        assert.ok(outcomes.every((o) => !o.blocked && !o.skipped));
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'sdlc-04',
    name: 'Fixups made in a megamerge route to their owning arms via jj absorb; Jev ranks ambiguous hunks',
    async run() {
      const repo = makeTempRepo();
      try {
        write(repo.dir, 'auth.js', 'export const session = "cookie";\n');
        repo.jj('describe', '-m', 'feat: auth sessions');
        const auth = repo.id('@');
        repo.jj('new', 'main', '-m', 'feat: billing invoices');
        write(repo.dir, 'billing.js', 'export const invoice = "pdf";\n');
        const billing = repo.id('@');
        repo.jj('new', auth, billing, '-m', 'local: dev megamerge');
        // Integration testing reveals a fix, made in the megamerge itself.
        write(repo.dir, 'auth.js', 'export const session = "signed-cookie";\n');
        const mega = repo.id('@');

        const app = createApp(repo.dir);
        const s0 = await getState(app);
        assert.equal(s0.jjr.summary.shape, 'megamerge');
        const polluted = s0.jjr.diagnostics.find((d) => d.code === 'MEGAMERGE_NOT_EMPTY');
        assert.ok(polluted, 'the megamerge carries edits that can never be pushed');
        assert.ok(codes(s0).includes('MEGAMERGE_AS_WORKING_COPY'));

        const runner = new JjrRunner({ app });
        const routed = await runner.dryRun(polluted.suggestedArgs);
        assert.equal(routed.blocked, false);
        assert.equal(byChange(routed.state, mega).empty, true, 'megamergeUnpolluted === true');
        const { text } = await app.handle('GET', '/api/show', new URLSearchParams({ rev: byChange(routed.state, auth).id, mode: 'diff' }), null);
        assert.match(text, /signed-cookie/, 'the fix landed in the auth arm');

        // A hunk absorb cannot attribute (a new file) is ranked by Jev's router instead.
        const jev = new JjrJevAssistant(null);
        const ranked = await jev.routeHunk('diff --git a/billing/pdf-fonts.js\n+export const invoiceFont = "mono";', [
          { changeId: auth, description: 'feat: auth sessions', touchedPaths: ['auth.js'] },
          { changeId: billing, description: 'feat: billing invoices', touchedPaths: ['billing.js'] },
        ]);
        assert.equal(ranked.decision.choice, billing);
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'time-01',
    name: 'Jev recommends surgical evolog recovery when sibling arms changed',
    async run() {
      const jev = new JjrJevAssistant(null);
      const rec = await jev.recommendRecovery({
        symptom: 'Change A broke after bad refactor',
        targetChangeId: 'kkkkkkkk',
        siblingArmsModifiedSince: true,
        bookmarkOrTopologyCorrupted: false,
      });
      assert.equal(rec.decision.choice, 'evolog');
      const plan = planTimeTravelRecovery({
        scope: 'single-change',
        targetChangeId: 'kkkkkkkk',
        targetEvologCommit: 'a1b2c3d4e5f60718',
      });
      assert.equal(plan.axis, 'evolog');
      assert.match(plan.command, /^jj restore --from a1b2c3d4 --to kkkkkkkk$/);
      // An earlier version can also be named by offset.
      const byOffset = planTimeTravelRecovery({ scope: 'single-change', targetChangeId: 'kkkkkkkk', targetEvologOffset: 1 });
      assert.equal(byOffset.command, 'jj restore --from kkkkkkkk/1 --to kkkkkkkk');
    },
  },
  {
    id: 'conv-01',
    name: 'Post-merge convergence: fetch a landed arm, then rebase the remaining roots onto trunk()',
    async run() {
      const repo = makeTempRepo({ remote: true });
      try {
        write(repo.dir, 'one.js', 'export const one = 1;\n');
        repo.jj('describe', '-m', 'feat: arm 1');
        const arm1 = repo.id('@', 'commit_id');
        repo.jj('new', 'main', '-m', 'feat: arm 2');
        write(repo.dir, 'two.js', 'export const two = 2;\n');
        const arm2 = repo.id('@');
        repo.jj('new');
        // Arm 1 lands upstream (a fast-forward of origin's main), then we fetch.
        execFileSync('git', ['--git-dir', path.join(repo.root, 'origin.git'), 'fetch', path.join(repo.dir, '.git'), `${arm1}:refs/heads/main`], { stdio: 'pipe' });
        repo.jj('git', 'fetch');

        const app = createApp(repo.dir);
        const s0 = await getState(app);
        assert.equal(s0.jjr.preflight.trunk.commitId, arm1, 'trunk() follows main@origin');
        assert.equal(byDesc(s0, 'feat: arm 1').immutable, true, 'arm1InImmutable === true');
        assert.ok(s0.jjr.diagnostics.some((d) => d.code === 'ROOT_BEHIND_TRUNK' && d.affectedChanges.includes(arm2)));

        const outcomes = await new JjrRunner({ app }).previewPattern(JjrPatterns.postMergeConvergence());
        assert.deepEqual(outcomes.map((o) => o.skipped), [true, false, true]);
        const after = outcomes[1].state;
        assert.deepEqual(byChange(after, arm2).parents, [arm1], 'arm2RebasedOnTrunk === true');
        assert.equal(codes(after).includes('ROOT_BEHIND_TRUNK'), false);
        assert.equal(after.jjr.summary.shape, 'single');
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'pre-01',
    name: 'Pre-flight: unresolvable trunk() blocks rewrites; ::trunk() stays bedrock when immutable_heads() omits it',
    async run() {
      const repo = makeTempRepo();
      try {
        write(repo.dir, 'work.js', 'export const work = 1;\n');
        repo.jj('describe', '-m', 'feat: work');
        const app = createApp(repo.dir);

        // trunk() points at a bookmark that no longer exists.
        repo.jj('config', 'set', '--repo', 'revset-aliases."trunk()"', 'present(gone)');
        const s0 = await getState(app);
        assert.equal(s0.jjr.preflight.trunk.resolved, false);
        assert.ok(codes(s0).includes('PREFLIGHT_UNRESOLVED'));
        await assert.rejects(dry(app, ['new', '-m', 'more']), /PreflightGuard/);

        // trunk() resolves, but immutable_heads() was overridden without it.
        repo.jj('config', 'set', '--repo', 'revset-aliases."trunk()"', 'main');
        repo.jj('config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'none()');
        write(repo.dir, 'work.js', 'export const work = 2;\n'); // a new operation, so a fresh pre-flight
        const s1 = await getState(app);
        const seed = byDesc(s1, 'seed trunk');
        assert.equal(seed.immutable, false, 'jj itself would let this rewrite through');
        assert.ok(codes(s1).includes('PREFLIGHT_TRUNK_NOT_IMMUTABLE'));
        await assert.rejects(dry(app, ['describe', seed.change, '-m', 'rewrite shared history']), /ImmutableBedrockGuard/);
        const ok = await dry(app, ['describe', '-m', 'feat: work, described']);
        assert.equal(ok.result.changed, true, 'work above trunk() stays mutable');
      } finally {
        repo.cleanup();
      }
    },
  },
  {
    id: 'pub-01',
    name: 'Publishing Gate: verify the stack (jj fix + jj run), publish green bottom layers, keep the rest local',
    async run() {
      const repo = makeTempRepo({ seed: { 'README.md': '# seed\n', 'check.sh': 'test ! -e broken.txt\n' } });
      try {
        repo.jj('config', 'set', '--repo', 'fix.tools.trim.command', '["sed", "-e", "s/[[:space:]]*$//"]');
        repo.jj('config', 'set', '--repo', 'fix.tools.trim.patterns', '["glob:**/*.txt"]');
        write(repo.dir, 'a.txt', 'layer a\n');
        repo.jj('commit', '-m', 'feat: layer a');
        write(repo.dir, 'broken.txt', 'layer b breaks the build\n');
        repo.jj('commit', '-m', 'feat: layer b');
        write(repo.dir, 'c.txt', 'layer c   \n');
        repo.jj('commit', '-m', 'feat: layer c');

        const app = createApp(repo.dir, { verifyCommand: 'sh check.sh' });
        const s0 = await getState(app);
        const [a, b, c] = ['feat: layer a', 'feat: layer b', 'feat: layer c'].map((d) => byDesc(s0, d).change);

        // Nothing is known before verification, so a push is refused.
        const unverified = await post(app, '/api/jjr/publish-plan', { rev: a });
        assert.equal(unverified.layers[0].publishable, false);

        const v = await post(app, '/api/jjr/verify', { range: 'trunk()..@' });
        const state = (change) => v.results.find((r) => r.changeId === change);
        assert.equal(state(a).state, 'green');
        assert.equal(state(b).state, 'red');
        assert.equal(state(c).formatted, false, 'jj fix found trailing whitespace in layer c');
        assert.deepEqual(state(c).unformattedFiles, ['c.txt']);

        const plan = await post(app, '/api/jjr/publish-plan', { rev: c });
        assert.deepEqual(plan.publish, [a], 'only the green bottom layer publishes');
        assert.deepEqual(plan.keepLocal, [b, c]);
        assert.deepEqual(plan.commands, [`jj git push -c ${a.slice(0, 8)}`]);

        // Bookmarks are export pointers: the gate applies to them too.
        await assert.rejects(dry(app, ['bookmark', 'set', 'feat-b', '-r', b]), /PublishingGate/);
        const ok = await dry(app, ['bookmark', 'set', 'feat-a', '-r', a]);
        assert.equal(ok.result.changed, true);
        assert.deepEqual(ok.result.warnings, []);
      } finally {
        repo.cleanup();
      }
    },
  },
];

export async function runEvalHarness() {
  const results = [];
  for (const ev of EVALUATORS) {
    const start = performance.now();
    try {
      await ev.run();
      results.push({ id: ev.id, name: ev.name, pass: true, ms: Math.round(performance.now() - start) });
    } catch (err) {
      results.push({ id: ev.id, name: ev.name, pass: false, ms: Math.round(performance.now() - start), error: err.message });
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await runEvalHarness();
  let failed = 0;
  console.log('\njjr Deterministic Eval Scorecard');
  console.log('──────────────────────────────────────────────────────────────────');
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.id.padEnd(8)} ${r.name} (${r.ms}ms)`);
    if (!r.pass) {
      failed++;
      console.log(`       -> ${r.error}`);
    }
  }
  console.log('──────────────────────────────────────────────────────────────────');
  console.log(`${results.length - failed}/${results.length} scenarios passed\n`);
  process.exit(failed ? 1 : 0);
}
