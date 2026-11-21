/**
 * jjr Guardrail Pipeline.
 *
 * Every graph mutation, push, Git interop command, or workspace creation
 * passes through a composable rule pipeline before touching the repository.
 * Deterministic rules enforce hard invariants; an optional Jev System-One
 * pass augments them with calibrated soft risk & readiness judgment.
 */

/**
 * 1. Immutable Bedrock Guard: never rewrite immutable() history.
 */
export function immutableBedrockGuard(graph, action) {
  if (action.type !== 'mutate') {
    return { allowed: true, ruleName: 'ImmutableBedrockGuard', severity: 'pass', message: 'OK' };
  }
  const immutableHits = (action.targetChanges ?? []).filter((id) => {
    const node = graph.get(id) ?? graph.getByCommit(id);
    return node?.zone === 'immutable';
  });
  if (immutableHits.length > 0) {
    return {
      allowed: false,
      ruleName: 'ImmutableBedrockGuard',
      severity: 'block',
      message: `Blocked mutation on immutable() revision(s): ${immutableHits.map((id) => id.slice(0, 8)).join(', ')}.`,
      remediation: 'Create a new mutable change atop trunk() with `jj new trunk()` instead of rewriting shared history.',
    };
  }
  return { allowed: true, ruleName: 'ImmutableBedrockGuard', severity: 'pass', message: 'OK' };
}

/**
 * 2. Divergence Guard: halt stacking or pushing when divergent() is non-empty.
 * Allows recovery commands (`abandon`, `converge`, `op restore`, `op revert`) so
 * the user is never locked out of fixing divergence.
 */
export function divergenceGuard(graph, action) {
  if (action.type !== 'mutate' && action.type !== 'push') {
    return { allowed: true, ruleName: 'DivergenceGuard', severity: 'pass', message: 'OK' };
  }
  if (action.type === 'mutate') {
    const cmd = (action.command ?? '').trim().toLowerCase();
    if (/^(jj\s+)?(abandon|converge|op\s+restore|op\s+revert|operation\s+restore|operation\s+revert)\b/.test(cmd)) {
      return { allowed: true, ruleName: 'DivergenceGuard', severity: 'pass', message: 'Divergence recovery command permitted.' };
    }
  }
  const divergent = graph.divergent();
  if (divergent.length > 0) {
    const ids = divergent.map((d) => d.changeId.slice(0, 8)).join(', ');
    return {
      allowed: false,
      ruleName: 'DivergenceGuard',
      severity: 'block',
      message: `Divergent ChangeId(s) detected (${ids}). Two or more visible commits share one ChangeId.`,
      remediation: 'Inspect with `jj log -r "divergent()"` and resolve via `jj converge` or `jj abandon <commit-id>` before continuing.',
    };
  }
  return { allowed: true, ruleName: 'DivergenceGuard', severity: 'pass', message: 'OK' };
}

/**
 * 3. Megamerge Fence: hard-block pushing any revset that includes a local
 * octopus composition merge.
 */
export function megamergeFence(graph, action) {
  if (action.type !== 'push') {
    return { allowed: true, ruleName: 'MegamergeFence', severity: 'pass', message: 'OK' };
  }
  const megamerges = [];
  for (const id of action.targetChanges ?? []) {
    const target = graph.get(id) ?? graph.getByCommit(id);
    if (!target) continue;
    for (const anc of graph.mutableAncestorsOf(target.changeId)) {
      if (graph.isMegamerge(anc)) {
        megamerges.push(anc.changeId);
      }
    }
  }
  const unique = [...new Set(megamerges)];
  if (unique.length > 0) {
    return {
      allowed: false,
      ruleName: 'MegamergeFence',
      severity: 'block',
      message: `Megamerge Fence triggered: push range includes local composition merge(s) [${unique.map((id) => id.slice(0, 8)).join(', ')}].`,
      remediation: 'Push the underlying feature arms independently (`jj git push -c <arm-change-id>`), never the local megamerge.',
    };
  }
  return { allowed: true, ruleName: 'MegamergeFence', severity: 'pass', message: 'OK' };
}

/**
 * 4. Publishing Gate: every revision in a publishable range must be
 * conflict-free, non-empty (unless blueprint), and passing verification.
 */
