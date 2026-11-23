/**
 * jjr Guardrail Pipeline.
 *
 * Every graph mutation, bookmark, push, Git interop command, or workspace
 * creation passes through a composable rule pipeline before touching the
 * repository. Deterministic rules enforce hard invariants; an optional Jev
 * System-One pass augments them with calibrated soft risk & readiness judgment.
 *
 * Actions:
 *   { type: 'mutate', args?, command, targetChanges, resolvedTargets?, bookmarks?, ignoreImmutable?, recovery? }
 *   { type: 'bookmark', bookmarks?: string[], targetChanges }
 *   { type: 'push', targetChanges, bookmark? }
 *   { type: 'git-interop', rawGitCommand }
 *   { type: 'workspace-add', reason }
 */

import { describeMutation } from './commands.mjs';
import { verificationState } from './types.mjs';

const ROOT_COMMIT = '0'.repeat(40);
const pass = (ruleName, message = 'OK') => ({ allowed: true, ruleName, severity: 'pass', message });

/** Resolve revisions named by an action to loaded changes. */
function targetNodes(graph, ids = []) {
  const out = new Map();
  for (const id of ids) {
    const direct = graph.get(id) ?? graph.getByCommit(id);
    if (direct) out.set(direct.changeId, direct);
    else for (const n of graph.resolve(id)) out.set(n.changeId, n);
  }
  return [...out.values()];
}

/** The changes a push or bookmark would export, or null when the action exports nothing. */
function publishTargets(graph, action) {
  if (action.type === 'push') {
    const nodes = targetNodes(graph, action.targetChanges ?? []);
    if (action.bookmark) {
      for (const n of graph.all()) if ((n.bookmarks ?? []).includes(action.bookmark)) nodes.push(n);
    }
    return nodes;
  }
  if (action.type === 'bookmark') return targetNodes(graph, action.targetChanges ?? []);
  if (action.type === 'mutate' && action.bookmarks?.length) {
    return targetNodes(graph, action.bookmarks.flatMap((b) => b.targetChanges ?? []));
  }
  return null;
}

/** Split a command string into words (quotes kept simple; enough for flags and ids). */
function words(command) {
  return (String(command ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
}

function argsOf(action) {
  if (Array.isArray(action.args)) return action.args;
  const w = words(action.command);
  return w[0] === 'jj' ? w.slice(1) : w;
}

/**
 * 0. Pre-flight Guard: verify trunk() and immutable_heads() resolve before
 * mutating the graph. Uses the facts a pre-flight check attached to the graph
 * (`graph.preflight`); an in-memory graph without them passes.
 */
export function preflightGuard(graph, action) {
  const name = 'PreflightGuard';
  if (!['mutate', 'push', 'bookmark'].includes(action.type)) return pass(name);
  const p = graph.preflight;
  if (!p) return pass(name, 'No pre-flight context (in-memory graph).');
  if (!p.trunk?.resolved || !p.immutableHeads?.resolved) {
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: `trunk() or immutable_heads() does not resolve (${p.trunk?.error || p.immutableHeads?.error || 'unknown error'}), so the immutable boundary is unknown.`,
      remediation: "Fix the revset aliases until `jj log -r 'trunk() | immutable_heads()'` succeeds.",
    };
  }
  const onlyRoot = (p.immutableHeads.heads ?? []).every((h) => h.commitId === ROOT_COMMIT);
  if (p.trunk.isRoot && onlyRoot && (p.remotes ?? []).length > 0) {
    return {
      allowed: true,
      ruleName: name,
      severity: 'warn',
      message: 'trunk() resolves to root() and nothing else is immutable, so history shared through the remote is unprotected.',
      remediation: `Track the remote trunk (\`jj bookmark track main@${p.remotes[0]}\`) or set revset-aliases."trunk()".`,
    };
  }
  if (!p.trunk.isRoot && !p.trunk.immutable) {
    return {
      allowed: true,
      ruleName: name,
      severity: 'warn',
      message: 'trunk() is not in immutable(); jjr guards ::trunk() as bedrock itself.',
      remediation: `jj config set --repo 'revset-aliases."immutable_heads()"' 'builtin_immutable_heads()'`,
    };
  }
  return pass(name, `trunk() resolves to ${p.trunk.isRoot ? 'root()' : p.trunk.changeId.slice(0, 8)} and immutable_heads() resolves.`);
}

/**
 * 1. Immutable Bedrock Guard: never rewrite immutable() history, never
 * force it with --ignore-immutable, and treat ::trunk() as bedrock even when
 * immutable_heads() leaves it out.
 */
export function immutableBedrockGuard(graph, action) {
  const name = 'ImmutableBedrockGuard';
  if (action.type !== 'mutate') return pass(name);
  const forced =
    action.ignoreImmutable === true ||
    (Array.isArray(action.args) && action.args.includes('--ignore-immutable')) ||
    /(^|\s)--ignore-immutable(?=\s|=|$)/.test(action.command ?? '');
  if (forced) {
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: 'Blocked --ignore-immutable: jjr never force-rewrites immutable() history.',
      remediation: 'Create a new mutable change atop trunk() with `jj new trunk()` instead of rewriting shared history.',
    };
  }
  const hits = new Map();
  for (const n of targetNodes(graph, action.targetChanges ?? [])) {
    if (graph.isBedrock(n)) hits.set(n.changeId, n.changeId);
  }
  for (const t of action.resolvedTargets ?? []) {
    if (t.immutable || t.inTrunk) hits.set(t.changeId, t.changeId);
  }
  if (hits.size > 0) {
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: `Blocked mutation on immutable() revision(s): ${[...hits.values()].map((id) => id.slice(0, 8)).join(', ')}.`,
      remediation: 'Create a new mutable change atop trunk() with `jj new trunk()` instead of rewriting shared history.',
    };
  }
  return pass(name);
}

