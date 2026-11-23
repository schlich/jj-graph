#!/usr/bin/env node
// jj-graph: a DAG-centred web UI for Jujutsu.
//
// Dry runs use jj's own machinery. Every previewed command runs as
//   jj --at-op <tip> --no-integrate-operation <command>
// which writes a real operation but leaves it out of the operation log, so
// the repository, its Git refs, and the working copy stay untouched. The
// preview is read back with `--at-op`. "Apply" is `jj op integrate <tip>`
// followed by `jj workspace update-stale`; "discard" just forgets the tip.
//
// Every step first passes the jjr guardrails, with the revisions it rewrites
// resolved by jj itself and a pre-flight check of trunk() and
// immutable_heads(). `jj fix` and `jj run --ignore-changes` verify revisions
// for the Publishing Gate the same way, as operations that are never kept.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORGE_ADAPTERS,
  JjrGraph,
  JjrGuardrailPipeline,
  JjrJevAssistant,
  JjrNarrator,
  JjrRunner,
  OpenAiCompatibleTransport,
  buildDagGraphViewModel,
  describeMutation,
  parseJjArgs,
  renderDagTui,
  suggestPatternsForGraph,
  toGuiDagRows,
  verificationState,
} from './jjr/index.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT_DIR, 'public');
const DOCS = path.join(ROOT_DIR, 'docs');
const MAX_NODES = 400;
const MAX_ELIDED_LOOKUPS = 24;
const ROOT_COMMIT = '0'.repeat(40);
const PREFLIGHT_TTL_MS = 5000;
// Hook names git runs (githooks(5)); jj runs none of them.
const GIT_HOOKS = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'post-index-change',
]);
const MAX_VERIFY = 30;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

// Commands a dry run may contain: ones that only rewrite the repository.
// Anything with effects outside it (git push/fetch), anything interactive,
// and anything that manages operations or workspaces is left out. `split`
// qualifies only with paths, `converge` only with --no-interactive.
export const ALLOWED = new Set([
  'abandon', 'absorb', 'bookmark', 'converge', 'describe', 'duplicate', 'edit', 'fix',
  'metaedit', 'new', 'next', 'parallelize', 'prev', 'rebase', 'restore', 'revert',
  'simplify-parents', 'split', 'squash', 'tag',
]);
// Commands that can make new changes, whose ids differ on every run.
const CREATORS = new Set(['new', 'duplicate', 'revert', 'squash', 'split', 'metaedit']);
const FORBIDDEN_FLAGS = [
  '-i', '--interactive', '--tool', '--editor', '-R', '--repository',
  '--at-op', '--at-operation', '--no-integrate-operation',
  '--ignore-working-copy', '--config', '--config-file',
  // jjr never force-rewrites immutable() history.
  '--ignore-immutable',
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
  '",\\"paths\\":" ++ if(immutable, "[]", json(self.diff().files().map(|e| e.path().display())))',
  '"}\\n"',
].join(' ++ ');

// Resolves a revision for the guardrails: identity, zone, and whether it is
// trunk() history.
const RESOLVE_TEMPLATE = 'change_id ++ " " ++ commit_id ++ " " ++ immutable ++ " " ++ divergent ++ " " ++ self.contained_in("::trunk()") ++ "\\n"';

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
  if (args[0] === 'split' && parseJjArgs(args).positional.length === 0) {
    throw new JjError('"jj split" needs paths to run without its interactive editor, for example: split --parallel src/impl.js');
  }
  // Without --no-interactive, jj converge prompts.
  if (args[0] === 'converge' && !args.includes('--no-interactive')) return [...args, '--no-interactive'];
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

