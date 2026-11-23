// Unit tests for the parts of jjr that implement the jj graph architecture
// reference: the command model, pre-flight, guardrails, diagnostics,
// canonical shapes, recipes, and layered publishing. No repository needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_SHAPES,
  FORGE_ADAPTERS,
  JjrGraph,
  JjrGuardrailPipeline,
  JjrJevAssistant,
  JjrPatterns,
  JjrRunner,
  SDLC_LIFECYCLE,
  buildPreflightPanel,
  buildPublishPlan,
  describeMutation,
  isReadOnlyGitCommand,
  renderPreflightTui,
  renderPublishPlanTui,
  toGuiPreflightProps,
  toGuiPublishPlanRows,
  verificationState,
} from '../jjr/index.mjs';

const ROOT = '0'.repeat(40);
const GREEN = { formatted: true, builds: true, testsPass: true, verified: true };
const UNKNOWN = { formatted: null, builds: null, testsPass: null, verified: false };

let commitSeq = 0;
/** A change for an in-memory graph. */
function change(changeId, parents, extra = {}) {
  const { description = changeId, paths = [], empty = false, conflict = false, ...rest } = extra;
  commitSeq += 1;
  return {
    changeId,
    currentCommit: {
      commitId: extra.commitId ?? commitSeq.toString(16).padStart(8, 'a').padEnd(40, '0'),
      changeId,
      parentCommits: [],
      isEmpty: empty,
      conflict: conflict ? { isConflicted: true, conflictedPaths: [] } : { isConflicted: false },
      author: 't',
      timestamp: '',
      touchedPaths: paths,
      filesCount: paths.length,
      description,
    },
    zone: 'mutable',
    parents,
    children: [],
    bookmarks: [],
    isWorkingCopy: false,
    intent: 'behavioral',
    verification: GREEN,
    isDivergent: false,
    ...rest,
  };
}

const trunk = (id = 'kkkkkkkk', extra = {}) => change(id, [], { zone: 'immutable', bookmarks: ['main'], description: 'trunk', ...extra });
const preflight = (over = {}) => ({
  trunk: { resolved: true, changeId: 'kkkkkkkk', commitId: 'f'.repeat(40), immutable: true, isRoot: false },
  immutableHeads: { resolved: true, heads: [{ changeId: 'kkkkkkkk', commitId: 'f'.repeat(40), immutable: true }] },
  divergent: [],
  remotes: ['origin'],
  gitCompat: [],
  ...over,
});

test('describeMutation classifies what a jj command does to each revision it names', () => {
  const r = (args) => describeMutation(args).rewrites;
  assert.deepEqual(r(['new', 'main']), [], 'jj new only reads its parents');
  assert.deepEqual(describeMutation(['new', 'main']).parents, ['main']);
  assert.deepEqual(r(['new', '-B', 'x']), ['x'], 'insert-before rewrites the target');
  assert.deepEqual(r(['new', '-A', 'x']), ['x+'], 'insert-after rewrites the target\'s children');
  assert.deepEqual(r(['squash']), ['@', '@-']);
  assert.deepEqual(r(['squash', '-r', 'x']), ['x', 'x-']);
  assert.deepEqual(r(['squash', '--from', 'x']), ['x', '@']);
  assert.deepEqual(r(['squash', '--into', 'y']), ['y', '@']);
  assert.deepEqual(r(['rebase', '-r', 'x', '-B', 'y']), ['x', 'y']);
  assert.deepEqual(r(['rebase', '-d', 'main']), ['@'], 'rebase defaults to -b @');
  assert.deepEqual(r(['restore', '--from', 'x/1', '--to', 'x']), ['x']);
  assert.deepEqual(r(['restore', 'file.txt']), ['@']);
  assert.deepEqual(r(['duplicate', 'x']), [], 'duplicate only reads its sources');
  assert.deepEqual(r(['revert', '-r', 'x', '-o', '@']), []);
  assert.deepEqual(r(['absorb', '--from', 'm']), ['m']);
  assert.deepEqual(r(['describe', '-m', 'msg']), ['@']);
  assert.deepEqual(describeMutation(['split', '--parallel', 'impl.js']).filesets, ['impl.js']);
  // bookmark set's -B means --allow-backwards, not insert-before.
  const bookmark = describeMutation(['bookmark', 'set', 'feat', '-B', '-r', 'x']);
  assert.deepEqual(bookmark.rewrites, []);
  assert.deepEqual(bookmark.bookmarks, [{ names: ['feat'], target: 'x' }]);
  assert.deepEqual(describeMutation(['b', 'create', 'feat']).bookmarks, [{ names: ['feat'], target: '@' }]);
  assert.equal(describeMutation(['abandon', 'x']).recovery, true);
  assert.equal(describeMutation(['metaedit', '--update-change-id', 'x']).recovery, true);
  assert.equal(describeMutation(['op', 'restore', 'abc']).recovery, true);
  assert.equal(describeMutation(['rebase', '-s', 'x', '-o', 'y']).recovery, false);
  assert.equal(describeMutation(['--ignore-immutable', 'describe', 'x']).ignoreImmutable, true);
  assert.equal(describeMutation(['git', 'push']).known, false);
});

