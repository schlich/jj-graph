/**
 * JjrGraph: in-memory model of a living Jujutsu revision DAG.
 *
 * Bridges directly with jj-graph's `readNodes()` output (`JjrGraph.fromJjGraphNodes`)
 * as well as standalone programmatic construction, enforcing zone separation
 * (`immutable` vs `mutable`), algebraic conflict awareness, the Two-Part Dependency
 * Test, canonical DAG shapes, and topological diagnostics.
 */

import {
  CANONICAL_SHAPES,
  DEFAULT_REPO_CONFIG,
  inferIntentFallback,
  isCodePath,
  isTestPath,
  verificationState,
} from './types.mjs';

const ROOT_COMMIT = '0'.repeat(40);
/** Loose `refs/jj/keep/*` refs above which `jj util gc` is worth running. */
const GC_KEEP_REF_THRESHOLD = 5000;
/** An activation switch touching more files than this is carrying plumbing. */
const ACTIVATION_MAX_FILES = 3;

function stripParens(expr) {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      if (depth === 0) { balanced = false; break; }
    }
    if (!balanced) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

export class JjrGraph {
  /**
   * @param {readonly object[]} changes
   * @param {Partial<typeof DEFAULT_REPO_CONFIG>} [config]
   * @param {{ preflight?: object | null }} [context] repository facts gathered by a pre-flight check
   */
  constructor(changes, config = {}, context = {}) {
    /** @type {Readonly<typeof DEFAULT_REPO_CONFIG>} */
    this.config = Object.freeze({ ...DEFAULT_REPO_CONFIG, ...config });
    /** Pre-flight facts (trunk(), immutable_heads(), Git compatibility), or null when not run. */
    this.preflight = context.preflight ?? null;
    /** @type {Map<string, any>} */
    this._byChange = new Map();
    /** @type {Map<string, any>} */
    this._byCommit = new Map();
    /** @type {Map<string, any[]>} */
    this._allVersions = new Map();
    /** @type {Map<string, Set<string>>} */
    this._children = new Map();
    this._trunkAncestry = null;

    for (const c of changes) {
      const list = this._allVersions.get(c.changeId) ?? [];
      list.push(c);
      this._allVersions.set(c.changeId, list);
      // Primary entry prefers non-hidden, working-copy, or newest seen
      const existing = this._byChange.get(c.changeId);
      if (!existing || c.isWorkingCopy) {
        this._byChange.set(c.changeId, c);
      }
      if (c.currentCommit?.commitId) {
        this._byCommit.set(c.currentCommit.commitId, c);
      }
    }

    // Mark divergence automatically if multiple visible commits share a ChangeId
    for (const [changeId, versions] of this._allVersions.entries()) {
      if (versions.length > 1) {
        const primary = this._byChange.get(changeId);
        const divergentCommits = versions.map((v) => v.currentCommit.commitId);
        this._byChange.set(changeId, {
          ...primary,
          isDivergent: true,
          divergentCommits,
        });
      }
    }

    const addChild = (parent, child) => {
      const set = this._children.get(parent) ?? new Set();
      set.add(child);
      this._children.set(parent, set);
    };
    for (const c of this._byChange.values()) {
      for (const p of c.parents ?? []) addChild(p, c.changeId);
      for (const ch of c.children ?? []) addChild(c.changeId, ch);
    }
  }

