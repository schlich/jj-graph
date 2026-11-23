/**
 * jj command model (jj 0.47 CLI).
 *
 * Guardrails must check the revisions a command really rewrites, not merely
 * the ones it names. `jj new X` only reads X, `jj new -B X` rewrites X,
 * `jj new -A X` rewrites X's children, and `jj squash` with no flags rewrites
 * both `@` and `@-`. This module classifies every revision argument of a jj
 * command line by what the command does to it.
 *
 * Roles:
 *   rewrite   the revisions are rewritten (jj's immutability check applies)
 *   children  the children of the revisions are rebased, so they are rewritten
 *   parent    the revisions become parents of new or moved work (read only)
 *   source    the revisions are only read
 *   bookmark  a bookmark will point at the revision
 *   value     an option value that is not a revision (message, tool, ...)
 *   fileset   positional paths
 */

/** Global options that take a value. */
const GLOBAL_VALUE_OPTIONS = new Set([
  '-R', '--repository', '--at-op', '--at-operation', '--color', '--config', '--config-file',
]);

const opt = (slot, role) => ({ slot, role });

const INSERT = {
  '-o': opt('onto', 'parent'),
  '--onto': opt('onto', 'parent'),
  '-d': opt('onto', 'parent'),
  '--destination': opt('onto', 'parent'),
  '-A': opt('after', 'children'),
  '--insert-after': opt('after', 'children'),
  '--after': opt('after', 'children'),
  '-B': opt('before', 'rewrite'),
  '--insert-before': opt('before', 'rewrite'),
  '--before': opt('before', 'rewrite'),
};
const REVISION = (role = 'rewrite') => ({
  '-r': opt('revision', role),
  '--revision': opt('revision', role),
  '--revisions': opt('revision', role),
});
const MESSAGE = { '-m': opt('message', 'value'), '--message': opt('message', 'value') };
const TOOL = { '--tool': opt('tool', 'value') };

/**
 * Per-command specification. `positional` gives the role of positional
 * arguments, `defaults` the revision a slot falls back to when the command
 * line leaves it out, and `recovery` marks divergence-recovery commands.
 */
export const JJ_COMMAND_SPECS = Object.freeze({
  abandon: { positional: 'rewrite', positionalSlot: 'revision', options: { ...REVISION() }, defaults: { revision: '@' }, recovery: true },
  absorb: {
    positional: 'fileset',
    options: {
      '-f': opt('from', 'rewrite'), '--from': opt('from', 'rewrite'),
      '-t': opt('into', 'rewrite'), '--into': opt('into', 'rewrite'), '--to': opt('into', 'rewrite'),
      ...TOOL,
    },
    defaults: { from: '@' },
  },
  converge: { positional: 'none', options: { ...REVISION() }, recovery: true },
  describe: { positional: 'rewrite', positionalSlot: 'revision', options: { ...REVISION(), ...MESSAGE }, defaults: { revision: '@' } },
  duplicate: { positional: 'source', positionalSlot: 'revision', options: { ...INSERT }, defaults: { revision: '@' }, creates: true },
  edit: { positional: 'rewrite', positionalSlot: 'revision', options: { ...REVISION() } },
  fix: { positional: 'fileset', options: { '-s': opt('source', 'rewrite'), '--source': opt('source', 'rewrite') } },
  metaedit: {
    positional: 'rewrite',
    positionalSlot: 'revision',
    options: { ...REVISION(), ...MESSAGE, '--author': opt('author', 'value'), '--author-timestamp': opt('author', 'value') },
    defaults: { revision: '@' },
  },
  new: {
    positional: 'parent',
    positionalSlot: 'parents',
    options: { ...REVISION('parent'), ...MESSAGE, ...INSERT },
    creates: true,
  },
  next: { positional: 'value', options: {} },
  parallelize: { positional: 'rewrite', positionalSlot: 'revision', options: {} },
  prev: { positional: 'value', options: {} },
  rebase: {
    positional: 'none',
    options: {
      '-b': opt('branch', 'rewrite'), '--branch': opt('branch', 'rewrite'),
      '-s': opt('source', 'rewrite'), '--source': opt('source', 'rewrite'),
      ...REVISION(),
      ...INSERT,
    },
  },
  restore: {
    positional: 'fileset',
    options: {
      '-f': opt('from', 'source'), '--from': opt('from', 'source'),
      '-t': opt('into', 'rewrite'), '--into': opt('into', 'rewrite'), '--to': opt('into', 'rewrite'),
      '-c': opt('changes', 'rewrite'), '--changes-in': opt('changes', 'rewrite'),
      ...TOOL,
    },
  },
  revert: { positional: 'none', options: { ...REVISION('source'), ...INSERT }, creates: true },
  'simplify-parents': {
    positional: 'none',
    options: { '-s': opt('source', 'rewrite'), '--source': opt('source', 'rewrite'), ...REVISION() },
  },
  split: { positional: 'fileset', options: { ...REVISION(), ...MESSAGE, ...TOOL, ...INSERT }, defaults: { revision: '@' }, creates: true },
  squash: {
    positional: 'fileset',
    options: {
      ...REVISION(),
      '-f': opt('from', 'rewrite'), '--from': opt('from', 'rewrite'),
      '-t': opt('into', 'rewrite'), '--into': opt('into', 'rewrite'), '--to': opt('into', 'rewrite'),
      ...MESSAGE,
      ...TOOL,
      ...INSERT,
    },
  },
  'bookmark create': { positional: 'name', options: { ...REVISION('bookmark') }, defaults: { revision: '@' } },
  'bookmark set': { positional: 'name', options: { ...REVISION('bookmark') }, defaults: { revision: '@' } },
  'bookmark move': {
    positional: 'name',
    options: { '-f': opt('from', 'source'), '--from': opt('from', 'source'), '-t': opt('to', 'bookmark'), '--to': opt('to', 'bookmark') },
    defaults: { to: '@' },
  },
  'bookmark delete': { positional: 'name', options: {} },
  'bookmark forget': { positional: 'name', options: {} },
  'bookmark rename': { positional: 'name', options: {} },
  'bookmark track': { positional: 'name', options: {} },
  'bookmark untrack': { positional: 'name', options: {} },
  'tag set': { positional: 'name', options: { ...REVISION('source') }, defaults: { revision: '@' } },
  'tag delete': { positional: 'name', options: {} },
  'op restore': { positional: 'value', options: {}, recovery: true },
  'op revert': { positional: 'value', options: {}, recovery: true },
});