test('JjrGraph.resolve handles @, parent/child operators, bookmarks, workspaces, and id prefixes', () => {
  const g = new JjrGraph([
    trunk(),
    change('mmmmmmmm', ['kkkkkkkk'], { commitId: 'abcdef1234' + '0'.repeat(30) }),
    change('nnnnnnnn', ['mmmmmmmm'], { isWorkingCopy: true, bookmarks: ['feat/x'], workspaces: ['agent-a'] }),
  ]);
  const ids = (rev) => g.resolve(rev).map((c) => c.changeId);
  assert.deepEqual(ids('@'), ['nnnnnnnn']);
  assert.deepEqual(ids('@-'), ['mmmmmmmm']);
  assert.deepEqual(ids('@--'), ['kkkkkkkk']);
  assert.deepEqual(ids('main+'), ['mmmmmmmm']);
  assert.deepEqual(ids('(mm)+'), ['nnnnnnnn']);
  assert.deepEqual(ids('feat/x-'), ['mmmmmmmm']);
  assert.deepEqual(ids('agent-a@'), ['nnnnnnnn']);
  assert.deepEqual(ids('abcdef'), ['mmmmmmmm']);
  assert.deepEqual(ids('trunk()'), [], 'functions are left to jj');
});

test('ImmutableBedrockGuard: --ignore-immutable, rewritten destinations, and ::trunk() when immutable_heads() omits it', () => {
  const pipeline = new JjrGuardrailPipeline();
  const g = new JjrGraph([trunk(), change('mmmmmmmm', ['kkkkkkkk'], { isWorkingCopy: true })]);
  const block = (args) => pipeline.evaluate(g, { type: 'mutate', args, targetChanges: describeMutation(args).rewrites });
  assert.equal(block(['squash', '-r', 'mmmmmmmm']).blockers[0]?.ruleName, 'ImmutableBedrockGuard', 'squash -r rewrites the immutable parent');
  assert.equal(block(['new', '-B', 'main']).blockers[0]?.ruleName, 'ImmutableBedrockGuard');
  assert.equal(block(['new', '-A', 'main']).allowed, true, 'only trunk\'s mutable children are rebased');
  assert.equal(block(['new', 'main']).allowed, true);
  assert.equal(block(['describe', '--ignore-immutable', 'mmmmmmmm']).blockers[0]?.ruleName, 'ImmutableBedrockGuard');

  // immutable_heads() was overridden without trunk(): trunk history is still bedrock.
  const misconfigured = new JjrGraph(
    [change('kkkkkkkk', [], { bookmarks: ['main'] }), change('mmmmmmmm', ['kkkkkkkk'], { isWorkingCopy: true })],
    {},
    { preflight: preflight({ trunk: { resolved: true, changeId: 'kkkkkkkk', commitId: 'f'.repeat(40), immutable: false, isRoot: false } }) },
  );
  const r = pipeline.evaluate(misconfigured, { type: 'mutate', args: ['describe', 'main', '-m', 'x'], targetChanges: ['main'] });
  assert.equal(r.blockers[0]?.ruleName, 'ImmutableBedrockGuard');
  assert.ok(r.warnings.some((w) => w.ruleName === 'PreflightGuard'));
  assert.ok(misconfigured.diagnose().some((d) => d.code === 'PREFLIGHT_TRUNK_NOT_IMMUTABLE'));
  // Server-resolved targets carry the same facts.
  assert.equal(pipeline.evaluate(misconfigured, { type: 'mutate', command: 'jj describe x', targetChanges: [], resolvedTargets: [{ changeId: 'qqqqqqqq', inTrunk: true }] }).allowed, false);
});