  /**
   * Build a JjrGraph directly from jj-graph's `readNodes()` array (as returned by `/api/state`).
   *
   * @param {readonly any[]} nodes
   * @param {Partial<typeof DEFAULT_REPO_CONFIG> & {
   *   intents?: Record<string, string>,
   *   verifications?: Record<string, any>,
   *   preflight?: object | null,
   * }} [options]
   */
  static fromJjGraphNodes(nodes, options = {}) {
    const { intents = {}, verifications = {}, preflight = null, ...config } = options;
    const mergedConfig = { ...DEFAULT_REPO_CONFIG, ...config };

    // Index commit_id -> node so parent CommitIds resolve to ChangeIds.
    const commitToNode = new Map();
    for (const n of nodes) commitToNode.set(n.id, n);

    // Pre-compute children by ChangeId.
    const childrenByChange = new Map();
    for (const n of nodes) {
      for (const pCommit of n.parents ?? []) {
        const pNode = commitToNode.get(pCommit);
        if (pNode) {
          const arr = childrenByChange.get(pNode.change) ?? [];
          if (!arr.includes(n.change)) arr.push(n.change);
          childrenByChange.set(pNode.change, arr);
        }
      }
    }

    const changes = nodes.map((n) => {
      const parentNodes = (n.parents ?? []).map((p) => commitToNode.get(p)).filter(Boolean);
      const parentChangeIds = [...new Set(parentNodes.map((p) => p.change))];
      const mutableParentCount = parentNodes.filter((p) => !p.immutable).length;
      const bookmarks = (n.bookmarks ?? []).map((b) => (typeof b === 'string' ? b : b.name));
      const touchedPaths = n.paths ?? n.touchedPaths ?? [];
      const intent =
        intents[n.change] ??
        inferIntentFallback({
          description: n.description,
          isEmpty: Boolean(n.empty),
          isWorkingCopy: Boolean(n.wc),
          mutableParentCount,
          touchedPaths,
          megamergePrefix: mergedConfig.megamergePrefix,
        });

      return {
        changeId: n.change,
        prefix: n.prefix ?? n.change.slice(0, 4),
        currentCommit: {
          commitId: n.id,
          changeId: n.change,
          parentCommits: n.parents ?? [],
          isEmpty: Boolean(n.empty),
          conflict: n.conflict
            ? { isConflicted: true, conflictedPaths: n.conflictedPaths ?? [] }
            : { isConflicted: false },
          author: n.author ?? '',
          timestamp: n.time ?? '',
          touchedPaths,
          filesCount: n.files ?? touchedPaths.length,
          description: n.description ?? '',
        },
        zone: n.immutable ? 'immutable' : 'mutable',
        parents: parentChangeIds,
        children: childrenByChange.get(n.change) ?? [],
        bookmarks,
        remotes: n.remotes ?? [],
        tags: n.tags ?? [],
        workspaces: n.workspaces ?? [],
        isWorkingCopy: Boolean(n.wc),
        isHidden: Boolean(n.hidden),
        intent,
        // Verification is per snapshot: without a record for this commit, nothing is known.
        verification: verifications[n.change] ?? {
          formatted: null,
          builds: null,
          testsPass: null,
          verified: false,
        },
        isDivergent: Boolean(n.divergent),
        divergentCommits: n.divergent ? [n.id] : undefined,
      };
    });

    return new JjrGraph(changes, mergedConfig, { preflight });
  }

  get(changeId) {
    return this._byChange.get(changeId);
  }

  getByCommit(commitId) {
    return this._byCommit.get(commitId);
  }

  require(changeId) {
    const found = this._byChange.get(changeId);
    if (!found) throw new Error(`Change ${changeId} not found in active JjrGraph.`);
    return found;
  }

  all() {
    return Array.from(this._byChange.values());
  }

  mutable() {
    return this.all().filter((c) => c.zone === 'mutable');
  }

  immutable() {
    return this.all().filter((c) => c.zone === 'immutable');
  }

  workingCopy() {
    return this.all().find((c) => c.isWorkingCopy);
  }

  divergent() {
    return this.all().filter((c) => c.isDivergent);
  }

  conflicted() {
    return this.all().filter((c) => c.currentCommit.conflict?.isConflicted);
  }

  /** Change ids of the loaded children of a change. */
  childrenOf(changeId) {
    return [...(this._children.get(changeId) ?? [])];
  }

  /**
   * Resolve a small revset against the loaded graph: `@`, `<workspace>@`,
   * bookmark and tag names, change-id and commit-id prefixes, wrapped in
   * parentheses and followed by any number of `-` (parents) and `+`
   * (children) operators. Anything richer (functions, `::`, `|`) returns []:
   * jj-graph's server resolves those with jj itself.
   *
   * @param {string} revset
   * @returns {any[]}
   */
  resolve(revset) {
    if (typeof revset !== 'string' || !revset.trim()) return [];
    let expr = stripParens(revset);
    const ops = [];
    for (let m = /^(.+?)([+-])$/s.exec(expr); m; m = /^(.+?)([+-])$/s.exec(expr)) {
      ops.unshift(m[2]);
      expr = stripParens(m[1]);
    }
    let nodes = this._resolveSymbol(expr);
    for (const op of ops) {
      const next = new Map();
      for (const n of nodes) {
        const ids = op === '-' ? n.parents ?? [] : this.childrenOf(n.changeId);
        for (const id of ids) {
          const node = this._byChange.get(id);
          if (node) next.set(node.changeId, node);
        }
      }
      nodes = [...next.values()];
    }
    return nodes;
  }

