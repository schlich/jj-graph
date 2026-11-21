/**
 * JjrGraph: in-memory model of a living Jujutsu revision DAG.
 *
 * Bridges directly with jj-graph's `readNodes()` output (`JjrGraph.fromJjGraphNodes`)
 * as well as standalone programmatic construction, enforcing zone separation
 * (`immutable` vs `mutable`), algebraic conflict awareness, the Two-Part Dependency
 * Test, and topological diagnostics.
 */

import { DEFAULT_REPO_CONFIG, inferIntentFallback } from './types.mjs';

export class JjrGraph {
  /**
   * @param {readonly object[]} changes
   * @param {Partial<typeof DEFAULT_REPO_CONFIG>} [config]
   */
  constructor(changes, config = {}) {
    /** @type {Readonly<typeof DEFAULT_REPO_CONFIG>} */
    this.config = Object.freeze({ ...DEFAULT_REPO_CONFIG, ...config });
    /** @type {Map<string, any>} */
    this._byChange = new Map();
    /** @type {Map<string, any>} */
    this._byCommit = new Map();
    /** @type {Map<string, any[]>} */
    this._allVersions = new Map();

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
  }

  /**
   * Build a JjrGraph directly from jj-graph's `readNodes()` array (as returned by `/api/state`).
   *
   * @param {readonly any[]} nodes
   * @param {Partial<typeof DEFAULT_REPO_CONFIG> & { intents?: Record<string, string>, verifications?: Record<string, any> }} [options]
   */
  static fromJjGraphNodes(nodes, options = {}) {
    const { intents = {}, verifications = {}, ...config } = options;
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
      const intent =
        intents[n.change] ??
        inferIntentFallback({
          description: n.description,
          isEmpty: Boolean(n.empty),
          isWorkingCopy: Boolean(n.wc),
          mutableParentCount,
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
          touchedPaths: n.touchedPaths ?? [],
          filesCount: n.files ?? 0,
          description: n.description ?? '',
        },
        zone: n.immutable ? 'immutable' : 'mutable',
        parents: parentChangeIds,
        children: childrenByChange.get(n.change) ?? [],
        bookmarks,
        remotes: n.remotes ?? [],
        tags: n.tags ?? [],
        isWorkingCopy: Boolean(n.wc),
        intent,
        verification: verifications[n.change] ?? {
          formatted: true,
          builds: !n.conflict,
          testsPass: !n.conflict,
          verified: false,
        },
        isDivergent: Boolean(n.divergent),
        divergentCommits: n.divergent ? [n.id] : undefined,
      };
    });

    return new JjrGraph(changes, mergedConfig);
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
   * Return all mutable ancestors of `targetId` (inclusive), ordered oldest-first.
   */
  mutableAncestorsOf(targetId) {
    const visited = new Set();
    const result = [];
    const stack = [targetId];

    while (stack.length > 0) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this._byChange.get(id);
      if (!node || node.zone === 'immutable') continue;
      result.push(node);
      for (const p of node.parents ?? []) {
        stack.push(p);
      }
    }
    return result.reverse();
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
   * Run deterministic topological & workflow hygiene diagnostics across `mutable()`.
   */
  diagnose() {
    const diagnostics = [];

    if (this.config.mergeSameChange === 'accept') {
      diagnostics.push({
        severity: 'info',
        code: 'LOSSY_MERGE_CONFIG',
        message: 'merge.same-change is set to "accept" (lossy under round-trip rebases). Prefer "keep" for strict invertibility.',
        affectedChanges: [],
        suggestedCommand: 'jj config set --repo merge.same-change keep',
      });
    }

    for (const c of this.mutable()) {
      if (c.isDivergent) {
        diagnostics.push({
          severity: 'error',
          code: 'DIVERGENT_CHANGE',
          message: `Change ${c.changeId.slice(0, 8)} is divergent (${c.divergentCommits?.length ?? 2}+ visible commits share one ChangeId). Resolve before stacking or pushing.`,
          affectedChanges: [c.changeId],
          suggestedCommand: `jj log -r 'divergent()' # then jj converge or jj abandon <commit-id>`,
        });
      }

      if (this.isMegamerge(c) && c.bookmarks.length > 0) {
        diagnostics.push({
          severity: 'error',
          code: 'MEGAMERGE_WITH_BOOKMARK',
          message: `Local composition megamerge ${c.changeId.slice(0, 8)} carries bookmark(s) [${c.bookmarks.join(', ')}]. Never publish megamerges.`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['bookmark', 'delete', ...c.bookmarks],
          suggestedCommand: `jj bookmark delete ${c.bookmarks.join(' ')}`,
        });
      }

      if (c.currentCommit.conflict?.isConflicted && c.bookmarks.length > 0) {
        diagnostics.push({
          severity: 'warning',
          code: 'CONFLICT_IN_PUBLISHABLE',
          message: `Bookmarked change ${c.changeId.slice(0, 8)} (${c.bookmarks.join(', ')}) has an unresolved conflict. Resolve before pushing.`,
          affectedChanges: [c.changeId],
          suggestedCommand: `jj edit ${c.changeId.slice(0, 8)} && jj resolve`,
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
              message: `Structural refactor ${c.changeId.slice(0, 8)} sits above behavioral change ${parent.changeId.slice(0, 8)}. Slip structural tidying beneath behavioral work for low-risk review and revert.`,
              affectedChanges: [parent.changeId, c.changeId],
              suggestedArgs: ['rebase', '-r', c.changeId, '-B', parent.changeId],
              suggestedCommand: `jj rebase -r ${c.changeId.slice(0, 8)} -B ${parent.changeId.slice(0, 8)}`,
            });
          }
        }
      }

      // Empty non-working-copy, non-blueprint, non-megamerge commit
      if (
        c.currentCommit.isEmpty &&
        !c.isWorkingCopy &&
        c.intent !== 'blueprint' &&
        !this.isMegamerge(c)
      ) {
        diagnostics.push({
          severity: 'info',
          code: 'EMPTY_NON_BLUEPRINT_CHANGE',
          message: `Change ${c.changeId.slice(0, 8)} is empty and undescribed (neither @ nor a stack blueprint).`,
          affectedChanges: [c.changeId],
          suggestedArgs: ['abandon', c.changeId],
          suggestedCommand: `jj abandon ${c.changeId.slice(0, 8)}`,
        });
      }
    }

    return diagnostics;
  }

  /**
   * Compact health summary suitable for status bars, API payloads, and CLI banners.
   */
  summary() {
    const diagnostics = this.diagnose();
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    const info = diagnostics.filter((d) => d.severity === 'info').length;
    return {
      totalChanges: this.all().length,
      mutableCount: this.mutable().length,
      immutableCount: this.immutable().length,
      mutableRootsCount: this.mutableRoots().length,
      divergentCount: this.divergent().length,
      conflictedCount: this.conflicted().length,
      megamergeCount: this.mutable().filter((c) => this.isMegamerge(c)).length,
      diagnosticsCount: diagnostics.length,
      errors,
      warnings,
      info,
      status: errors > 0 ? 'blocked' : warnings > 0 ? 'attention' : 'clean',
    };
  }
}