test('PreflightGuard blocks when trunk() does not resolve and warns when shared history is unprotected', () => {
  const pipeline = new JjrGuardrailPipeline();
  const action = { type: 'mutate', args: ['new'], targetChanges: [] };
  const unresolved = new JjrGraph([], {}, { preflight: preflight({ trunk: { resolved: false, error: 'trunk() resolves to no revision' } }) });
  assert.equal(pipeline.evaluate(unresolved, action).blockers[0]?.ruleName, 'PreflightGuard');
  assert.equal(unresolved.diagnose()[0].code, 'PREFLIGHT_UNRESOLVED');

  const atRoot = { resolved: true, changeId: 'z'.repeat(32), commitId: ROOT, immutable: true, isRoot: true };
  const noBedrock = new JjrGraph([], {}, { preflight: preflight({ trunk: atRoot, immutableHeads: { resolved: true, heads: [{ changeId: 'z'.repeat(32), commitId: ROOT }] } }) });
  const r = pipeline.evaluate(noBedrock, action);
  assert.equal(r.allowed, true);
  assert.equal(r.warnings[0]?.ruleName, 'PreflightGuard');
  assert.ok(noBedrock.diagnose().some((d) => d.code === 'PREFLIGHT_NO_BEDROCK'));

  // No pre-flight context (an in-memory graph): nothing to check.
  assert.equal(pipeline.evaluate(new JjrGraph([]), action).allowed, true);

  const compat = new JjrGraph([], {}, { preflight: preflight({ gitCompat: [{ kind: 'lfs', message: 'LFS in use' }], keepRefs: 9000 }) });
  assert.deepEqual(compat.diagnose().map((d) => d.code).filter((c) => c !== 'LOSSY_MERGE_CONFIG'), ['GIT_COMPAT', 'GC_RECOMMENDED']);
  const panel = buildPreflightPanel(compat.preflight, compat.diagnose());
  assert.equal(panel.status, 'attention');
  assert.match(renderPreflightTui(panel), /PRE-FLIGHT/);
  assert.equal(toGuiPreflightProps(panel).trunkProtected, true);
});