  _resolveSymbol(sym) {
    if (sym === '@') {
      const wc = this.workingCopy();
      return wc ? [wc] : [];
    }
    if (!/^[\w./@-]+$/.test(sym)) return [];
    if (sym.endsWith('@') && sym.length > 1) {
      const ws = sym.slice(0, -1);
      return this.all().filter((c) => (c.workspaces ?? []).includes(ws));
    }
    // Like jj, names win over id prefixes.
    const byName = this.all().filter((c) => (c.bookmarks ?? []).includes(sym) || (c.tags ?? []).includes(sym));
    if (byName.length) return byName;
    const lower = sym.toLowerCase();
    if (/^[k-z]+$/.test(lower)) {
      const hits = this.all().filter((c) => c.changeId.startsWith(lower));
      return hits.length === 1 ? hits : [];
    }
    if (/^[0-9a-f]+$/.test(lower)) {
      const hits = [...this._byCommit.entries()].filter(([cid]) => cid.startsWith(lower)).map(([, c]) => c);
      return hits.length === 1 ? [this._byChange.get(hits[0].changeId) ?? hits[0]] : [];
    }
    return [];
  }

  /** The loaded trunk() change, when a pre-flight resolved it to something other than root(). */
  trunk() {
    const t = this.preflight?.trunk;
    if (!t?.resolved || t.isRoot) return null;
    return this.get(t.changeId) ?? this.getByCommit(t.commitId) ?? null;
  }

  /**
   * Whether a change is shared bedrock: immutable, or an ancestor of trunk()
   * even when a misconfigured immutable_heads() left it mutable.
   */
  isBedrock(change) {
    if (!change) return false;
    if (change.zone === 'immutable') return true;
    if (!this._trunkAncestry) {
      this._trunkAncestry = new Set();
      const trunk = this.trunk();
      const stack = trunk ? [trunk.changeId] : [];
      while (stack.length) {
        const id = stack.pop();
        if (this._trunkAncestry.has(id)) continue;
        this._trunkAncestry.add(id);
        stack.push(...(this._byChange.get(id)?.parents ?? []));
      }
    }
    return this._trunkAncestry.has(change.changeId);
  }

  /** The empty, undescribed working copy: the scratchpad, not a unit of work. */
  isScratchpad(change) {
    return Boolean(
      change?.isWorkingCopy &&
        change.currentCommit.isEmpty &&
        !(change.currentCommit.description ?? '').trim() &&
        (change.parents?.length ?? 0) <= 1,
    );
  }

  /**
   * Mutable changes whose parents are all immutable (or outside the loaded graph).
   */
  mutableRoots() {
    return this.mutable().filter((c) =>
      c.parents.every((pId) => {
        const p = this._byChange.get(pId);
        return !p || p.zone === 'immutable';
      }),
    );
  }

  /**
   * Returns true if a change is a local composition megamerge
   * (tagged with `config.megamergePrefix`, marked `megamerge`, or has 2+ mutable parents).
   */
  isMegamerge(change) {
    if (!change) return false;
    if (change.intent === 'megamerge') return true;
    const desc = (change.currentCommit?.description ?? '').trim().toLowerCase();
    const prefix = this.config.megamergePrefix.toLowerCase();
    if (prefix && desc.startsWith(prefix)) return true;
    const mutableParents = (change.parents ?? []).filter((p) => this._byChange.get(p)?.zone === 'mutable');
    return mutableParents.length >= 2;
  }

  /**
   * Return all mutable ancestors of `targetId` (inclusive) in topological
   * order: every change comes after its parents, so the result reads
   * bottom-up the way a stack lands.
   */
  mutableAncestorsOf(targetId) {
    const found = new Map();
    const stack = [targetId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (found.has(id)) continue;
      const node = this._byChange.get(id);
      if (!node || node.zone === 'immutable') continue;
      found.set(id, node);
      for (const p of node.parents ?? []) stack.push(p);
    }
    const ordered = [];
    const placed = new Set();
    const place = (id) => {
      if (placed.has(id) || !found.has(id)) return;
      placed.add(id);
      for (const p of found.get(id).parents ?? []) place(p);
      ordered.push(found.get(id));
    };
    for (const id of [...found.keys()].reverse()) place(id);
    return ordered;
  }

