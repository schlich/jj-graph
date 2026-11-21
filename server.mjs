#!/usr/bin/env node
// jj-graph: a DAG-centred web UI for Jujutsu.
//
// Dry runs use jj's own machinery. Every previewed command runs as
//   jj --at-op <tip> --no-integrate-operation <command>
// which writes a real operation but leaves it out of the operation log, so
// the repository, its Git refs, and the working copy stay untouched. The
// preview is read back with `--at-op`. "Apply" is `jj op integrate <tip>`
// followed by `jj workspace update-stale`; "discard" just forgets the tip.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JjrGraph,
  JjrGuardrailPipeline,
  JjrJevAssistant,
  JjrNarrator,
  OpenAiCompatibleTransport,
  buildDagGraphViewModel,
  extractMutatedTargets,
  renderDagTui,
  suggestPatternsForGraph,
  toGuiDagRows,
} from './jjr/index.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT_DIR, 'public');
const DOCS = path.join(ROOT_DIR, 'docs');
const MAX_NODES = 400;
const MAX_ELIDED_LOOKUPS = 24;

// Commands a dry run may contain: ones that only rewrite the repository.
// Anything with effects outside it (git push/fetch), anything interactive,
// and anything that manages operations or workspaces is left out.
export const ALLOWED = new Set([
  'abandon', 'absorb', 'bookmark', 'describe', 'duplicate', 'edit', 'metaedit',
  'new', 'next', 'parallelize', 'prev', 'rebase', 'restore', 'revert',
  'simplify-parents', 'squash', 'tag',
]);
// Commands that can make new changes, whose ids differ on every run.
const CREATORS = new Set(['new', 'duplicate', 'revert', 'squash']);
const FORBIDDEN_FLAGS = [
  '-i', '--interactive', '--tool', '--editor', '-R', '--repository',
  '--at-op', '--at-operation', '--no-integrate-operation',
  '--ignore-working-copy', '--config', '--config-file',
];

const TEMPLATE = [
  '"{\\"commit\\":" ++ json(self)',
  '",\\"bookmarks\\":" ++ json(local_bookmarks)',
  '",\\"remotes\\":" ++ json(remote_bookmarks)',
  '",\\"tags\\":" ++ json(tags)',
  '",\\"wc\\":" ++ json(current_working_copy)',
  '",\\"immutable\\":" ++ json(immutable)',
  '",\\"conflict\\":" ++ json(conflict)',
  '",\\"empty\\":" ++ json(empty)',
  '",\\"divergent\\":" ++ json(divergent)',
  '",\\"hidden\\":" ++ json(hidden)',
  '",\\"prefix\\":" ++ json(change_id.shortest(4).prefix())',
  '",\\"workspaces\\":" ++ json(working_copies)',
  '",\\"files\\":" ++ json(if(immutable, 0, self.diff().files().len()))',
  '"}\\n"',
].join(' ++ ');

export class JjError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Shorten full change and commit ids so a command fits on a phone. */
export function displayCommand(args) {
  return 'jj ' + args.map((a) => {
    if (/^[k-z]{32}$/.test(a) || /^[0-9a-f]{40}$/.test(a)) return a.slice(0, 8);
    return /^[\w@./:=+-]+$/.test(a) ? a : JSON.stringify(a);
  }).join(' ');
}

export function validateArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) {
    throw new JjError('A command is a non-empty list of strings.');
  }
  // Rewinding the repository is itself an operation, so it previews too.
  const rewind = ['op', 'operation'].includes(args[0]) && ['restore', 'revert'].includes(args[1]);
  if (!ALLOWED.has(args[0]) && !rewind) {
    throw new JjError(`"jj ${args[0]}" cannot be dry-run here. Allowed: ${[...ALLOWED].join(', ')}, op restore, op revert.`);
  }
  for (const a of args) {
    const flag = a.split('=')[0];
    if (FORBIDDEN_FLAGS.includes(flag)) throw new JjError(`The flag ${flag} is not allowed in a dry run.`);
  }
  return args;
}