test('PublishingGate: bookmarks are gated like pushes; unverified snapshots warn on bookmarks and block pushes', () => {
  const pipeline = new JjrGuardrailPipeline();
  const g = new JjrGraph([
    trunk(),
    change('mmmmmmmm', ['kkkkkkkk'], { verification: GREEN }),
    change('nnnnnnnn', ['mmmmmmmm'], { verification: UNKNOWN }),
    change('pppppppp', ['nnnnnnnn'], { verification: { ...GREEN, testsPass: false } }),
    change('qqqqqqqq', ['kkkkkkkk'], { empty: true, description: 'feat: planned', intent: 'blueprint', verification: UNKNOWN }),
  ]);
  const bookmark = (id) => pipeline.evaluate(g, { type: 'bookmark', bookmarks: ['b'], targetChanges: [id] });
  const push = (id) => pipeline.evaluate(g, { type: 'push', targetChanges: [id] });
  assert.equal(bookmark('mmmmmmmm').allowed, true);
  assert.equal(bookmark('nnnnnnnn').allowed, true);
  assert.equal(bookmark('nnnnnnnn').warnings[0].ruleName, 'PublishingGate');
  assert.equal(push('nnnnnnnn').blockers[0].ruleName, 'PublishingGate');
  assert.equal(bookmark('pppppppp').blockers[0].ruleName, 'PublishingGate');
  assert.equal(push('qqqqqqqq').allowed, true, 'an empty blueprint documents a plan and needs no verification');
  // A dry-run step that creates a bookmark carries its targets.
  const step = pipeline.evaluate(g, { type: 'mutate', args: ['bookmark', 'set', 'x', '-r', 'pppppppp'], targetChanges: [], bookmarks: [{ names: ['x'], targetChanges: ['pppppppp'] }] });
  assert.equal(step.blockers[0].ruleName, 'PublishingGate');
  // Pushing by bookmark name resolves the bookmark.
  const named = new JjrGraph([trunk(), change('mmmmmmmm', ['kkkkkkkk'], { bookmarks: ['feat'], verification: UNKNOWN })]);
  assert.equal(pipeline.evaluate(named, { type: 'push', targetChanges: [], bookmark: 'feat' }).allowed, false);

  assert.equal(verificationState(GREEN), 'green');
  assert.equal(verificationState(UNKNOWN), 'unknown');
  assert.equal(verificationState({ formatted: false }), 'red');
  assert.equal(verificationState({ formatted: true, builds: true, testsPass: true }), 'green', 'explicit results count');
});

test('ColocatedGitGuard lets only read-only git through, with the jj equivalent for the rest', () => {
  for (const cmd of ['git status', 'git log --oneline', 'git -C sub diff HEAD~1', 'git show abc', 'git branch', 'git branch -a', 'git tag -l "v*"', 'git config --get user.name', 'git stash list', 'git remote -v', 'git blame x.js']) {
    assert.equal(isReadOnlyGitCommand(cmd), true, cmd);
  }
  for (const cmd of ['git checkout main', 'git fetch', 'git pull', 'git push', 'git commit -m x', 'git branch -D x', 'git branch new', 'git tag -a v1', 'git tag v1', 'git stash', 'git reset --hard', 'git submodule update', 'git config user.name x']) {
    assert.equal(isReadOnlyGitCommand(cmd), false, cmd);
  }
  const pipeline = new JjrGuardrailPipeline();
  const g = new JjrGraph([], { colocated: true });
  assert.match(pipeline.evaluate(g, { type: 'git-interop', rawGitCommand: 'git fetch' }).blockers[0].remediation, /jj git fetch/);
  assert.equal(pipeline.evaluate(new JjrGraph([], { colocated: false }), { type: 'git-interop', rawGitCommand: 'git fetch' }).allowed, true);
});

test('ChangeIdAddressingGuard warns when mutable work is named by commit id', () => {
  const pipeline = new JjrGuardrailPipeline();
  const commitId = '0123456789abcdef'.padEnd(40, '0');
  const g = new JjrGraph([trunk(), change('mmmmmmmm', ['kkkkkkkk'], { commitId })]);
  const r = pipeline.evaluate(g, { type: 'mutate', args: ['describe', commitId.slice(0, 12), '-m', 'x'], targetChanges: [commitId] });
  assert.equal(r.allowed, true);
  assert.equal(r.warnings[0].ruleName, 'ChangeIdAddressingGuard');
  assert.match(r.warnings[0].message, /→ mmmmmmmm/);
  assert.equal(pipeline.evaluate(g, { type: 'mutate', args: ['describe', 'mmmmmmmm', '-m', 'x'], targetChanges: ['mmmmmmmm'] }).warnings.length, 0);
});