  /**
   * Direct mutable parent -> child pairs eligible for the Two-Part Dependency Test.
   */
  mutableEdges() {
    const edges = [];
    for (const c of this.mutable()) {
      for (const pId of c.parents ?? []) {
        const parent = this._byChange.get(pId);
        if (parent && parent.zone === 'mutable') {
          edges.push({ base: parent, child: c });
        }
      }
    }
    return edges;
  }

  /**
   * Classify the mutable zone as one of the reference's canonical DAG shapes:
   * `resting`, `single`, `stack`, `parallel`, `megamerge`, or the
   * non-canonical `branching` (one root that forks). The empty @ scratchpad
   * is not counted as work.
   *
   * @returns {'resting' | 'single' | 'stack' | 'parallel' | 'megamerge' | 'branching'}
   */
  classifyShape() {
    const work = this.mutable().filter((c) => !this.isScratchpad(c));
    if (work.length === 0) return 'resting';
    if (work.some((c) => this.isMegamerge(c))) return 'megamerge';
    const inWork = new Set(work.map((c) => c.changeId));
    const roots = work.filter((c) => !(c.parents ?? []).some((p) => inWork.has(p)));
    if (roots.length >= 2) return 'parallel';
    if (work.length === 1) return 'single';
    const linear = work.every((c) => this.childrenOf(c.changeId).filter((id) => inWork.has(id)).length <= 1);
    return linear ? 'stack' : 'branching';
  }

  /** The longest chain of mutable work, bottom-up. */
  longestChain() {
    const work = this.mutable().filter((c) => !this.isScratchpad(c) && !this.isMegamerge(c));
    const inWork = new Set(work.map((c) => c.changeId));
    const memo = new Map();
    const chain = (c) => {
      if (memo.has(c.changeId)) return memo.get(c.changeId);
      memo.set(c.changeId, [c]); // cycle guard; a DAG never revisits
      let best = [];
      for (const p of c.parents ?? []) {
        const parent = this._byChange.get(p);
        if (parent && inWork.has(p)) {
          const sub = chain(parent);
          if (sub.length > best.length) best = sub;
        }
      }
      const out = [...best, c];
      memo.set(c.changeId, out);
      return out;
    };
    let longest = [];
    for (const c of work) {
      const ch = chain(c);
      if (ch.length > longest.length) longest = ch;
    }
    return longest;
  }

  /**
   * Two-Part Dependency Test:
   *  1. Causal Necessity: child cannot compile, pass tests, or make sense without base.
   *  2. Independent Reviewability: base is self-contained and landable without reading child.
   *
   * Also supports calibrated probabilities from TypeSafe Jev (`noul` scores in [0, 1])
   * by surfacing an `uncertain` verdict when a probability falls inside the ambiguous band.
   *
   * @param {{
   *   base: string,
   *   child: string,
   *   childCausallyDependsOnBase?: boolean,
   *   baseIndependentlyReviewable?: boolean,
   *   causalProbability?: number,
   *   reviewabilityProbability?: number,
   *   threshold?: { high?: number, low?: number },
   * }} assessment
   */
  static evaluateDependency(assessment) {
    const {
      base,
      child,
      causalProbability,
      reviewabilityProbability,
      threshold = { high: 0.72, low: 0.28 },
    } = assessment;

    const high = threshold.high ?? 0.72;
    const low = threshold.low ?? 0.28;

    const causalUncertain =
      typeof causalProbability === 'number' && causalProbability > low && causalProbability < high;
    const reviewUncertain =
      typeof reviewabilityProbability === 'number' &&
      reviewabilityProbability > low &&
      reviewabilityProbability < high;

    const childCausallyDependsOnBase =
      typeof assessment.childCausallyDependsOnBase === 'boolean'
        ? assessment.childCausallyDependsOnBase
        : (causalProbability ?? 0.5) >= 0.5;
    const baseIndependentlyReviewable =
      typeof assessment.baseIndependentlyReviewable === 'boolean'
        ? assessment.baseIndependentlyReviewable
        : (reviewabilityProbability ?? 0.5) >= 0.5;

    if (causalUncertain || reviewUncertain) {
      return {
        outcome: 'confirm',
        base,
        child,
        causalProbability,
        reviewabilityProbability,
        reason: `Calibrated confidence is in the ambiguous band (causal=${causalProbability?.toFixed(2) ?? 'n/a'}, reviewable=${reviewabilityProbability?.toFixed(2) ?? 'n/a'}). Confirm dependency intent before rewriting the graph.`,
        suggestedArgs: null,
        suggestedCommand: null,
      };
    }

    if (!childCausallyDependsOnBase && baseIndependentlyReviewable) {
      return {
        outcome: 'parallelize',
        base,
        child,
        causalProbability,
        reviewabilityProbability,
        reason: `No causal dependency between ${base.slice(0, 8)} and ${child.slice(0, 8)}. Linear stacking creates an artificial merge bottleneck.`,
        suggestedArgs: ['parallelize', base, child],
        suggestedCommand: `jj parallelize ${base} ${child}`,
      };
    }

    if (childCausallyDependsOnBase && !baseIndependentlyReviewable) {
      return {
        outcome: 'collapse',
        base,
        child,
        causalProbability,
        reviewabilityProbability,
        reason: `${base.slice(0, 8)} is not independently reviewable without ${child.slice(0, 8)} (mutually entangled).`,
        suggestedArgs: ['squash', '--from', child, '--into', base],
        suggestedCommand: `jj squash --from ${child} --into ${base}`,
      };
    }

    if (!childCausallyDependsOnBase && !baseIndependentlyReviewable) {
      return {
        outcome: 'collapse',
        base,
        child,
        causalProbability,
        reviewabilityProbability,
        reason: `${base.slice(0, 8)} is incomplete on its own and ${child.slice(0, 8)} does not causally depend on it; consolidate or split along a clean seam.`,
        suggestedArgs: ['squash', '--from', child, '--into', base],
        suggestedCommand: `jj squash --from ${child} --into ${base}`,
      };
    }

    return {
      outcome: 'stack',
      base,
      child,
      causalProbability,
      reviewabilityProbability,
      reason: `${child.slice(0, 8)} causally depends on ${base.slice(0, 8)}, and ${base.slice(0, 8)} is independently reviewable.`,
      suggestedArgs: null,
      suggestedCommand: null,
    };
  }