export function createApp(repo, { pipeline, jev, narrator, verifyCommand = null } = {}) {
  /** @type {{base: string|null, steps: {args: string[], label: string, op: string, output: string, created: string[]}[], redo: any[]}} */
  const plan = { base: null, steps: [], redo: [] };
  const cache = new Map();
  const preflightCache = new Map();
  /** Verification results by commit id: a result holds for that snapshot only. */
  const verifications = new Map();
  let defaultRevset = null;
  let queue = Promise.resolve();
  const jjrPipeline = pipeline ?? new JjrGuardrailPipeline();
  const jjrJev = jev ?? new JjrJevAssistant();
  const defaultTransport = new OpenAiCompatibleTransport();
  const jjrNarrator = narrator ?? new JjrNarrator({
    jev: jjrJev,
    transport: defaultTransport.isConfigured ? defaultTransport : null,
  });
  const jjrRunner = new JjrRunner({ pipeline: jjrPipeline, jev: jjrJev, narrator: jjrNarrator });

  const tip = () => (plan.steps.length ? plan.steps.at(-1).op : null);

  function jj(args, { atOp = null, ok = [0], timeout = 0 } = {}) {
    const full = ['--color', 'never', '--no-pager', ...(atOp ? ['--at-op', atOp] : []), ...args];
    return new Promise((resolve, reject) => {
      execFile('jj', full, {
        cwd: repo,
        maxBuffer: 64 * 1024 * 1024,
        timeout,
        env: { ...process.env, JJ_EDITOR: 'true', EDITOR: 'true' },
      }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        if (err && err.code === 'ENOENT') return reject(new JjError('jj is not on PATH.', 500));
        if (err?.killed) return reject(new JjError(`jj ${args[0]} timed out after ${Math.round(timeout / 1000)}s.`));
        if (!ok.includes(code)) return reject(new JjError(stderr.trim() || `jj exited with ${code}`));
        resolve({ stdout, stderr, code });
      });
    });
  }

  /** Settle a jj call into { ok, ...result } or { ok: false, error }. */
  const settle = (p) => p.then((r) => ({ ok: true, ...r }), (err) => ({ ok: false, error: err.message }));

  /**
   * Pre-flight check: where trunk() and immutable_heads() resolve at `op`,
   * whether anything mutable is divergent, and repository facts the
   * guardrails need (merge.same-change, colocation, remotes, Git features jj
   * does not support).
   */
  async function preflight(op) {
    const hit = preflightCache.get(op);
    if (hit && Date.now() - hit.at < PREFLIGHT_TTL_MS) return hit.value;
    const row = 'change_id ++ " " ++ commit_id ++ " " ++ immutable ++ "\\n"';
    const [trunkRes, headsRes, divRes, sameRes, forgeRes, gitRootRes, remotesRes] = await Promise.all([
      settle(jj(['log', '--no-graph', '-n', '1', '-r', 'trunk()', '-T', row], { atOp: op })),
      settle(jj(['log', '--no-graph', '-n', '50', '-r', 'immutable_heads()', '-T', row], { atOp: op })),
      settle(jj(['log', '--no-graph', '-n', '50', '-r', 'divergent() & mutable()', '-T', 'change_id ++ "\\n"'], { atOp: op })),
      settle(jj(['config', 'get', 'merge.same-change'], { ok: [0, 1] })),
      settle(jj(['config', 'get', 'jjr.forge'], { ok: [0, 1] })),
      settle(jj(['git', 'root'], { ok: [0, 1] })),
      settle(jj(['git', 'remote', 'list'], { ok: [0, 1] })),
    ]);
    const parseRow = (line) => {
      const [changeId, commitId, immutable] = line.split(' ');
      return { changeId, commitId, immutable: immutable === 'true' };
    };
    const trunkRow = trunkRes.ok ? trunkRes.stdout.split('\n').filter(Boolean).map(parseRow)[0] : null;
    const gitDir = gitRootRes.ok && gitRootRes.code === 0 ? gitRootRes.stdout.trim() : null;
    const colocated = Boolean(gitDir) && path.resolve(repo, gitDir) === path.join(repo, '.git');
    const forge = forgeRes.ok && forgeRes.code === 0 ? forgeRes.stdout.trim() : '';
    const value = {
      op,
      trunk: trunkRow
        ? { resolved: true, ...trunkRow, isRoot: trunkRow.commitId === ROOT_COMMIT }
        : { resolved: false, error: trunkRes.error ?? 'trunk() resolves to no revision' },
      immutableHeads: headsRes.ok
        ? { resolved: true, heads: headsRes.stdout.split('\n').filter(Boolean).map(parseRow) }
        : { resolved: false, error: headsRes.error },
      divergent: divRes.ok ? [...new Set(divRes.stdout.split('\n').filter(Boolean))] : [],
      mergeSameChange: (sameRes.ok && sameRes.code === 0 && sameRes.stdout.trim()) || 'accept',
      forge: FORGE_ADAPTERS[forge] ? forge : 'github-bookmarks',
      colocated,
      remotes: remotesRes.ok && remotesRes.code === 0
        ? remotesRes.stdout.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0])
        : [],
      gitCompat: await gitCompatibility(gitDir, colocated),
      keepRefs: gitDir ? await readdir(path.join(path.resolve(repo, gitDir), 'refs', 'jj', 'keep')).then((e) => e.length, () => 0) : 0,
    };
    preflightCache.set(op, { at: Date.now(), value });
    if (preflightCache.size > 32) preflightCache.delete(preflightCache.keys().next().value);
    return value;
  }

  /** Git features in use that jj does not support. */
  async function gitCompatibility(gitDir, colocated) {
    const issues = [];
    const exists = (p) => access(p).then(() => true, () => false);
    if (await exists(path.join(repo, '.gitmodules'))) {
      issues.push({ kind: 'submodules', message: '.gitmodules found: jj does not support Git submodules, so they are neither checked out nor updated.' });
    }
    const attrs = await readFile(path.join(repo, '.gitattributes'), 'utf8').catch(() => null);
    if (attrs != null) {
      if (/filter=lfs/.test(attrs)) {
        issues.push({ kind: 'lfs', message: '.gitattributes routes files through Git LFS: jj does not support LFS and commits the pointer files as they are.' });
      } else if (attrs.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) {
        issues.push({ kind: 'gitattributes', message: '.gitattributes has no effect under jj (no eol conversion, filters, or merge drivers).' });
      }
    }
    if (colocated) {
      const hooks = await readdir(path.join(repo, '.git', 'hooks')).catch(() => []);
      const active = hooks.filter((h) => GIT_HOOKS.has(h));
      if (active.length) {
        issues.push({
          kind: 'hooks',
          message: `Git hooks (${active.join(', ')}) never run under jj; run their checks through jj fix or the verify command instead.`,
          suggestedCommand: `jj config set --repo jjr.verify-command '<build and test command>'`,
        });
      }
    }
    return issues;
  }

  /** The verification records that still apply to the commits shown. */
  function verificationsFor(nodes) {
    const out = {};
    for (const n of nodes) {
      const v = verifications.get(n.id);
      if (v) out[n.change] = v;
    }
    return out;
  }

  function buildGraph(nodes, pre) {
    return JjrGraph.fromJjGraphNodes(nodes, {
      preflight: pre,
      mergeSameChange: pre?.mergeSameChange ?? 'accept',
      colocated: pre?.colocated ?? true,
      forge: pre?.forge ?? 'github-bookmarks',
      verifications: verificationsFor(nodes),
    });
  }

  async function graphAt(op, revset = 'all()') {
    const [nodes, pre] = await Promise.all([view(op, revset), preflight(op)]);
    return buildGraph(nodes, pre);
  }

  /**
   * Resolve revsets with jj at `op`. Returns null when one does not resolve:
   * jj reports that itself when the command runs.
   */
  async function resolveRevsets(revsets, op) {
    if (!revsets.length) return [];
    try {
      const { stdout } = await jj(
        ['log', '--no-graph', '-n', '500', '-r', revsets.map((r) => `(${r})`).join(' | '), '-T', RESOLVE_TEMPLATE],
        { atOp: op },
      );
      return stdout.split('\n').filter(Boolean).map((line) => {
        const [changeId, commitId, immutable, divergent, inTrunk] = line.split(' ');
        return { changeId, commitId, immutable: immutable === 'true', divergent: divergent === 'true', inTrunk: inTrunk === 'true' };
      });
    } catch {
      return null;
    }
  }

  /** Run the guardrails on one dry-run step, with its revisions resolved by jj. */
  async function guard(args, op) {
    const m = describeMutation(args);
    const [targets, bookmarkTargets, graph] = await Promise.all([
      resolveRevsets(m.rewrites, op),
      Promise.all(m.bookmarks.map((b) => resolveRevsets([b.target], op))),
      graphAt(op),
    ]);
    return jjrPipeline.evaluate(graph, {
      type: 'mutate',
      args,
      command: displayCommand(args),
      targetChanges: targets ? targets.map((t) => (t.divergent ? t.commitId : t.changeId)) : m.rewrites,
      resolvedTargets: targets ?? [],
      ignoreImmutable: m.ignoreImmutable,
      recovery: m.recovery,
      bookmarks: m.bookmarks.map((b, i) => ({
        names: b.names,
        targetChanges: (bookmarkTargets[i] ?? []).map((t) => t.changeId),
      })),
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
        paths: r.paths,
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
    const viewOp = at ?? (dry ? tip() : head);
    const [nodes, pre] = await Promise.all([view(viewOp, revset), preflight(viewOp)]);
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
    const jjrGraph = buildGraph(nodes, pre);
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
        preflight: pre,
        verification: Object.fromEntries(nodes.filter((n) => !n.immutable).map((n) => [n.change, verificationState(verifications.get(n.id))])),
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
    return { graph: await graphAt(op, revset), op, revset };
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

  async function dryRun(rawArgs) {
    const args = validateArgs(rawArgs);
    const head = await snapshot();
    await rebasePlan(head);
    // Every step passes the guardrails, including ones that name no revision
    // (`jj new` still stacks work, which divergence must halt).
    const verdict = await guard(args, tip() ?? head);
    if (!verdict.allowed) {
      const first = verdict.blockers[0];
      throw new JjError(`${first.ruleName}: ${first.message}${first.remediation ? ` ${first.remediation}` : ''}`);
    }
    const warnings = verdict.warnings.map((w) => ({ rule: w.ruleName, message: w.message, remediation: w.remediation ?? null }));
    if (!plan.steps.length) plan.base = head;
    const r = await exec(args, tip() ?? plan.base);
    if (!r.op) return { changed: false, output: r.output, warnings };
    plan.steps.push(r);
    plan.redo = [];
    return { changed: true, output: r.output, warnings };
  }

  /** The configured build-and-test command: createApp option, then jj config `jjr.verify-command`. */
  async function verifyCommandFor() {
    if (verifyCommand) return verifyCommand;
    const { stdout, code } = await jj(['config', 'get', 'jjr.verify-command'], { ok: [0, 1] });
    return code === 0 && stdout.trim() ? stdout.trim() : null;
  }

  const tail = (text, n = 1500) => (text.length > n ? `…${text.slice(-n)}` : text).trim();

  /**
   * Verify the mutable revisions of `range` as they stand in the dry run (or
   * the repository): (c) formatting with a `jj fix` that is never integrated,
   * attributed per revision with `jj interdiff`, and (d) the verify command
   * in each revision with `jj run --ignore-changes`. Results are kept by
   * commit id and feed the Publishing Gate.
   */
  async function verify(rangeArg) {
    const head = await snapshot();
    try {
      await rebasePlan(head);
    } catch {
      // A stale plan is verified as it stands.
    }
    const op = tip() ?? head;
    const range = rangeArg?.trim() || 'trunk()..@';
    const revs = `(${range}) & mutable()`;
    const command = await verifyCommandFor();
    const listed = await jj(
      ['log', '--no-graph', '-r', revs, '-T', 'change_id ++ " " ++ commit_id ++ " " ++ divergent ++ " " ++ json(description.first_line()) ++ "\\n"'],
      { atOp: op },
    );
    const all = listed.stdout.split('\n').filter(Boolean).map((line) => {
      const [changeId, commitId, divergent, ...title] = line.split(' ');
      return { changeId, commitId, divergent: divergent === 'true', title: JSON.parse(title.join(' ')) || '(no description)' };
    }).reverse(); // bottom-up, the way a stack lands
    const targets = all.slice(0, MAX_VERIFY);

    const tools = await jj(['config', 'list', 'fix.tools'], { ok: [0, 1] }).catch(() => ({ stdout: '' }));
    const formatter = { configured: Boolean(tools.stdout.trim()), fixed: 0, checked: 0, error: null };
    const formatting = new Map();
    if (targets.length && !formatter.configured) {
      // Nothing to format with: jj fix errors out, and every revision is as formatted as it gets.
      for (const t of targets) formatting.set(t.commitId, { formatted: true, files: [] });
    } else if (targets.length) {
      try {
        const res = await jj(['--no-integrate-operation', 'fix', '-s', `roots(${revs})`], { atOp: op });
        const m = /Fixed (\d+) commits? of (\d+) checked/.exec(res.stderr);
        formatter.fixed = m ? Number(m[1]) : 0;
        formatter.checked = m ? Number(m[2]) : 0;
        const fixOp = /--no-integrate-operation was requested: ([0-9a-f]+)/.exec(res.stderr)?.[1] ?? null;
        for (const t of targets) {
          if (!fixOp || formatter.fixed === 0) formatting.set(t.commitId, { formatted: true, files: [] });
          else if (t.divergent) formatting.set(t.commitId, { formatted: null, files: [] });
          else {
            const d = await jj(['interdiff', '--from', t.commitId, '--to', t.changeId, '--name-only'], { atOp: fixOp });
            const files = d.stdout.split('\n').filter(Boolean);
            formatting.set(t.commitId, { formatted: files.length === 0, files });
          }
        }
      } catch (err) {
        formatter.error = err.message;
      }
    }

    const results = [];
    for (const t of targets) {
      const fmt = formatting.get(t.commitId) ?? { formatted: null, files: [] };
      let passed = null;
      let output = '';
      if (command) {
        try {
          // --passthrough hands the command's own output to us, not just jj's verdict.
          const r = await jj(['run', '--ignore-changes', '--passthrough', '--root', '-r', t.commitId, '--', 'sh', '-c', command], {
            atOp: op,
            ok: [0, 1],
            timeout: VERIFY_TIMEOUT_MS,
          });
          passed = r.code === 0;
          output = tail(r.stdout + r.stderr);
        } catch (err) {
          passed = false;
          output = tail(err.message);
        }
      }
      const record = {
        formatted: fmt.formatted,
        builds: passed,
        testsPass: passed,
        verified: command != null && fmt.formatted != null,
        checkedAtCommit: t.commitId,
        command,
        unformattedFiles: fmt.files,
        checkedAt: new Date().toISOString(),
      };
      verifications.set(t.commitId, record);
      results.push({
        changeId: t.changeId,
        commitId: t.commitId,
        title: t.title,
        state: verificationState(record),
        formatted: fmt.formatted,
        testsPass: passed,
        unformattedFiles: fmt.files,
        output,
      });
    }
    while (verifications.size > 500) verifications.delete(verifications.keys().next().value);
    const count = (s) => results.filter((r) => r.state === s).length;
    return {
      op,
      range,
      command,
      formatter,
      results,
      skipped: all.length - targets.length,
      summary: { green: count('green'), red: count('red'), unknown: count('unknown') },
      hint: command ? null : "No verify command is set, so build and test results stay unknown. Set one with: jj config set --repo jjr.verify-command 'npm test'",
    };
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
        preflight: graph.preflight,
      };
    }
    if (method === 'GET' && route === '/api/jjr/preflight') {
      const { graph } = await currentJjrGraph(revset, query.get('at'));
      return { preflight: graph.preflight, diagnostics: graph.preflightDiagnostics() };
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
      case '/api/jjr/verify': {
        const verification = await verify(body.range);
        return { ...verification, state: await state(revset) };
      }
      case '/api/jjr/publish-plan': {
        const { graph } = await currentJjrGraph('all()', body.at);
        const rev = body.rev ?? graph.workingCopy()?.changeId;
        if (!rev) throw new JjError('Expected a revision changeId.');
        try {
          return jjrRunner.planLayeredPublish(graph, rev, { forge: body.forge });
        } catch (err) {
          throw new JjError(err.message);
        }
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
  const opts = { repo: process.cwd(), port: 7777, host: '127.0.0.1', verifyCommand: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--verify-command') opts.verifyCommand = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.repo = path.resolve(a);
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: jj-graph [REPO] [--port 7777] [--host 127.0.0.1] [--verify-command CMD]\n\n' +
      'With a host other than loopback (for a phone on your network), the URL\n' +
      'carries a token and the API refuses requests without it.\n\n' +
      '--verify-command is the build-and-test command run in each revision by\n' +
      '"Verify stack" (default: jj config jjr.verify-command).');
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
  createServer(root, { token, verifyCommand: opts.verifyCommand }).listen(opts.port, opts.host, () => {
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? '<this-machine>' : opts.host;
    console.log(`jj-graph serving ${root}`);
    console.log(`  http://${shown}:${opts.port}/${token ? `#token=${token}` : ''}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