function isRecovery(action) {
  if (typeof action.recovery === 'boolean') return action.recovery;
  if (Array.isArray(action.args)) return describeMutation(action.args).recovery;
  const cmd = (action.command ?? '').trim().toLowerCase();
  return (
    /^(jj\s+)?(abandon|converge|op\s+restore|op\s+revert|operation\s+restore|operation\s+revert)\b/.test(cmd) ||
    /^(jj\s+)?metaedit\b.*--update-change-id/.test(cmd)
  );
}

/**
 * 2. Divergence Guard: halt stacking, bookmarking or pushing while
 * divergent() is non-empty. Recovery commands (`abandon`, `converge`,
 * `metaedit --update-change-id`, `op restore`, `op revert`) stay open so the
 * user is never locked out of fixing divergence.
 */
export function divergenceGuard(graph, action) {
  const name = 'DivergenceGuard';
  if (!['mutate', 'push', 'bookmark'].includes(action.type)) return pass(name);
  if (action.type === 'mutate' && isRecovery(action)) {
    return pass(name, 'Divergence recovery command permitted.');
  }
  const ids = new Set(graph.divergent().map((d) => d.changeId));
  for (const id of graph.preflight?.divergent ?? []) ids.add(id);
  if (ids.size > 0) {
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: `Divergent ChangeId(s) detected (${[...ids].map((id) => id.slice(0, 8)).join(', ')}). Two or more visible commits share one ChangeId.`,
      remediation: 'Inspect with `jj log -r "divergent()"` and resolve via `jj converge` or `jj abandon <commit-id>` before continuing.',
    };
  }
  return pass(name);
}

/**
 * 3. Megamerge Fence: hard-block pushing (or bookmarking for export) any
 * revset that includes a local octopus composition merge.
 */
export function megamergeFence(graph, action) {
  const name = 'MegamergeFence';
  const targets = publishTargets(graph, action);
  if (!targets) return pass(name);
  const megamerges = new Set();
  for (const target of targets) {
    for (const anc of graph.mutableAncestorsOf(target.changeId)) {
      if (graph.isMegamerge(anc)) megamerges.add(anc.changeId);
    }
  }
  if (megamerges.size > 0) {
    const what = action.type === 'push' ? 'push range' : 'bookmark target';
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: `Megamerge Fence triggered: ${what} includes local composition merge(s) [${[...megamerges].map((id) => id.slice(0, 8)).join(', ')}].`,
      remediation: 'Push the underlying feature arms independently (`jj git push -c <arm-change-id>`), never the local megamerge.',
    };
  }
  return pass(name);
}

/**
 * 4. Publishing Gate: before creating a bookmark or pushing, every revision
 * in the publishable range must be (a) conflict-free, (b) non-empty unless it
 * documents a merge or a planned blueprint, and (c, d) formatted, building
 * and passing tests. Known failures block both; revisions nobody verified yet
 * block a push and warn on a bookmark.
 */