export function publishingGate(graph, action) {
  if (action.type !== 'push') {
    return { allowed: true, ruleName: 'PublishingGate', severity: 'pass', message: 'OK' };
  }
  const failures = [];
  for (const id of action.targetChanges ?? []) {
    const target = graph.get(id) ?? graph.getByCommit(id);
    if (!target) continue;
    for (const rev of graph.mutableAncestorsOf(target.changeId)) {
      const short = rev.changeId.slice(0, 8);
      if (rev.currentCommit.conflict?.isConflicted) {
        failures.push(`${short}: unresolved algebraic conflict`);
      }
      if (rev.currentCommit.isEmpty && rev.intent !== 'blueprint') {
        failures.push(`${short}: empty commit`);
      }
      const v = rev.verification;
      if (v && (!v.formatted || !v.builds || !v.testsPass)) {
        failures.push(`${short}: failed verification (format=${v.formatted}, build=${v.builds}, tests=${v.testsPass})`);
      }
    }
  }
  if (failures.length > 0) {
    return {
      allowed: false,
      ruleName: 'PublishingGate',
      severity: 'block',
      message: `Publishing Gate rejected push:\n- ${failures.join('\n- ')}`,
      remediation: 'Resolve conflicts, run `jj fix`, and verify builds and tests across the stack before pushing.',
    };
  }
  return {
    allowed: true,
    ruleName: 'PublishingGate',
    severity: 'pass',
    message: 'All publishable revisions are green and conflict-free.',
  };
}

/**
 * 5. Colocated Single-Writer Guard: block mutating `git` commands in
 * colocated `.jj/.git` repositories.
 */
export function colocatedGitGuard(graph, action) {
  if (action.type !== 'git-interop') {
    return { allowed: true, ruleName: 'ColocatedGitGuard', severity: 'pass', message: 'OK' };
  }
  const cmd = (action.rawGitCommand ?? '').trim().toLowerCase();
  const mutatingGit = /^git\s+(checkout|switch|rebase|commit|merge|reset|cherry-pick|stash|branch\s+-[dDmM])/;
  if (graph.config.colocated && mutatingGit.test(cmd)) {
    return {
      allowed: false,
      ruleName: 'ColocatedGitGuard',
      severity: 'block',
      message: `Blocked mutating Git command "${action.rawGitCommand}" in colocated .jj/.git repository.`,
      remediation: 'Keep jj as the exclusive writer. Running `git checkout` on a conflicted jj commit materializes `.jjconflict-*` trees.',
    };
  }
  return { allowed: true, ruleName: 'ColocatedGitGuard', severity: 'pass', message: 'OK' };
}

/**
 * 6. Workspace Discipline Guard: discourage creating workspaces just to switch branches.
 */
export function workspaceDisciplineGuard(_graph, action) {
  if (action.type !== 'workspace-add') {
    return { allowed: true, ruleName: 'WorkspaceDisciplineGuard', severity: 'pass', message: 'OK' };
  }
  if (action.reason === 'switch-branch') {
    return {
      allowed: false,
      ruleName: 'WorkspaceDisciplineGuard',
      severity: 'block',
      message: 'Blocked unnecessary `jj workspace add` for branch switching.',
      remediation: 'Use anonymous branches (`jj new trunk()`) and local megamerges in one workspace; reserve workspaces for parallel builds or parallel agents.',
    };
  }
  return { allowed: true, ruleName: 'WorkspaceDisciplineGuard', severity: 'pass', message: 'OK' };
}

export const DEFAULT_GUARDRAILS = Object.freeze([
  immutableBedrockGuard,
  divergenceGuard,
  megamergeFence,
  publishingGate,
  colocatedGitGuard,
  workspaceDisciplineGuard,
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

/**
 * Extract target ChangeIds being mutated by a `jj` argv list (ignoring
 * destination-only flags like `-o`, `-d`, `-A`, `-B`, and `jj new`).
 */
export function extractMutatedTargets(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  const cmd = args[0];
  if (cmd === 'new' || cmd === 'op' || cmd === 'operation') return [];
  const DEST_FLAGS = new Set([
    '-o', '-d', '--onto', '--destination', '-A', '-B',
    '--insert-after', '--insert-before', '--after', '--before', '--into',
  ]);
  const targets = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) continue;
    const prev = args[i - 1];
    if (DEST_FLAGS.has(prev)) continue;
    if (/^[k-z]{8,32}$/.test(arg) || /^[0-9a-f]{8,40}$/.test(arg)) {
      targets.push(arg);
    }
  }
  return [...new Set(targets)];
}