test('DivergenceGuard halts stacking (even jj new) and counts divergence the loaded revset missed', () => {
  const pipeline = new JjrGuardrailPipeline();
  const g = new JjrGraph([trunk()], {}, { preflight: preflight({ divergent: ['wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww'] }) });
  assert.equal(pipeline.evaluate(g, { type: 'mutate', args: ['new', 'main'], targetChanges: [] }).blockers[0].ruleName, 'DivergenceGuard');
  assert.equal(pipeline.evaluate(g, { type: 'mutate', args: ['abandon', 'abc123'], targetChanges: [] }).allowed, true);
  assert.equal(pipeline.evaluate(g, { type: 'bookmark', targetChanges: [] }).allowed, false);
  assert.ok(g.diagnose().some((d) => d.code === 'DIVERGENT_CHANGE' && d.affectedChanges.includes('wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww')));
});

test('diagnostics cover activation, megamerge hygiene, conflicts, bundled tests, trunk drift, and deep stacks', () => {
  const codes = (g) => g.diagnose().map((d) => d.code);
  const find = (g, code) => g.diagnose().find((d) => d.code === code);

  // Activation must be a tiny top-level switch.
  const act = new JjrGraph([
    trunk(),
    change('mmmmmmmm', ['kkkkkkkk'], { intent: 'activation', description: 'enable new billing', paths: ['a.js', 'b.js', 'c.js', 'd.js'] }),
    change('nnnnnnnn', ['mmmmmmmm'], { paths: ['billing.js', 'billing.test.js'] }),
  ]);
  assert.deepEqual(find(act, 'ACTIVATION_NOT_ON_TOP').suggestedArgs, ['rebase', '-r', 'mmmmmmmm', '-A', 'nnnnnnnn']);
  assert.ok(codes(act).includes('ACTIVATION_NOT_ISOLATED'));

  // A megamerge stays an empty composition node with an empty @ above it.
  const mega = new JjrGraph([
    trunk(),
    change('mmmmmmmm', ['kkkkkkkk']),
    change('nnnnnnnn', ['kkkkkkkk']),
    change('pppppppp', ['mmmmmmmm', 'nnnnnnnn'], { description: 'local: dev megamerge', isWorkingCopy: true, intent: 'megamerge', paths: ['a.js'] }),
  ]);
  assert.deepEqual(find(mega, 'MEGAMERGE_NOT_EMPTY').suggestedArgs, ['absorb', '--from', 'pppppppp']);
  assert.deepEqual(find(mega, 'MEGAMERGE_AS_WORKING_COPY').suggestedArgs, ['new', 'pppppppp']);
  assert.equal(mega.classifyShape(), 'megamerge');

  // Conflicts: resolve in a child, then fold the resolution down.
  const conflicted = new JjrGraph([trunk(), change('mmmmmmmm', ['kkkkkkkk'], { conflict: true })]);
  assert.deepEqual(find(conflicted, 'CONFLICTED_CHANGE').suggestedArgs, ['new', 'mmmmmmmm']);
  const resolved = new JjrGraph([trunk(), change('mmmmmmmm', ['kkkkkkkk'], { conflict: true }), change('nnnnnnnn', ['mmmmmmmm'])]);
  assert.deepEqual(find(resolved, 'CONFLICTED_CHANGE').suggestedArgs, ['squash', '--from', 'nnnnnnnn', '--into', 'mmmmmmmm']);

  // Bundled tests, bookmark tips, and roots that missed trunk().
  const g = new JjrGraph(
    [
      change('jjjjjjjj', [], { zone: 'immutable', description: 'old trunk' }),
      trunk('kkkkkkkk', { parents: ['jjjjjjjj'] }),
      change('mmmmmmmm', ['jjjjjjjj'], { paths: ['src/pay.ts'] }),
      change('nnnnnnnn', ['kkkkkkkk'], { paths: ['src/pay.ts', 'src/pay.test.ts'], isWorkingCopy: true, bookmarks: ['feat/pay'] }),
    ],
    {},
    { preflight: preflight() },
  );
  assert.deepEqual(find(g, 'BEHAVIOR_WITHOUT_TESTS').affectedChanges, ['mmmmmmmm']);
  assert.deepEqual(find(g, 'ROOT_BEHIND_TRUNK').suggestedArgs, ['rebase', '-s', 'mmmmmmmm', '-o', 'trunk()']);
  assert.deepEqual(find(g, 'EDITING_BOOKMARK_TIP').suggestedArgs, ['new', 'nnnnnnnn']);

  // A deep linear stack is usually a horizontal slicing.
  const ids = ['llllllll', 'mmmmmmmm', 'nnnnnnnn', 'oooooooo', 'pppppppp', 'qqqqqqqq', 'rrrrrrrr'];
  const deep = new JjrGraph([trunk(), ...ids.map((id, i) => change(id, [i ? ids[i - 1] : 'kkkkkkkk']))]);
  assert.equal(find(deep, 'DEEP_STACK').affectedChanges.length, 7);
  assert.equal(new JjrGraph(deep.all(), { maxStackDepth: 8 }).diagnose().some((d) => d.code === 'DEEP_STACK'), false);
});

