import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, displayCommand, splitCommandLine, validateArgs } from '../server.mjs';

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jj-graph-test-'));
  const jj = (...args) => execFileSync('jj', ['--color', 'never', ...args], { cwd: dir, stdio: 'pipe' }).toString();
  jj('git', 'init');
  jj('config', 'set', '--repo', 'user.name', 'Test');
  jj('config', 'set', '--repo', 'user.email', 'test@example.com');
  writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  jj('commit', '-m', 'base');
  jj('bookmark', 'create', 'main', '-r', '@-');
  writeFileSync(path.join(dir, 'fa.txt'), 'a\n');
  jj('commit', '-m', 'feat a');
  jj('new', 'main', '-m', 'feat b');
  writeFileSync(path.join(dir, 'fb.txt'), 'b\n');
  return { dir, jj };
}

const idOf = (state, description) => state.nodes.find((n) => n.description.startsWith(description));
const get = (app, revset = 'all()') => app.handle('GET', '/api/state', new URLSearchParams({ revset }), null);
const post = (app, route, body = {}) => app.handle('POST', route, new URLSearchParams(), { revset: 'all()', ...body });

test('command helpers', () => {
  assert.deepEqual(splitCommandLine(`jj describe -m "two words" 'x y'`), ['describe', '-m', 'two words', 'x y']);
  assert.deepEqual(splitCommandLine('describe -m ""'), ['describe', '-m', '']);
  assert.throws(() => splitCommandLine('describe -m "open'));
  assert.throws(() => validateArgs(['git', 'push']), /cannot be dry-run/);
  assert.throws(() => validateArgs(['squash', '-i']), /not allowed/);
  assert.throws(() => validateArgs(['rebase', '--at-op=abc']), /not allowed/);
  // Never force-rewrite immutable(); split only with paths; converge never prompts.
  assert.throws(() => validateArgs(['describe', '--ignore-immutable', 'x']), /--ignore-immutable/);
  assert.throws(() => validateArgs(['split', '-r', 'x']), /needs paths/);
  assert.deepEqual(validateArgs(['split', '--parallel', 'src/impl.js']), ['split', '--parallel', 'src/impl.js']);
  assert.deepEqual(validateArgs(['converge']), ['converge', '--no-interactive']);
  assert.deepEqual(validateArgs(['fix', '-s', '@']), ['fix', '-s', '@']);
  assert.equal(displayCommand(['rebase', '-s', 'k'.repeat(32), '-o', 'main']), 'jj rebase -s kkkkkkkk -o main');
  assert.equal(displayCommand(['describe', '-m', 'two words']), 'jj describe -m "two words"');
});

test('a dry run previews without touching the repository, then applies', async (t) => {
  const { dir, jj } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);

  const live = await get(app);
  assert.equal(live.dry.active, false);
  const a = idOf(live, 'feat a');
  const b = idOf(live, 'feat b');
  assert.ok(b.wc);
  assert.deepEqual(b.edges.map((e) => e.to), [idOf(live, 'base').id]);
  const before = jj('log', '--no-graph', '-T', 'commit_id ++ "\\n"');

  // Step 1: move b onto a.
  let r = await post(app, '/api/dry', { args: ['rebase', '-s', b.change, '-o', a.change] });
  assert.equal(r.result.changed, true);
  assert.equal(r.state.dry.active, true);
  assert.deepEqual(idOf(r.state, 'feat b').parents, [a.id]);
  assert.notEqual(r.state.baseline[b.change], idOf(r.state, 'feat b').id);
  assert.equal(jj('log', '--no-graph', '-T', 'commit_id ++ "\\n"'), before, 'repository is untouched');

  // Step 2, typed as a command line, builds on step 1.
  r = await post(app, '/api/dry', { line: `describe ${a.change} -m "feat a, renamed"` });
  assert.equal(r.state.dry.steps.length, 2);
  assert.ok(idOf(r.state, 'feat a, renamed'));
  assert.deepEqual(idOf(r.state, 'feat b').parents, [idOf(r.state, 'feat a, renamed').id]);

  // A no-op adds no step.
  r = await post(app, '/api/dry', { args: ['rebase', '-s', b.change, '-o', a.change] });
  assert.equal(r.result.changed, false);
  assert.equal(r.state.dry.steps.length, 2);

  // Undo and redo move between previews.
  r = await post(app, '/api/undo');
  assert.equal(r.state.dry.steps.length, 1);
  assert.ok(idOf(r.state, 'feat a\n'));
  r = await post(app, '/api/redo');
  assert.equal(r.state.dry.steps.length, 2);

  // A failing command reports jj's error and leaves the plan alone.
  await assert.rejects(post(app, '/api/dry', { args: ['rebase', '-s', 'nosuchrev', '-o', 'main'] }), /nosuchrev/);
  await assert.rejects(post(app, '/api/dry', { args: ['git', 'push'] }), /cannot be dry-run/);

  // An edit made while the dry run is open survives the apply.
  writeFileSync(path.join(dir, 'late.txt'), 'late\n');

  r = await post(app, '/api/apply');
  assert.equal(r.result.applied, 2);
  assert.equal(r.state.dry.active, false);
  const log = jj('log', '--no-graph', '-T', 'description.first_line() ++ "|" ++ parents.map(|p| p.description().first_line()).join(",") ++ "\\n"');
  assert.match(log, /feat b\|feat a, renamed/);
  assert.match(jj('status'), /A late\.txt/);
  assert.match(jj('status'), /A fb\.txt/);

  // The apply can be undone as one unit.
  r = await post(app, '/api/restore', { op: r.result.undoOp });
  assert.ok(idOf(r.state, 'feat a\n'));
  assert.deepEqual(idOf(r.state, 'feat b').parents, [idOf(r.state, 'base').id]);
});