  /**
   * Diagnostics from the pre-flight check: whether trunk() and
   * immutable_heads() resolve, whether trunk() is protected, and which Git
   * features jj does not support are in use.
   */
  preflightDiagnostics() {
    const p = this.preflight;
    if (!p) return [];
    const out = [];
    if (!p.trunk?.resolved || !p.immutableHeads?.resolved) {
      out.push({
        severity: 'error',
        code: 'PREFLIGHT_UNRESOLVED',
        message: `trunk() or immutable_heads() does not resolve (${p.trunk?.error || p.immutableHeads?.error || 'unknown error'}). Without the immutable boundary jjr blocks every rewrite.`,
        affectedChanges: [],
        suggestedCommand: `jj log -r 'trunk() | immutable_heads()'`,
      });
      return out;
    }
    const heads = p.immutableHeads.heads ?? [];
    const protectsOnlyRoot = heads.every((h) => h.commitId === ROOT_COMMIT);
    if (p.trunk.isRoot && protectsOnlyRoot) {
      // Without a remote nothing is shared yet, so this is advice, not a warning.
      out.push({
        severity: (p.remotes ?? []).length > 0 ? 'warning' : 'info',
        code: 'PREFLIGHT_NO_BEDROCK',
        message: 'trunk() resolves to root() and immutable_heads() protects nothing else, so every revision is mutable and shared history has no protection.',
        affectedChanges: [],
        suggestedCommand: `jj bookmark track main@origin   # or: jj config set --repo 'revset-aliases."trunk()"' main`,
      });
    } else if (p.trunk.isRoot) {
      out.push({
        severity: 'info',
        code: 'PREFLIGHT_TRUNK_IS_ROOT',
        message: `trunk() resolves to root() (no tracked remote trunk). immutable_heads() still protects ${heads.length} head(s); recipes that start at trunk() will start at root().`,
        affectedChanges: [],
        suggestedCommand: `jj config set --repo 'revset-aliases."trunk()"' main`,
      });
    } else if (!p.trunk.immutable) {
      out.push({
        severity: 'warning',
        code: 'PREFLIGHT_TRUNK_NOT_IMMUTABLE',
        message: `trunk() (${p.trunk.changeId.slice(0, 8)}) is not in immutable(): immutable_heads() was overridden without it. jjr still treats ::trunk() as bedrock.`,
        affectedChanges: p.trunk.changeId ? [p.trunk.changeId] : [],
        suggestedCommand: `jj config set --repo 'revset-aliases."immutable_heads()"' 'builtin_immutable_heads()'`,
      });
    }
    for (const issue of p.gitCompat ?? []) {
      out.push({
        severity: 'warning',
        code: 'GIT_COMPAT',
        message: issue.message,
        affectedChanges: [],
        ...(issue.suggestedCommand ? { suggestedCommand: issue.suggestedCommand } : {}),
      });
    }
    if ((p.keepRefs ?? 0) > GC_KEEP_REF_THRESHOLD) {
      out.push({
        severity: 'info',
        code: 'GC_RECOMMENDED',
        message: `The backing Git repository holds ${p.keepRefs} refs/jj/keep refs. Compact them periodically.`,
        affectedChanges: [],
        suggestedCommand: 'jj util gc',
      });
    }
    return out;
  }