test('classifyShape maps the mutable zone onto the canonical DAG shapes', () => {
  const scratch = (parent) => change('wwwwwwww', [parent], { isWorkingCopy: true, empty: true, description: '' });
  const shape = (...changes) => new JjrGraph([trunk(), ...changes]).summary();
  assert.equal(shape(scratch('kkkkkkkk')).shape, 'resting');
  assert.equal(shape(scratch('kkkkkkkk')).resting, true);
  assert.equal(shape(change('mmmmmmmm', ['kkkkkkkk']), scratch('mmmmmmmm')).shape, 'single');
  assert.equal(shape(change('mmmmmmmm', ['kkkkkkkk']), change('nnnnnnnn', ['mmmmmmmm'])).shape, 'stack');
  assert.equal(shape(change('mmmmmmmm', ['kkkkkkkk']), change('nnnnnnnn', ['kkkkkkkk'])).shape, 'parallel');
  assert.equal(shape(change('mmmmmmmm', ['kkkkkkkk']), change('nnnnnnnn', ['mmmmmmmm']), change('oooooooo', ['mmmmmmmm'])).shape, 'branching');
  for (const s of ['resting', 'single', 'stack', 'parallel', 'megamerge', 'branching']) assert.ok(CANONICAL_SHAPES[s].publishing);
});