export function publishingGate(graph, action) {
  const name = 'PublishingGate';
  const targets = publishTargets(graph, action);
  if (!targets) return pass(name);
  const strict = action.type === 'push';
  const failures = [];
  const unverified = [];
  const seen = new Set();
  for (const target of targets) {
    for (const rev of graph.mutableAncestorsOf(target.changeId)) {
      if (seen.has(rev.changeId) || graph.isMegamerge(rev)) continue; // the fence reports megamerges
      seen.add(rev.changeId);
      const short = rev.changeId.slice(0, 8);
      const placeholder = rev.currentCommit.isEmpty && (rev.intent === 'blueprint' || (rev.parents?.length ?? 0) >= 2);
      if (rev.currentCommit.conflict?.isConflicted) failures.push(`${short}: unresolved algebraic conflict`);
      if (rev.currentCommit.isEmpty && !placeholder) failures.push(`${short}: empty commit`);
      const v = rev.verification;
      const state = verificationState(v);
      if (state === 'red') {
        failures.push(`${short}: failed verification (format=${v.formatted}, build=${v.builds}, tests=${v.testsPass})`);
      } else if (state === 'unknown' && !placeholder) {
        unverified.push(short);
      }
    }
  }
  const what = strict ? 'push' : 'bookmark';
  if (failures.length > 0) {
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: `Publishing Gate rejected ${what}:\n- ${failures.join('\n- ')}`,
      remediation: 'Resolve conflicts, run `jj fix`, and verify builds and tests across the stack before publishing.',
    };
  }
  if (unverified.length > 0) {
    return {
      allowed: !strict,
      ruleName: name,
      severity: strict ? 'block' : 'warn',
      message: `Not verified yet: ${unverified.join(', ')}. Formatting, build and test results are unknown for these snapshots.`,
      remediation: 'Verify the stack: `jj fix` plus `jj run --ignore-changes -r <range> -- <test command>` (jj-graph: POST /api/jjr/verify).',
    };
  }
  return pass(name, 'All publishable revisions are green and conflict-free.');
}

// Git subcommands that only read.
const READ_ONLY_GIT = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'annotate', 'grep', 'ls-files', 'ls-tree', 'ls-remote',
  'rev-parse', 'rev-list', 'cat-file', 'describe', 'shortlog', 'show-ref', 'show-branch', 'for-each-ref',
  'name-rev', 'merge-base', 'check-ignore', 'check-attr', 'check-ref-format', 'count-objects', 'fsck',
  'verify-commit', 'verify-tag', 'var', 'help', 'version', 'whatchanged', 'range-diff', 'cherry',
  'diff-tree', 'diff-index', 'diff-files', 'difftool', 'archive', 'patch-id', 'request-pull', 'show-index',
  'verify-pack', 'get-tar-commit-id',
]);

const GIT_HINTS = {
  checkout: 'Use `jj new <rev>` or `jj edit <rev>`; `git checkout` of a conflicted jj commit materializes .jjconflict-* trees.',
  switch: 'Use `jj new <rev>` or `jj edit <rev>`; `git switch` to a conflicted jj commit materializes .jjconflict-* trees.',
  restore: 'Use `jj restore`.',
  commit: 'Use `jj commit` or `jj describe`; jj snapshots the working copy itself.',
  add: 'jj has no staging area; it snapshots the working copy automatically.',
  rm: 'Delete the file; jj snapshots the working copy automatically.',
  mv: 'Move the file; jj snapshots the working copy automatically.',
  stash: 'Use `jj new @-` to set work aside; the old change stays in the graph.',
  reset: 'Use `jj restore`, `jj abandon`, or `jj op restore`.',
  rebase: 'Use `jj rebase`; `git rebase` strips change-id headers and leaves divergent changes.',
  'cherry-pick': 'Use `jj duplicate`.',
  merge: 'Use `jj new <a> <b>`.',
  revert: 'Use `jj revert`.',
  pull: 'Use `jj git fetch`, then rebase with jj.',
  fetch: "Use `jj git fetch`; fetching behind jj's back leaves conflicted bookmarks (??). Turn off background IDE fetches too.",
  push: 'Use `jj git push`, which applies force-with-lease semantics behind the Publishing Gate.',
  tag: 'jj cannot create annotated tags; use `jj tag set` for lightweight ones.',
  branch: 'Use `jj bookmark`.',
  submodule: 'jj does not support Git submodules.',
  lfs: 'jj does not support Git LFS.',
  gc: 'Use `jj util gc`.',
  clean: 'Use `jj restore` to drop changes; jj tracks untracked files itself.',
  am: 'Apply patches in a jj change so jj stays the only writer.',
  apply: 'Apply patches in a jj change so jj stays the only writer.',
  worktree: 'Use `jj workspace add`, and only for parallel agents or builds.',
};

/** Whether a git invocation only reads. */
export function isReadOnlyGitCommand(rawGitCommand) {
  return gitReadOnly(parseGit(rawGitCommand));
}