  /**
   * Run deterministic topological & workflow hygiene diagnostics across `mutable()`.
   */
  diagnose() {
    const diagnostics = [...this.preflightDiagnostics()];

    if (this.config.mergeSameChange === 'accept') {
      diagnostics.push({
        severity: 'info',
        code: 'LOSSY_MERGE_CONFIG',
        message: 'merge.same-change is set to "accept" (lossy under round-trip rebases). Prefer "keep" for strict invertibility.',
        affectedChanges: [],
        suggestedCommand: 'jj config set --repo merge.same-change keep',
      });
    }

    const trunk = this.trunk();

    for (const c of this.mutable()) {
      const short = c.changeId.slice(0, 8);
      const isMegamerge = this.isMegamerge(c);
      const isConflicted = Boolean(c.currentCommit.conflict?.isConflicted);
      const paths = c.currentCommit.touchedPaths ?? [];

      if (c.isDivergent) {
        diagnostics.push({
          severity: 'error',
          code: 'DIVERGENT_CHANGE',
          message: `Change ${short} is divergent (${c.divergentCommits?.length ?? 2}+ visible commits share one ChangeId). Resolve before stacking or pushing.`,
          affectedChanges: [c.changeId],
          suggestedCommand: `jj log -r 'divergent()' # then jj converge --no-interactive -r 'change_id(${short})' or jj abandon <commit-id>`,
        });
      }

      if (isMegamerge && c.bookmarks.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'MEGAMERGE_WITH_BOOKMARK',
          message: `Local composition megamerge ${short} carries bookmark(s) [${c.bookmarks.join(', ')}]. Never publish megamerges.`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['bookmark', 'delete', ...c.bookmarks],
          suggestedCommand: `jj bookmark delete ${c.bookmarks.join(' ')}`,
        });
      }

      if (isMegamerge && !c.currentCommit.isEmpty && !isConflicted) {
        diagnostics.push({
          severity: 'info',
          code: 'MEGAMERGE_NOT_EMPTY',
          message: `Megamerge ${short} carries its own edits, which can never be published. Route them to the arms that own those lines.`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['absorb', '--from', c.changeId],
          suggestedCommand: `jj absorb --from ${short}`,
        });
      }

      if (isMegamerge && c.isWorkingCopy) {
        diagnostics.push({
          severity: 'info',
          code: 'MEGAMERGE_AS_WORKING_COPY',
          message: `The working copy is the megamerge ${short} itself, so edits land in a commit that is never pushed. Work in an empty @ on top and absorb fixups into the arms.`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['new', c.changeId],
          suggestedCommand: `jj new ${short}`,
        });
      }

      if (c.isWorkingCopy && !isMegamerge && c.bookmarks.length > 0) {
        diagnostics.push({
          severity: 'info',
          code: 'EDITING_BOOKMARK_TIP',
          message: `The working copy ${short} is the tip of bookmark(s) [${c.bookmarks.join(', ')}], so edits land directly on a named branch. Edit in an empty @ on top and squash what is finished.`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['new', c.changeId],
          suggestedCommand: `jj new ${short}`,
        });
      }