test('recipes follow the reference and stay dry-runnable where jj allows', () => {
  const red = JjrPatterns.verifyRedTest(['src/impl.js'], { changeId: 'mmmmmmmmmmmm', description: 'feat: impl' });
  assert.deepEqual(red.steps.map((s) => s.args?.[0] ?? null), ['edit', 'split', null, 'squash', 'edit']);
  assert.deepEqual(red.steps[3].args, ['squash', '--from', '@', '--into', 'mmmmmmmmmmmm', '--use-destination-message'], 'tests fold into the implementation, which kept the change id');
  assert.equal(red.steps.some((s) => (s.args ?? []).includes('@+')), false);

  const conv = JjrPatterns.postMergeConvergence();
  assert.deepEqual(conv.steps[1].args, ['rebase', '-s', 'roots(trunk()..@)', '-o', 'trunk()', '--skip-emptied']);
  assert.equal(conv.steps.some((s) => s.command.includes('all:')), false, 'jj 0.47 rejects the all: prefix');

  assert.deepEqual(JjrPatterns.characterizationTestsBelow('mmmmmmmm', 'parser').steps[0].args, ['new', '--no-edit', '-B', 'mmmmmmmm', '-m', 'test: characterize parser']);
  assert.equal(JjrPatterns.expandContract('the user id column', { from: 'int', to: 'uuid' }).steps.length, 3);
  assert.deepEqual(JjrPatterns.isolateActivation('nnnnnnnn', 'new-billing').steps[0].args, ['new', 'nnnnnnnn', '-m', 'feat: activate new-billing']);
  const shared = JjrPatterns.extractSharedPrimitive(['aaaa', 'bbbb'], 'feat: shared parser', { paths: ['src/parse.js'] });
  assert.deepEqual(shared.steps[0].args, ['new', '--no-edit', '-B', 'aaaa', '-B', 'bbbb', '-m', 'feat: shared parser']);
  assert.deepEqual(shared.steps[1].args, ['squash', '--from', '@', '--into', 'aaaa- & bbbb-', 'src/parse.js']);
  assert.deepEqual(JjrPatterns.resolveConflictCleanly('mmmmmmmm').steps.filter((s) => s.dryRunnable).map((s) => s.args), [['new', 'mmmmmmmm'], ['squash']]);
  assert.equal(JjrPatterns.stackValidation('trunk()..@', 'npm test').steps[1].command, "jj run --ignore-changes -r '(trunk()..@) & mutable()' -- npm test");
  assert.deepEqual(JjrPatterns.composeAgentWorkspaces(['agent-a', 'agent-b']).steps[0].args, ['new', 'agent-a@', 'agent-b@', '-m', 'local: agents megamerge']);
  assert.deepEqual(JjrPatterns.squashWorkflow('feat: x').steps.map((s) => s.args[0]), ['describe', 'new', 'squash']);
  assert.deepEqual(JjrPatterns.editWorkflow('mmmmmmmm', 'refactor: seam').steps.map((s) => s.args[0]), ['edit', 'new', 'next']);
  for (const forge of Object.keys(FORGE_ADAPTERS)) assert.match(JjrPatterns.publishCommand(forge, 'mmmmmmmmmmmm'), /mmmmmmmm$/);
  assert.deepEqual(SDLC_LIFECYCLE.map((p) => p.phase), [1, 2, 3, 4, 5, 6]);
});

test('planLayeredPublish publishes the green bottom of a stack and keeps the rest local', () => {
  const g = new JjrGraph([
    trunk(),
    change('mmmmmmmm', ['kkkkkkkk'], { verification: GREEN }),
    change('nnnnnnnn', ['mmmmmmmm'], { verification: GREEN }),
    change('oooooooo', ['nnnnnnnn'], { verification: UNKNOWN }),
  ]);
  const runner = new JjrRunner({ jev: new JjrJevAssistant(null) });
  const plan = runner.planLayeredPublish(g, 'oooooooo');
  assert.deepEqual(plan.publish, ['mmmmmmmm', 'nnnnnnnn']);
  assert.deepEqual(plan.keepLocal, ['oooooooo']);
  assert.deepEqual(plan.commands, ['jj git push -c mmmmmmmm', 'jj git push -c nnnnnnnn']);
  const gerrit = runner.planLayeredPublish(g, 'oooooooo', { forge: 'gerrit' });
  assert.deepEqual(gerrit.commands, ['jj gerrit upload -r nnnnnnnn'], 'a stack-aware forge uploads from the top publishable layer');
  const vm = buildPublishPlan(plan);
  assert.equal(vm.publishCount, 2);
  assert.match(renderPublishPlanTui(vm), /LAYERED PUBLISH PLAN/);
  assert.equal(toGuiPublishPlanRows(vm)[2].tone, 'danger');
  assert.equal(runner.planBookmark(g, 'feat', 'oooooooo').guardResult.warnings[0].ruleName, 'PublishingGate');
});
