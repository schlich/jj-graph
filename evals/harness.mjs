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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jjr-eval-'));
  const jj = (...args) =>
    execFileSync('jj', ['--color', 'never', '--no-pager', ...args], { cwd: dir, stdio: 'pipe' }).toString();
  jj('git', 'init');
  jj('config', 'set', '--repo', 'user.name', 'jjr Eval');
  jj('config', 'set', '--repo', 'user.email', 'eval@jjr.local');
  writeFileSync(path.join(dir, 'README.md'), '# seed\n');
  jj('commit', '-m', 'seed trunk');
  jj('bookmark', 'create', 'main', '-r', '@-');
  jj('config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'main');
  return { dir, jj, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const getState = (app) => app.handle('GET', '/api/state', new URLSearchParams({ revset: 'all()' }), null);
const byDesc = (state, prefix) => state.nodes.find((n) => n.description.startsWith(prefix));

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