function parseGit(raw) {
  const w = words(raw);
  if (w[0] === 'git') w.shift();
  // Skip global options such as `-C dir`, `-c k=v`, `--no-pager`.
  let i = 0;
  while (i < w.length && w[i].startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(w[i])) i++;
    i++;
  }
  return { sub: w[i] ?? '', rest: w.slice(i + 1) };
}

function gitReadOnly({ sub, rest }) {
  if (!sub) return true;
  if (READ_ONLY_GIT.has(sub)) return true;
  const positional = rest.filter((a) => !a.startsWith('-'));
  const flags = rest.filter((a) => a.startsWith('-'));
  const any = (re) => flags.some((f) => re.test(f));
  switch (sub) {
    case 'branch':
      if (any(/^(-[dDmMcCfu]$|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--edit-description|--track|--no-track)/)) return false;
      return positional.length === 0 || any(/^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at|-v|--verbose)/);
    case 'tag':
      if (any(/^(-[adsfmFue]$|--annotate|--delete|--sign|--force|--message|--file|--local-user|--edit)/)) return false;
      return positional.length === 0 || any(/^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)/);
    case 'remote':
      return positional.length === 0 || ['show', 'get-url'].includes(positional[0]);
    case 'stash':
    case 'notes':
      return ['list', 'show'].includes(positional[0]);
    case 'worktree':
      return positional[0] === 'list';
    case 'reflog':
      return positional.length === 0 || positional[0] === 'show';
    case 'config':
      if (['get', 'list'].includes(positional[0])) return true;
      return any(/^(--get|--get-all|--get-regexp|--list|-l)(=|$)/) && !any(/^(--unset|--add|--replace-all|--rename-section|--remove-section|-e$|--edit)/);
    case 'submodule':
      return positional.length === 0 || ['status', 'summary'].includes(positional[0]);
    case 'lfs':
      return ['ls-files', 'status', 'env', 'version'].includes(positional[0]);
    default:
      return false;
  }
}

/**
 * 5. Colocated Single-Writer Guard: in colocated `.jj/.git` repositories jj
 * is the only writer and git is for read-only inspection. Every git command
 * that is not known to only read is blocked, with the jj equivalent.
 */
export function colocatedGitGuard(graph, action) {
  const name = 'ColocatedGitGuard';
  if (action.type !== 'git-interop') return pass(name);
  if (!graph.config.colocated) return pass(name, 'Repository is not colocated.');
  const parsed = parseGit(action.rawGitCommand ?? '');
  if (gitReadOnly(parsed)) return pass(name, `Read-only \`git ${parsed.sub}\` permitted.`);
  return {
    allowed: false,
    ruleName: name,
    severity: 'block',
    message: `Blocked mutating Git command "${action.rawGitCommand}" in colocated .jj/.git repository: jj is the only writer, git is read-only.`,
    remediation: GIT_HINTS[parsed.sub] ?? 'Do it with jj; reserve git for read-only inspection (log, show, diff, status, blame).',
  };
}

/**
 * 6. Workspace Discipline Guard: workspaces are for parallel agents, test
 * suites and builds, never for switching branches.
 */
export function workspaceDisciplineGuard(_graph, action) {
  const name = 'WorkspaceDisciplineGuard';
  if (action.type !== 'workspace-add') return pass(name);
  if (action.reason === 'switch-branch') {
    return {
      allowed: false,
      ruleName: name,
      severity: 'block',
      message: 'Blocked unnecessary `jj workspace add` for branch switching.',
      remediation: 'Use anonymous branches (`jj new trunk()`) and local megamerges in one workspace; reserve workspaces for parallel builds or parallel agents.',
    };
  }
  if (!action.reason) {
    return {
      allowed: true,
      ruleName: name,
      severity: 'warn',
      message: 'Creating a workspace without a stated reason.',
      remediation: 'Add a workspace only when parallel agents, concurrent test suites, or simultaneous builds need their own file tree.',
    };
  }
  return pass(name);
}

/**
 * 7. Change-ID Addressing Guard: reference mutable work by its stable change
 * id. A commit id rotates on every rewrite, so a retry or a later step that
 * reuses it acts on a stale snapshot. Divergent and hidden commits, which a
 * change id cannot name, are exempt.
 */