test('a plan follows the repository when it changes underneath', async (t) => {
  const { dir, jj } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const live = await get(app);
  const a = idOf(live, 'feat a');

  // Make a change, then name it by its id in a later step.
  let r = await post(app, '/api/dry', { args: ['new', '--no-edit', a.change, '-m', 'fresh'] });
  const fresh = idOf(r.state, 'fresh').change;
  r = await post(app, '/api/dry', { args: ['describe', fresh, '-m', 'fresh, described'] });
  const base = r.state.dry.base;

  // The repository moves on: both steps are replayed on the new operation.
  jj('describe', a.change, '-m', 'feat a, edited elsewhere');
  r = { state: await get(app) };
  assert.equal(r.state.dry.stale, null);
  assert.notEqual(r.state.dry.base, base);
  assert.equal(r.state.dry.steps.length, 2);
  const described = idOf(r.state, 'fresh, described');
  assert.deepEqual(described.parents, [idOf(r.state, 'feat a, edited elsewhere').id]);

  // A step whose target disappeared marks the plan stale and blocks apply.
  jj('abandon', a.change);
  r = { state: await get(app) };
  assert.match(r.state.dry.stale, /Step 1 .* no longer applies/);
  await assert.rejects(post(app, '/api/apply'), /no longer applies/);
});

test('the operation log can be looked back at and restored as a dry run', async (t) => {
  const { dir, jj } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const before = await get(app);
  assert.equal(before.viewing, null);
  assert.equal(idOf(before, 'feat b').files, 1);
  assert.equal(before.ops[0].id, before.head);

  jj('describe', '-m', 'feat b, reworded');
  const now = await get(app);
  assert.ok(idOf(now, 'feat b, reworded'));
  assert.match(now.ops[0].description, /describe commit/);

  // Looking back shows the old state and changes nothing.
  const past = await app.handle('GET', '/api/state', new URLSearchParams({ revset: 'all()', at: before.head }), null);
  assert.equal(past.viewing, before.head);
  assert.ok(idOf(past, 'feat b\n'));
  assert.equal(past.head, now.head);

  // One change, several versions.
  const b = idOf(now, 'feat b, reworded');
  const evo = await app.handle('GET', '/api/evolog', new URLSearchParams({ rev: b.id }), null);
  assert.ok(evo.versions.length >= 2);
  assert.equal(evo.versions[0].commit, b.id);
  assert.match(evo.versions[0].operation, /describe commit/);

  // Restoring is an operation like any other, so it previews first.
  let r = await post(app, '/api/dry', { args: ['op', 'restore', before.head.slice(0, 16)] });
  assert.equal(r.result.changed, true);
  assert.ok(idOf(r.state, 'feat b\n'));
  assert.match(jj('log', '--no-graph', '-r', '@', '-T', 'description'), /reworded/);

  // The timeline can jump between plan steps.
  r = await post(app, '/api/goto', { steps: 0 });
  assert.equal(r.state.dry.active, false);
  assert.equal(r.state.dry.redo.length, 1);
  r = await post(app, '/api/goto', { steps: 1 });
  assert.equal(r.state.dry.steps.length, 1);
  assert.ok(idOf(r.state, 'feat b\n'));
});

test('changes a step names are told apart from those that only follow', async (t) => {
  const { dir } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const live = await get(app);
  const a = idOf(live, 'feat a');
  const r = await post(app, '/api/dry', { args: ['new', '--no-edit', a.change, '-m', 'child'] });
  const child = idOf(r.state, 'child');
  // `a` is only where the new change goes, so it is not counted as edited.
  assert.deepEqual(r.state.touched, [child.change]);
  const b = idOf(live, 'feat b');
  const r2 = await post(app, '/api/dry', { args: ['rebase', '-s', a.change, '-o', b.change] });
  assert.deepEqual(r2.state.touched.sort(), [a.change, child.change].sort());
  assert.equal(r2.state.rewound, false);
});

test('discard forgets the preview', async (t) => {
  const { dir } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const live = await get(app);
  await post(app, '/api/dry', { args: ['abandon', idOf(live, 'feat a').change] });
  const r = await post(app, '/api/discard');
  assert.equal(r.state.dry.active, false);
  assert.ok(idOf(r.state, 'feat a'));
});

test('parents outside the revset become indirect edges', async (t) => {
  const { dir } = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp(dir);
  const s = await get(app, 'heads(all()) | root()');
  const b = idOf(s, 'feat b');
  assert.deepEqual(b.edges.map((e) => [e.indirect, e.to]), [[true, s.nodes.at(-1).id]]);
});