      // Descendants inherit a conflict; flag where it starts (and every bookmarked tip).
      const inherited = (c.parents ?? []).some((p) => this._byChange.get(p)?.currentCommit.conflict?.isConflicted);
      if (isConflicted && (!inherited || c.bookmarks.length > 0)) {
        // Clean resolution pattern: resolve in a child, inspect, squash it down.
        const resolution = this.childrenOf(c.changeId)
          .map((id) => this._byChange.get(id))
          .filter((ch) => ch && ch.zone === 'mutable' && !ch.currentCommit.conflict?.isConflicted && !this.isMegamerge(ch));
        const fold = resolution.length === 1 ? resolution[0] : null;
        const suggestion = fold
          ? { suggestedArgs: ['squash', '--from', fold.changeId, '--into', c.changeId], suggestedCommand: `jj squash --from ${fold.changeId.slice(0, 8)} --into ${short}` }
          : { suggestedArgs: ['new', c.changeId], suggestedCommand: `jj new ${short}   # resolve markers here, check jj diff, then jj squash` };
        diagnostics.push({
          severity: c.bookmarks.length > 0 ? 'warning' : 'info',
          code: c.bookmarks.length > 0 ? 'CONFLICT_IN_PUBLISHABLE' : 'CONFLICTED_CHANGE',
          message: c.bookmarks.length > 0
            ? `Bookmarked change ${short} (${c.bookmarks.join(', ')}) has an unresolved conflict. Resolve before pushing.`
            : fold
              ? `Change ${short} is conflicted and its child ${fold.changeId.slice(0, 8)} resolves it. Fold the resolution down.`
              : `Change ${short} is conflicted. Resolve it in a child commit, inspect the resolution with jj diff, then squash it down.`,
          affectedChanges: fold ? [c.changeId, fold.changeId] : [c.changeId],
          ...suggestion,
        });
      }

      // Tidy First?: structural refactor sitting ABOVE a behavioral change
      if (c.intent === 'structural') {
        for (const pId of c.parents ?? []) {
          const parent = this._byChange.get(pId);
          if (parent && parent.zone === 'mutable' && parent.intent === 'behavioral') {
            diagnostics.push({
              severity: 'warning',
              code: 'UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL',
              message: `Structural refactor ${short} sits above behavioral change ${parent.changeId.slice(0, 8)}. Slip structural tidying beneath behavioral work for low-risk review and revert.`,
              affectedChanges: [parent.changeId, c.changeId],
              suggestedArgs: ['rebase', '-r', c.changeId, '-B', parent.changeId],
              suggestedCommand: `jj rebase -r ${short} -B ${parent.changeId.slice(0, 8)}`,
            });
          }
        }
      }

      if (c.intent === 'activation') {
        diagnostics.push(...this._activationDiagnostics(c));
      }

      // Empty non-working-copy, non-blueprint commit; an empty merge documents the merge.
      if (
        c.currentCommit.isEmpty &&
        !c.isWorkingCopy &&
        c.intent !== 'blueprint' &&
        !isMegamerge &&
        (c.parents?.length ?? 0) < 2
      ) {
        diagnostics.push({
          severity: 'info',
          code: 'EMPTY_NON_BLUEPRINT_CHANGE',
          message: `Change ${short} is empty and undescribed (neither @ nor a stack blueprint).`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['abandon', c.changeId],
          suggestedCommand: `jj abandon ${short}`,
        });
      }

      // Bundle tests with behavior: a finished behavioral change carries its tests.
      if (
        c.intent === 'behavioral' &&
        !c.isWorkingCopy &&
        !c.currentCommit.isEmpty &&
        !isMegamerge &&
        paths.some(isCodePath) &&
        !paths.some(isTestPath)
      ) {
        diagnostics.push({
          severity: 'info',
          code: 'BEHAVIOR_WITHOUT_TESTS',
          message: `Behavioral change ${short} touches code (${paths.filter(isCodePath).slice(0, 3).join(', ')}) but no tests. Bundle its tests in the same change so it is self-verifying and bisectable.`,
          affectedChanges: [c.changeId],
        });
      }