export function changeIdAddressingGuard(graph, action) {
  const name = 'ChangeIdAddressingGuard';
  if (action.type !== 'mutate') return pass(name);
  const stale = [];
  for (const token of describeMutation(argsOf(action)).revisionArgs) {
    if (!/^[0-9a-f]{4,40}$/i.test(token)) continue;
    const [node] = graph.resolve(token);
    if (!node || node.zone !== 'mutable' || node.isDivergent || node.isHidden) continue;
    if (!node.currentCommit.commitId.startsWith(token.toLowerCase())) continue;
    stale.push(`${token.slice(0, 8)} → ${node.changeId.slice(0, 8)}`);
  }
  if (stale.length > 0) {
    return {
      allowed: true,
      ruleName: name,
      severity: 'warn',
      message: `Mutable work addressed by commit id (${stale.join(', ')}). Commit ids rotate on every rewrite.`,
      remediation: 'Address mutable work by the change id after each arrow; it survives rewrites, retries and later steps.',
    };
  }
  return pass(name);
}

export const DEFAULT_GUARDRAILS = Object.freeze([
  preflightGuard,
  immutableBedrockGuard,
  divergenceGuard,
  megamergeFence,
  publishingGate,
  colocatedGitGuard,
  workspaceDisciplineGuard,
  changeIdAddressingGuard,
]);

/**
 * Composable guardrail pipeline.
 */
export class JjrGuardrailPipeline {
  /**
   * @param {readonly Function[]} [rules]
   */
  constructor(rules = DEFAULT_GUARDRAILS) {
    this.rules = [...rules];
  }

  use(rule) {
    this.rules.push(rule);
    return this;
  }

  /**
   * Synchronous deterministic check.
   */
  evaluate(graph, action) {
    const decisions = this.rules.map((rule) => rule(graph, action));
    const blockers = decisions.filter((d) => !d.allowed && d.severity === 'block');
    const warnings = decisions.filter((d) => d.severity === 'warn');

    return {
      allowed: blockers.length === 0,
      decisions,
      blockers,
      warnings,
    };
  }

  /**
   * Deterministic guardrails + optional TypeSafe Jev System-One calibrated risk check.
   *
   * @param {import('./graph.mjs').JjrGraph} graph
   * @param {any} action
   * @param {{ jev?: import('./jev.mjs').JjrJevAssistant, diffExcerpt?: string }} [opts]
   */
  async evaluateWithJev(graph, action, opts = {}) {
    const base = this.evaluate(graph, action);
    if (!opts.jev || !base.allowed) {
      return { ...base, jevAssessment: null };
    }
    const jevAssessment = await opts.jev.evaluateActionRisk(graph, action, opts.diffExcerpt ?? '');
    const extraDecisions = [];

    if (jevAssessment.looksLikeScratchpad.noul >= 0.78 && action.type === 'push') {
      extraDecisions.push({
        allowed: false,
        ruleName: 'JevScratchpadGate',
        severity: 'block',
        message: `Jev flagged this push target as an unfinished local scratchpad or unmarked megamerge (p=${jevAssessment.looksLikeScratchpad.noul.toFixed(2)}).`,
        remediation: 'Review the diff, describe the change cleanly, or push only the underlying feature arm.',
        calibratedProbability: jevAssessment.looksLikeScratchpad.noul,
      });
    } else if (jevAssessment.looksLikeScratchpad.noul >= 0.45 && action.type === 'push') {
      extraDecisions.push({
        allowed: true,
        ruleName: 'JevScratchpadGate',
        severity: 'warn',
        message: `Jev noticed scratchpad signals in this change (p=${jevAssessment.looksLikeScratchpad.noul.toFixed(2)}). Double-check before publishing.`,
        calibratedProbability: jevAssessment.looksLikeScratchpad.noul,
      });
    }

    if (jevAssessment.blastRadius.score >= 2.2) {
      extraDecisions.push({
        allowed: true,
        ruleName: 'JevBlastRadiusAdvisor',
        severity: 'warn',
        message: `Jev scored this action's blast radius as "${jevAssessment.blastRadius.legend}" (score=${jevAssessment.blastRadius.score.toFixed(2)}, confidence=${jevAssessment.blastRadius.confidence.toFixed(2)}). Preview in dry-run mode first.`,
        remediation: 'Preview with `jj --no-integrate-operation` (or jjr dry-run) before integrating.',
        calibratedConfidence: jevAssessment.blastRadius.confidence,
      });
    }

    const decisions = [...base.decisions, ...extraDecisions];
    const blockers = decisions.filter((d) => !d.allowed && d.severity === 'block');
    const warnings = decisions.filter((d) => d.severity === 'warn');

    return {
      allowed: blockers.length === 0,
      decisions,
      blockers,
      warnings,
      jevAssessment,
    };
  }
}