/** Commands whose first positional argument names a subcommand. */
const GROUPS = new Set(['bookmark', 'b', 'tag', 'op', 'operation', 'git', 'workspace', 'config', 'util', 'file', 'sparse', 'gerrit']);
const GROUP_ALIASES = { b: 'bookmark', operation: 'op' };

/**
 * Split a jj argv (without the leading `jj`) into command, options and
 * positional arguments using the command's spec.
 *
 * @param {readonly string[]} args
 */
export function parseJjArgs(args) {
  const out = { command: '', spec: null, options: [], positional: [], flags: [], ignoreImmutable: false };
  if (!Array.isArray(args) || args.length === 0) return out;

  const words = [];
  const rest = [];
  let i = 0;
  // Leading global options may precede the command.
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--ignore-immutable') { out.ignoreImmutable = true; continue; }
    if (GLOBAL_VALUE_OPTIONS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    break;
  }
  if (i < args.length) words.push(args[i++]);
  const group = GROUP_ALIASES[words[0]] ?? words[0];
  if (words.length) words[0] = group;
  if (GROUPS.has(group)) {
    for (; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) { rest.push(a); continue; }
      words.push(a);
      i++;
      break;
    }
  }
  rest.push(...args.slice(i));
  out.command = words.join(' ');
  const spec = JJ_COMMAND_SPECS[out.command] ?? null;
  out.spec = spec;
  const options = spec?.options ?? {};

  let positionalOnly = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (positionalOnly) { out.positional.push(a); continue; }
    if (a === '--') { positionalOnly = true; continue; }
    if (a === '--ignore-immutable') { out.ignoreImmutable = true; continue; }
    if (GLOBAL_VALUE_OPTIONS.has(a)) { k++; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (GLOBAL_VALUE_OPTIONS.has(name)) continue;
      const o = options[name];
      if (!o) { out.flags.push(name); continue; }
      const value = eq === -1 ? rest[++k] : a.slice(eq + 1);
      if (value !== undefined) out.options.push({ name, ...o, value });
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const name = a.slice(0, 2);
      const o = options[name];
      if (!o) { out.flags.push(a); continue; }
      const attached = a.slice(2).replace(/^=/, '');
      const value = attached ? attached : rest[++k];
      if (value !== undefined) out.options.push({ name, ...o, value });
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

/**
 * Describe what a jj command does to the revisions it names.
 *
 * @param {readonly string[]} args jj argv without the leading `jj`
 * @returns {{
 *   command: string,
 *   known: boolean,
 *   rewrites: string[],
 *   parents: string[],
 *   sources: string[],
 *   bookmarks: { names: string[], target: string }[],
 *   revisionArgs: string[],
 *   filesets: string[],
 *   ignoreImmutable: boolean,
 *   recovery: boolean,
 *   creates: boolean,
 * }}
 */
export function describeMutation(args) {
  const p = parseJjArgs(args);
  const spec = p.spec;
  const result = {
    command: p.command,
    known: Boolean(spec),
    rewrites: [],
    parents: [],
    sources: [],
    bookmarks: [],
    revisionArgs: [],
    filesets: [],
    ignoreImmutable: p.ignoreImmutable,
    recovery: Boolean(spec?.recovery),
    creates: Boolean(spec?.creates),
  };
  if (!spec) return result;

  /** @type {Record<string, { role: string, values: string[] }>} */
  const slots = {};
  const put = (slot, role, value) => {
    slots[slot] ??= { role, values: [] };
    slots[slot].values.push(value);
  };
  for (const o of p.options) {
    if (o.role === 'value') continue;
    put(o.slot, o.role, o.value);
    result.revisionArgs.push(o.value);
  }
  for (const a of p.positional) {
    if (spec.positional === 'fileset') result.filesets.push(a);
    else if (['rewrite', 'parent', 'source'].includes(spec.positional)) {
      put(spec.positionalSlot ?? 'positional', spec.positional, a);
      result.revisionArgs.push(a);
    }
  }
  for (const [slot, rev] of Object.entries(spec.defaults ?? {})) {
    if (!slots[slot]) {
      const role = Object.values(spec.options).find((o) => o.slot === slot)?.role ?? spec.positional;
      put(slot, role, rev);
    }
  }

  if (p.command === 'squash') squashSlots(slots, put);
  if (p.command === 'restore' && !slots.into && !slots.changes) put('into', 'rewrite', '@');
  if (p.command === 'new' && !slots.parents && !slots.revision && !slots.after && !slots.before) put('parents', 'parent', '@');
  if (p.command === 'rebase' && !slots.branch && !slots.source && !slots.revision) put('branch', 'rewrite', '@');
  if (p.command === 'metaedit' && p.flags.includes('--update-change-id')) result.recovery = true;

  // `bookmark move --from X --to Y` names no bookmark but still points some at Y.
  const bookmarkNames = p.command.startsWith('bookmark ')
    ? (p.positional.length ? p.positional : slots.from ? slots.from.values.map((v) => `(bookmarks on ${v})`) : [])
    : [];
  for (const { role, values } of Object.values(slots)) {
    for (const v of values) {
      if (role === 'rewrite') result.rewrites.push(v);
      else if (role === 'children') result.rewrites.push(childrenOf(v));
      else if (role === 'parent') result.parents.push(v);
      else if (role === 'source') result.sources.push(v);
      else if (role === 'bookmark' && bookmarkNames.length) result.bookmarks.push({ names: [...bookmarkNames], target: v });
    }
  }
  result.rewrites = [...new Set(result.rewrites)];
  result.parents = [...new Set(result.parents)];
  result.sources = [...new Set(result.sources)];
  return result;
}

/** `jj squash` moves changes from sources into a destination; both are rewritten. */
function squashSlots(slots, put) {
  const inserting = slots.onto || slots.after || slots.before;
  if (slots.revision) {
    // `-r X` squashes X into its parent.
    for (const r of slots.revision.values) {
      put('from', 'rewrite', r);
      if (!inserting) put('into', 'rewrite', parentsOf(r));
    }
    delete slots.revision;
    return;
  }
  if (!slots.from) put('from', 'rewrite', '@');
  if (!slots.into && !inserting) {
    // "If either is left out, it defaults to the working-copy commit";
    // with neither, jj squashes @ into @-.
    const explicitFrom = slots.from.values.some((v) => v !== '@');
    put('into', 'rewrite', explicitFrom ? '@' : '@-');
  }
}

const SIMPLE_SYMBOL = /^[\w@./-]+$/;
/** The children of a revset, written so jj and the in-memory resolver both parse it. */
export function childrenOf(revset) {
  return SIMPLE_SYMBOL.test(revset) && !revset.endsWith('-') ? `${revset}+` : `(${revset})+`;
}
/** The parents of a revset. */
export function parentsOf(revset) {
  return SIMPLE_SYMBOL.test(revset) && !revset.endsWith('+') ? `${revset}-` : `(${revset})-`;
}

/**
 * Backwards-compatible helper: the revisions a jj argv rewrites.
 * Destination-only revisions (`-o`, `jj new X`) are left out; insert-before
 * targets and squash destinations are included because jj rewrites them.
 *
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function extractMutatedTargets(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  return describeMutation(args).rewrites;
}