      // Arms belong on trunk(); after trunk() moves, converge them.
      if (trunk && !isMegamerge && (c.parents?.length ?? 0) > 0) {
        const parents = c.parents.map((p) => this._byChange.get(p)).filter(Boolean);
        const isRoot = parents.length === c.parents.length && parents.every((p) => p.zone === 'immutable');
        if (isRoot && !c.parents.includes(trunk.changeId)) {
          diagnostics.push({
            severity: 'info',
            code: 'ROOT_BEHIND_TRUNK',
            message: `${c.isWorkingCopy ? 'The working copy' : 'Mutable root'} ${short} is based on ${parents.map((p) => p.changeId.slice(0, 8)).join(', ')}, not on trunk() (${trunk.changeId.slice(0, 8)}). Rebase it to converge.`,
            affectedChanges: [c.changeId],
            suggestedArgs: ['rebase', '-s', c.changeId, '-o', 'trunk()'],
            suggestedCommand: `jj rebase -s ${short} -o 'trunk()'`,
          });
        }
      }
    }

    const chain = this.longestChain();
    if (chain.length > this.config.maxStackDepth) {
      const top = chain.at(-1);
      diagnostics.push({
        severity: 'info',
        code: 'DEEP_STACK',
        message: `A linear stack of ${chain.length} mutable changes ends at ${top.changeId.slice(0, 8)} (limit ${this.config.maxStackDepth}). Deep stacks are usually horizontal slices; run the Two-Part Dependency Test on their edges and parallelize what does not depend.`,
        affectedChanges: chain.map((c) => c.changeId),
      });
    }

    // Divergence the loaded revset did not show still blocks.
    const shown = new Set(this.divergent().map((c) => c.changeId));
    const hidden = (this.preflight?.divergent ?? []).filter((id) => !shown.has(id));
    if (hidden.length) {
      diagnostics.push({
        severity: 'error',
        code: 'DIVERGENT_CHANGE',
        message: `Divergent change(s) outside the loaded revisions: ${hidden.map((id) => id.slice(0, 8)).join(', ')}. Resolve before stacking or pushing.`,
        affectedChanges: hidden,
        suggestedCommand: `jj log -r 'divergent()'`,
      });
    }

    return diagnostics;
  }

  _activationDiagnostics(c) {
    const out = [];
    const short = c.changeId.slice(0, 8);
    const files = c.currentCommit.filesCount ?? c.currentCommit.touchedPaths?.length ?? 0;
    if (files > ACTIVATION_MAX_FILES) {
      out.push({
        severity: 'info',
        code: 'ACTIVATION_NOT_ISOLATED',
        message: `Activation change ${short} touches ${files} files. Keep the switch tiny and move its plumbing into a change below, so a rollback reverts one switch.`,
        affectedChanges: [c.changeId],
        suggestedCommand: `jj split -r ${short}`,
      });
    }
    const work = (id) => {
      const n = this._byChange.get(id);
      return n && n.zone === 'mutable' && !this.isMegamerge(n) && !this.isScratchpad(n) && !n.currentCommit.isEmpty;
    };
    const above = this.childrenOf(c.changeId).filter(work);
    if (above.length === 0) return out;
    // Heads of the work stacked above the switch.
    const seen = new Set();
    const heads = [];
    const stack = [...above];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const kids = this.childrenOf(id).filter(work);
      if (kids.length === 0) heads.push(id);
      stack.push(...kids);
    }
    const head = heads.length === 1 ? heads[0] : null;
    out.push({
      severity: 'warning',
      code: 'ACTIVATION_NOT_ON_TOP',
      message: `Activation change ${short} has implementation work stacked above it (${above.map((id) => id.slice(0, 8)).join(', ')}). Flip the switch in a top-level change so it lands last and rolls back alone.`,
      affectedChanges: [c.changeId, ...above],
      ...(head
        ? { suggestedArgs: ['rebase', '-r', c.changeId, '-A', head], suggestedCommand: `jj rebase -r ${short} -A ${head.slice(0, 8)}` }
        : {}),
    });
    return out;
  }

  /**
   * Compact health summary suitable for status bars, API payloads, and CLI banners.
   */
  summary() {
    const diagnostics = this.diagnose();
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    const info = diagnostics.filter((d) => d.severity === 'info').length;
    const shape = this.classifyShape();
    const mutable = this.mutable();
    return {
      totalChanges: this.all().length,
      mutableCount: mutable.length,
      immutableCount: this.immutable().length,
      mutableRootsCount: this.mutableRoots().length,
      divergentCount: this.divergent().length,
      conflictedCount: this.conflicted().length,
      megamergeCount: mutable.filter((c) => this.isMegamerge(c)).length,
      verifiedGreenCount: mutable.filter((c) => verificationState(c.verification) === 'green').length,
      shape,
      canonicalShape: CANONICAL_SHAPES[shape],
      resting: shape === 'resting',
      diagnosticsCount: diagnostics.length,
      errors,
      warnings,
      info,
      status: errors > 0 ? 'blocked' : warnings > 0 ? 'attention' : 'clean',
    };
  }
}