/** Split a typed command line into arguments, honouring quotes. */
export function splitCommandLine(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new JjError('Unclosed quote in command.');
  if (started || cur) out.push(cur);
  if (out[0] === 'jj') out.shift();
  return out;
}

export function createApp(repo, { pipeline, jev, narrator } = {}) {
  /** @type {{base: string|null, steps: {args: string[], label: string, op: string, output: string, created: string[]}[], redo: any[]}} */
  const plan = { base: null, steps: [], redo: [] };
  const cache = new Map();
  let defaultRevset = null;
  let queue = Promise.resolve();
  const jjrPipeline = pipeline ?? new JjrGuardrailPipeline();
  const jjrJev = jev ?? new JjrJevAssistant();
  const defaultTransport = new OpenAiCompatibleTransport();
  const jjrNarrator = narrator ?? new JjrNarrator({
    jev: jjrJev,
    transport: defaultTransport.isConfigured ? defaultTransport : null,
  });

  const tip = () => (plan.steps.length ? plan.steps.at(-1).op : null);

  function jj(args, { atOp = null, ok = [0] } = {}) {
    const full = ['--color', 'never', '--no-pager', ...(atOp ? ['--at-op', atOp] : []), ...args];
    return new Promise((resolve, reject) => {
      execFile('jj', full, {
        cwd: repo,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, JJ_EDITOR: 'true', EDITOR: 'true' },
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if (err && err.code === 'ENOENT') return reject(new JjError('jj is not on PATH.', 500));
        if (!ok.includes(code)) return reject(new JjError(stderr.trim() || `jj exited with ${code}`));
        resolve({ stdout, stderr, code });
      });
    });
  }

  async function headOp() {
    const { stdout } = await jj(['op', 'log', '--ignore-working-copy', '--no-graph', '-n', '1', '-T', 'id']);
    return stdout.trim();
  }

  /** Record working-copy edits as an operation, then return the head operation. */
  async function snapshot() {
    await jj(['util', 'snapshot'], { ok: [0, 1] });
    return headOp();
  }

  async function readNodes(op, revset) {
    const { stdout } = await jj(
      ['log', '--no-graph', '-n', String(MAX_NODES), '-r', revset, '-T', TEMPLATE],
      { atOp: op },
    );
    return stdout.split('\n').filter(Boolean).map((line) => {
      const r = JSON.parse(line);
      return {
        id: r.commit.commit_id,
        change: r.commit.change_id,
        prefix: r.prefix,
        parents: r.commit.parents,
        description: r.commit.description,
        author: r.commit.author.name || r.commit.author.email,
        time: r.commit.committer.timestamp,
        bookmarks: r.bookmarks.map((b) => ({ name: b.name, conflict: b.target.length !== 1 })),
        remotes: r.remotes.filter((b) => b.remote !== 'git').map((b) => `${b.name}@${b.remote}`),
        tags: r.tags.map((t) => t.name),
        wc: r.wc,
        immutable: r.immutable,
        conflict: r.conflict,
        empty: r.empty,
        divergent: r.divergent,
        hidden: r.hidden,
        workspaces: r.workspaces,
        files: r.files,
      };
    });
  }

  /**
   * Resolve each node's parents to edges. A parent outside the revset is
   * replaced by its nearest visible ancestors, marked `indirect`; with none,
   * the edge is a stub (`to: null`).
   */
  async function resolveEdges(nodes, op, revset) {
    const visible = new Set(nodes.map((n) => n.id));
    const missing = new Set();
    for (const n of nodes) for (const p of n.parents) if (!visible.has(p)) missing.add(p);
    const elided = new Map();
    await Promise.all([...missing].slice(0, MAX_ELIDED_LOOKUPS).map(async (p) => {
      try {
        const { stdout } = await jj(
          ['log', '--no-graph', '-r', `heads(::${p} & (${revset}))`, '-T', 'commit_id ++ "\\n"'],
          { atOp: op },
        );
        elided.set(p, stdout.split('\n').filter((id) => visible.has(id)));
      } catch {
        elided.set(p, []);
      }
    }));
    for (const n of nodes) {
      const edges = [];
      const seen = new Set();
      for (const p of n.parents) {
        if (visible.has(p)) {
          edges.push({ to: p, parent: p, indirect: false });
          seen.add(p);
          continue;
        }
        const targets = (elided.get(p) ?? []).filter((t) => !seen.has(t));
        if (targets.length === 0) edges.push({ to: null, parent: p, indirect: true });
        for (const t of targets) {
          edges.push({ to: t, parent: p, indirect: true });
          seen.add(t);
        }
      }
      n.edges = edges;
    }
  }

  async function view(op, revset) {
    const key = `${op}\n${revset}`;
    if (!cache.has(key)) {
      const nodes = await readNodes(op, revset);
      await resolveEdges(nodes, op, revset);
      cache.set(key, nodes);
      if (cache.size > 24) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }

  /** The newest operations, newest first: the repository's own history. */
  async function operations(head) {
    const key = `ops\n${head}`;
    if (!cache.has(key)) {
      const { stdout } = await jj(['op', 'log', '--no-graph', '-n', '24', '-T', 'json(self) ++ "\\n"'], { atOp: head });
      cache.set(key, stdout.split('\n').filter(Boolean).map((line) => {
        const o = JSON.parse(line);
        return { id: o.id, description: o.description.split('\n')[0], time: o.time.end, snapshot: o.is_snapshot };
      }));
    }
    return cache.get(key);
  }

  /** Every version a change has had, newest first. */
  async function evolution(rev, at) {
    if (!/^[0-9a-z]{4,64}$/.test(rev ?? '')) throw new JjError('Bad revision.');
    const op = checkOp(at) ?? tip() ?? (await headOp());
    const { stdout } = await jj(
      ['evolog', '--no-graph', '-n', '60', '-r', rev, '-T', '"{\\"commit\\":" ++ json(commit) ++ ",\\"op\\":" ++ json(operation) ++ "}\\n"'],
      { atOp: op },
    );
    return {
      versions: stdout.split('\n').filter(Boolean).map((line) => {
        const e = JSON.parse(line);
        return {
          commit: e.commit.commit_id,
          description: e.commit.description.split('\n')[0],
          operation: e.op?.description.split('\n')[0] ?? null,
          time: e.op?.time.end ?? e.commit.committer.timestamp,
          snapshot: e.op?.is_snapshot ?? false,
        };
      }),
    };
  }

  function checkOp(at) {
    if (at == null || at === '') return null;
    if (!/^[0-9a-f]{8,128}$/.test(at)) throw new JjError('Bad operation id.');
    return at;
  }

  async function state(revsetArg, atArg) {
    if (defaultRevset === null) {
      defaultRevset = (await jj(['config', 'get', 'revsets.log'], { ok: [0, 1] })).stdout.trim() || 'all()';
    }
    const revset = revsetArg?.trim() || defaultRevset;
    const at = checkOp(atArg);
    const head = await snapshot();
    let stale = null;
    try {
      await rebasePlan(head);
    } catch (err) {
      stale = err.message;
    }
    const dry = plan.steps.length > 0;
    // `at` looks back at an earlier operation; it never shows the plan.
    const nodes = await view(at ?? (dry ? tip() : head), revset);
    let baseline = null;
    if (dry && !at) {
      baseline = {};
      for (const n of await view(plan.base, revset)) baseline[n.change] = n.id;
    }
    // A change named only as a destination is not itself being edited.
    const DEST = ['-o', '-d', '--onto', '--destination', '-A', '-B', '--insert-after', '--insert-before', '--after', '--before'];
    // `jj new` names only parents, so everything it lists is a destination.
    const named = (args) => (args[0] === 'new' ? []
      : args.filter((a, i) => /^[k-z]{32}$/.test(a) && !DEST.includes(args[i - 1])));
    const jjrGraph = JjrGraph.fromJjGraphNodes(nodes);
    return {
      repo,
      revset,
      defaultRevset,
      head,
      viewing: at,
      ops: await operations(head),
      nodes,
      baseline,
      jjr: {
        summary: jjrGraph.summary(),
        diagnostics: jjrGraph.diagnose(),
        jevMode: jjrJev.mode,
      },
      // Changes a step names or creates; the rest of what moved only followed.
      rewound: plan.steps.some((s) => s.args[0].startsWith('op')),
      touched: [...new Set(plan.steps.flatMap((s) => [...named(s.args), ...s.created]))],
      truncated: nodes.length >= MAX_NODES,
      dry: {
        active: dry,
        base: plan.base,
        stale,
        steps: plan.steps.map((s) => ({ label: s.label, output: s.output })),
        redo: plan.redo.map((s) => s.label),
      },
    };
  }

  async function mutableChanges(op) {
    const { stdout } = await jj(['log', '--no-graph', '-r', 'mutable()', '-T', 'change_id ++ "\\n"'], { atOp: op });
    return stdout.split('\n').filter(Boolean);
  }

  /**
   * Run one command on top of operation `at` without integrating it.
   * Returns null when jj reports that nothing changed. `created` lists the
   * change ids the command made, so later steps that name them can be
   * replayed against the ids a re-run produces.
   */
  async function exec(args, at) {
    const { stderr, stdout } = await jj(['--no-integrate-operation', ...args], { atOp: at });
    const m = /--no-integrate-operation was requested: ([0-9a-f]+)/.exec(stderr);
    const output = (stdout + stderr)
      .split('\n')
      .filter((l) => l && !l.startsWith('Operation left uncommitted'))
      .join('\n');
    if (!m) return { op: null, output: output || 'Nothing changed.' };
    let created = [];
    if (CREATORS.has(args[0])) {
      const before = new Set(await mutableChanges(at));
      created = (await mutableChanges(m[1])).filter((c) => !before.has(c));
    }
    return { op: m[1], output, created, args, label: displayCommand(args) };
  }

  /** Re-run steps on top of `from`, renaming the changes they create. */
  async function replay(steps, from, renames = new Map()) {
    const out = [];
    let at = from;
    for (const [i, step] of steps.entries()) {
      const args = step.args.map((a) => renames.get(a) ?? a);
      let r;
      try {
        r = await exec(args, at);
      } catch (err) {
        throw new JjError(`Step ${i + 1} (${step.label}) no longer applies: ${err.message}`);
      }
      if (!r.op) continue; // the repository already has this step's effect
      step.created.forEach((old, k) => { if (r.created[k]) renames.set(old, r.created[k]); });
      out.push(r);
      at = r.op;
    }
    return out;
  }

  /**
   * Keep the plan based on the repository's latest operation. Integrating
   * a plan built on an older one would count as a concurrent operation
   * and leave divergent changes, for example after a file was edited.
   */
  async function rebasePlan(head) {
    if (!plan.steps.length || head === plan.base) return;
    const renames = new Map();
    plan.steps = await replay(plan.steps, head, renames);
    for (const s of plan.redo) s.args = s.args.map((a) => renames.get(a) ?? a);
    plan.base = plan.steps.length ? head : null;
  }

  async function currentJjrGraph(revsetArg, atArg) {
    if (defaultRevset === null) {
      defaultRevset = (await jj(['config', 'get', 'revsets.log'], { ok: [0, 1] })).stdout.trim() || 'all()';
    }
    const revset = revsetArg?.trim() || defaultRevset;
    const op = checkOp(atArg) ?? tip() ?? (await snapshot());
    const nodes = await view(op, revset);
    return { graph: JjrGraph.fromJjGraphNodes(nodes), op, revset };
  }

  async function readRevisionContext(rev, op) {
    if (!/^[0-9a-z@+-]{1,64}$/.test(rev ?? '')) throw new JjError('Bad revision.');
    const [diffRes, namesRes] = await Promise.all([
      jj(['show', '-r', rev, '--git'], { atOp: op, ok: [0, 1] }),
      jj(['diff', '-r', rev, '--name-only'], { atOp: op, ok: [0, 1] }),
    ]);
    return {
      diffExcerpt: diffRes.stdout.slice(0, 8000),
      touchedPaths: namesRes.stdout.split('\n').filter(Boolean),
    };
  }

  async function dryRun(args) {
    validateArgs(args);
    const head = await snapshot();
    await rebasePlan(head);
    const activeOp = tip() ?? head;
    const targetChanges = extractMutatedTargets(args);
    if (targetChanges.length > 0) {
      const nodes = await view(activeOp, 'all()');
      const graph = JjrGraph.fromJjGraphNodes(nodes);
      const guard = jjrPipeline.evaluate(graph, {
        type: 'mutate',
        targetChanges,
        command: displayCommand(args),
      });
      if (!guard.allowed) {
        const first = guard.blockers[0];
        throw new JjError(`${first.ruleName}: ${first.message}${first.remediation ? ` ${first.remediation}` : ''}`);
      }
    }
    if (!plan.steps.length) plan.base = head;
    const r = await exec(args, tip() ?? plan.base);
    if (!r.op) return { changed: false, output: r.output };
    plan.steps.push(r);
    plan.redo = [];
    return { changed: true, output: r.output };
  }

  function undo() {
    if (plan.steps.length) plan.redo.push(plan.steps.pop());
    if (!plan.steps.length) plan.base = null;
  }

  async function redo() {
    if (!plan.redo.length) return;
    const head = await snapshot();
    await rebasePlan(head);
    if (!plan.steps.length) plan.base = head;
    const step = plan.redo.pop();
    const renames = new Map();
    plan.steps.push(...await replay([step], tip() ?? plan.base, renames));
    for (const s of plan.redo) s.args = s.args.map((a) => renames.get(a) ?? a);
    if (!plan.steps.length) plan.base = null;
  }

  function discard() {
    plan.steps = [];
    plan.redo = [];
    plan.base = null;
  }

  async function apply() {
    if (!plan.steps.length) throw new JjError('There is no dry run to apply.');
    const before = await snapshot();
    await rebasePlan(before);
    if (!plan.steps.length) throw new JjError('The repository already matches the dry run.');
    await jj(['op', 'integrate', tip()]);
    const count = plan.steps.length;
    discard();
    // The working copy is now behind the operation log; bring it forward.
    const { stderr } = await jj(['workspace', 'update-stale'], { ok: [0, 1] });
    return { applied: count, undoOp: before, output: stderr.trim() };
  }

  async function restore(op) {
    if (!/^[0-9a-f]{8,128}$/.test(op ?? '')) throw new JjError('Bad operation id.');
    const { stderr } = await jj(['op', 'restore', op]);
    discard();
    return { output: stderr.trim() };
  }

  /** Undo or redo until the plan has `count` steps. */
  async function goto(count) {
    if (!Number.isInteger(count) || count < 0) throw new JjError('Bad step.');
    while (plan.steps.length > count) undo();
    while (plan.steps.length < count && plan.redo.length) await redo();
  }

  async function show(rev, mode, at) {
    if (!/^[0-9a-z]{4,64}$/.test(rev ?? '')) throw new JjError('Bad revision.');
    const flags = mode === 'diff' ? ['--git'] : ['--stat'];
    const op = checkOp(at) ?? tip() ?? (await headOp());
    const { stdout } = await jj(['show', '-r', rev, ...flags], { atOp: op });
    const limit = 400_000;
    return { text: stdout.length > limit ? stdout.slice(0, limit) + '\n… truncated' : stdout };
  }

  /** Run handlers one at a time so plan mutations cannot interleave. */
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function handle(method, route, query, body) {
    const revset = query.get('revset') ?? body?.revset;
    if (method === 'GET' && route === '/api/state') return state(revset, query.get('at'));
    if (method === 'GET' && route === '/api/show') return show(query.get('rev'), query.get('mode'), query.get('at'));
    if (method === 'GET' && route === '/api/evolog') return evolution(query.get('rev'), query.get('at'));
    if (method === 'GET' && route === '/api/jjr/diagnose') {
      const { graph } = await currentJjrGraph(revset, query.get('at'));
      return {
        summary: graph.summary(),
        diagnostics: graph.diagnose(),
        patterns: suggestPatternsForGraph(graph),
        feedback: await jjrNarrator.explainGraphFeedback(graph),
        jevMode: jjrJev.mode,
      };
    }
    if (method === 'GET' && route === '/api/jjr/ui') {
      const { graph } = await currentJjrGraph(revset, query.get('at'));
      const vm = buildDagGraphViewModel(graph, query.get('selected') ?? null);
      return { viewModel: vm, tui: renderDagTui(vm, false), guiRows: toGuiDagRows(vm) };
    }
    if (method !== 'POST') throw new JjError('Not found.', 404);
    switch (route) {
      case '/api/dry': {
        const args = body.line !== undefined ? splitCommandLine(String(body.line)) : body.args;
        const result = await dryRun(args);
        return { result, state: await state(revset) };
      }
      case '/api/undo': undo(); return { state: await state(revset) };
      case '/api/redo': await redo(); return { state: await state(revset) };
      case '/api/goto': await goto(body.steps); return { state: await state(revset) };
      case '/api/discard': discard(); return { state: await state(revset) };
      case '/api/apply': {
        const result = await apply();
        return { result, state: await state(revset) };
      }
      case '/api/restore': {
        const result = await restore(body.op);
        return { result, state: await state(revset) };
      }
      case '/api/jjr/guard': {
        const { graph } = await currentJjrGraph(revset, body.at);
        const action = body.action;
        if (!action || typeof action !== 'object') throw new JjError('Expected an action object.');
        return body.useJev
          ? jjrPipeline.evaluateWithJev(graph, action, { jev: jjrJev, diffExcerpt: body.diffExcerpt ?? '' })
          : jjrPipeline.evaluate(graph, action);
      }
      case '/api/jjr/triage': {
        const { graph, op } = await currentJjrGraph(revset ?? 'all()', body.at);
        const rev = body.rev ?? graph.workingCopy()?.changeId;
        if (!rev) throw new JjError('Expected a revision changeId.');
        const node = graph.get(rev) ?? graph.getByCommit(rev);
        const ctx = await readRevisionContext(rev, op);
        return jjrJev.triageChange({
          changeId: node?.changeId ?? rev,
          description: node?.currentCommit.description ?? '',
          touchedPaths: ctx.touchedPaths,
          diffExcerpt: ctx.diffExcerpt,
          isEmpty: node?.currentCommit.isEmpty,
          isWorkingCopy: node?.isWorkingCopy,
          mutableParentCount: (node?.parents ?? []).filter((p) => graph.get(p)?.zone === 'mutable').length,
          isConflicted: node?.currentCommit.conflict?.isConflicted,
        });
      }
      case '/api/jjr/dependency': {
        const { graph, op } = await currentJjrGraph(revset ?? 'all()', body.at);
        if (!body.base || !body.child) throw new JjError('Expected base and child changeIds.');
        const baseNode = graph.get(body.base) ?? graph.getByCommit(body.base);
        const childNode = graph.get(body.child) ?? graph.getByCommit(body.child);
        if (typeof body.childCausallyDependsOnBase === 'boolean' && typeof body.baseIndependentlyReviewable === 'boolean') {
          return {
            source: 'explicit',
            verdict: JjrGraph.evaluateDependency({
              base: baseNode?.changeId ?? body.base,
              child: childNode?.changeId ?? body.child,
              childCausallyDependsOnBase: body.childCausallyDependsOnBase,
              baseIndependentlyReviewable: body.baseIndependentlyReviewable,
            }),
          };
        }
        const [baseCtx, childCtx] = await Promise.all([
          readRevisionContext(body.base, op),
          readRevisionContext(body.child, op),
        ]);
        return jjrJev.assessDependency({
          base: {
            changeId: baseNode?.changeId ?? body.base,
            description: baseNode?.currentCommit.description ?? '',
            ...baseCtx,
          },
          child: {
            changeId: childNode?.changeId ?? body.child,
            description: childNode?.currentCommit.description ?? '',
            ...childCtx,
          },
        });
      }
      case '/api/jjr/suggest-name': {
        const { graph, op } = await currentJjrGraph(revset ?? 'all()', body.at);
        const rev = body.rev ?? graph.workingCopy()?.changeId;
        if (!rev) throw new JjError('Expected a revision changeId.');
        const node = graph.get(rev) ?? graph.getByCommit(rev);
        const ctx = await readRevisionContext(rev, op);
        return jjrNarrator.suggestChangeName({
          changeId: node?.changeId ?? rev,
          description: node?.currentCommit.description ?? '',
          ...ctx,
        });
      }
      default: throw new JjError('Not found.', 404);
    }
  }

  return { handle: (...a) => serial(() => handle(...a)), plan, jjr: { pipeline: jjrPipeline, jev: jjrJev, narrator: jjrNarrator } };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

export function createServer(repo, { token = null, ...jjrOpts } = {}) {
  const app = createApp(repo, jjrOpts);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (url.pathname.startsWith('/api/')) {
        if (token && req.headers['x-jj-graph-token'] !== token) throw new JjError('Missing or wrong token.', 401);
        let body = null;
        if (req.method === 'POST') {
          // Only same-origin pages may mutate: a cross-site form cannot send JSON.
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new JjError('Expected JSON.', 415);
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new JjError('Cross-origin request refused.', 403);
          const chunks = [];
          for await (const c of req) chunks.push(c);
          body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        }
        return send(200, await app.handle(req.method, url.pathname, url.searchParams, body));
      }
      if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
        const sub = url.pathname === '/docs' || url.pathname === '/docs/' ? 'index.html' : url.pathname.slice('/docs/'.length);
        const file = path.join(DOCS, path.normalize(sub));
        if (!file.startsWith(DOCS + path.sep)) throw new JjError('Not found.', 404);
        const data = await readFile(file).catch(() => { throw new JjError('Not found.', 404); });
        return send(200, data, MIME[path.extname(file)] ?? 'application/octet-stream');
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC + path.sep)) throw new JjError('Not found.', 404);
      const data = await readFile(file).catch(() => { throw new JjError('Not found.', 404); });
      send(200, data, MIME[path.extname(file)] ?? 'application/octet-stream');
    } catch (err) {
      send(err.status ?? 500, { error: err.message ?? String(err) });
    }
  });
}

function parseCli(argv) {
  const opts = { repo: process.cwd(), port: 7777, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.repo = path.resolve(a);
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: jj-graph [REPO] [--port 7777] [--host 127.0.0.1]\n\n' +
      'With a host other than loopback (for a phone on your network), the URL\n' +
      'carries a token and the API refuses requests without it.');
    return;
  }
  const root = await new Promise((resolve) => {
    execFile('jj', ['--ignore-working-copy', 'root'], { cwd: opts.repo }, (err, out, stderr) => {
      if (err) {
        console.error(stderr || String(err));
        process.exit(1);
      }
      resolve(out.trim());
    });
  });
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(opts.host);
  const token = loopback ? null : randomBytes(16).toString('hex');
  createServer(root, { token }).listen(opts.port, opts.host, () => {
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? '<this-machine>' : opts.host;
    console.log(`jj-graph serving ${root}`);
    console.log(`  http://${shown}:${opts.port}/${token ? `#token=${token}` : ''}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
