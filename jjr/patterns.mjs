/**
 * Self-evident SDLC patterns and Dual Time-Axis recovery planners.
 *
 * Every recipe produces exact, copyable `jj` commands AND structured argument
 * arrays that can be previewed directly inside jj-graph's dry-run engine
 * (`jj --at-op <tip> --no-integrate-operation ...`).
 */

export const JjrPatterns = {
  /**
   * Tidy First?: Insert a structural refactor beneath active behavioral work.
   */
  tidyFirstBelow(behavioralChangeId, description) {
    const msg = `refactor: ${description}`;
    return {
      id: 'tidy-first',
      pattern: 'Tidy First? (Structural Below Behavioral)',
      summary: 'Isolate zero-behavior-change cleanup beneath behavioral work for low-risk review and clean revert.',
      steps: [
        {
          title: 'Insert structural change directly below active work',
          args: ['new', '-B', behavioralChangeId, '-m', msg],
          command: `jj new -B ${behavioralChangeId.slice(0, 8)} -m ${JSON.stringify(msg)}`,
          dryRunnable: true,
          invariant: 'Descendants auto-rebase onto the structural commit cleanly.',
        },
        {
          title: 'Split tangled edits if already mixed in the behavioral change',
          args: ['split', '-r', behavioralChangeId],
          command: `jj split -r ${behavioralChangeId.slice(0, 8)}`,
          dryRunnable: false,
          invariant: 'Structural layer builds and passes tests on its own.',
        },
      ],
    };
  },

  /**
   * TDD Red-Test Verification: temporarily lift implementation to a sibling arm
   * so tests prove they fail without leaving red-test commits in the DAG.
   */
  verifyRedTest(implFiles) {
    const files = [...implFiles];
    return {
      id: 'tdd-red-test',
      pattern: 'TDD Red-Test Verification',
      summary: 'Verify tests fail without the implementation, without polluting final history with failing commits.',
      steps: [
        {
          title: 'Lift implementation into a parallel sibling change',
          args: ['split', '--parallel', ...files],
          command: `jj split --parallel ${files.join(' ')}`,
          dryRunnable: false,
          invariant: 'Tests remain on the base change; implementation moves to a parallel arm.',
        },
        {
          title: 'Run test suite (expect red)',
          args: null,
          command: 'npm test',
          dryRunnable: false,
          invariant: 'Confirms the test exercises the new behavior.',
        },
        {
          title: 'Fold implementation back into the green change',
          args: ['squash', '--from', '@+', '--into', '@'],
          command: 'jj squash --from @+ --into @',
          dryRunnable: true,
          invariant: 'Restores a single self-verifying green revision.',
        },
      ],
    };
  },

  /**
   * Branch by Abstraction: 5-step buildable subsystem swap.
   */
  branchByAbstraction(seamName) {
    return {
      id: 'branch-by-abstraction',
      pattern: 'Branch by Abstraction (5-Step Subsystem Swap)',
      summary: `Replace a legacy subsystem behind "${seamName}" with zero broken intermediate commits.`,
      steps: [
        {
          title: '1. Introduce abstraction seam',
          args: ['new', 'trunk()', '-m', `refactor: extract ${seamName} interface`],
          command: `jj new trunk() -m "refactor: extract ${seamName} interface"`,
          dryRunnable: true,
          invariant: 'Zero behavior change; existing test suite stays green.',
        },
        {
          title: '2. Implement replacement dark (unwired)',
          args: ['new', '-m', `feat: add new ${seamName} implementation (dark)`],
          command: `jj new -m "feat: add new ${seamName} implementation (dark)"`,
          dryRunnable: true,
          invariant: 'Covered by unit tests; not wired to production traffic.',
        },
        {
          title: '3. Flip activation switch',
          args: ['new', '-m', `feat: activate new ${seamName}`],
          command: `jj new -m "feat: activate new ${seamName}"`,
          dryRunnable: true,
          invariant: 'Tiny isolated change; one-commit rollback if production regresses.',
        },
        {
          title: '4. Remove legacy implementation',
          args: ['new', '-m', `chore: remove legacy ${seamName}`],
          command: `jj new -m "chore: remove legacy ${seamName}"`,
          dryRunnable: true,
          invariant: 'Landed only after the new path stabilizes.',
        },
        {
          title: '5. Contract abstraction (optional)',
          args: ['new', '-m', `refactor: inline ${seamName} seam`],
          command: `jj new -m "refactor: inline ${seamName} seam"`,
          dryRunnable: true,
          invariant: 'Keep the seam if it remains useful for testing.',
        },
      ],
    };
  },

  /**
   * Local Octopus Megamerge for simultaneous multi-arm integration testing.
   */
  localMegamerge(arms, prefix = 'local: dev megamerge') {
    const ids = [...arms];
    return {
      id: 'local-megamerge',
      pattern: 'Local-Only Octopus Megamerge',
      summary: 'Compose parallel feature arms locally for full-app testing without coupling their histories.',
      steps: [
        {
          title: 'Create tagged octopus merge combining parallel arms',
          args: ['new', ...ids, '-m', prefix],
          command: `jj new ${ids.map((id) => id.slice(0, 8)).join(' ')} -m ${JSON.stringify(prefix)}`,
          dryRunnable: true,
          invariant: 'Tagged with local prefix; MegamergeFence hard-blocks pushing it.',
        },
        {
          title: 'Open empty working copy on top for integration fixes',
          args: ['new'],
          command: 'jj new',
          dryRunnable: true,
          invariant: 'Keeps the megamerge node itself clean.',
        },
        {
          title: 'Route scattered fixups back to their owning arms',
          args: ['absorb'],
          command: 'jj absorb',
          dryRunnable: true,
          invariant: 'Unambiguous hunks flow automatically to the ancestor that last touched those lines.',
        },
      ],
    };
  },

  /**
   * Post-Merge Convergence Loop: sync upstream and return to minimal resting state.
   */
  postMergeConvergence(includeParkedSiblings = false) {
    const rootExpr = includeParkedSiblings ? 'roots(mutable())' : 'all:roots(trunk()..@)';
    return {
      id: 'post-merge-convergence',
      pattern: 'Post-Merge Convergence Loop',
      summary: 'Fetch landed upstream commits, collapse empty rebased changes, and rebase active roots onto trunk().',
      steps: [
        {
          title: 'Fetch upstream and drop landed remote branches',
          args: null,
          command: 'jj git fetch',
          dryRunnable: false,
          invariant: 'Landed commits cross into immutable(); deleted remotes clear local bookmarks.',
        },
        {
          title: 'Atomic bulk rebase onto trunk()',
          args: ['rebase', '-s', rootExpr, '-o', 'trunk()'],
          command: `jj rebase -s '${rootExpr}' -o trunk()`,
          dryRunnable: true,
          invariant: 'Resting state converges cleanly onto trunk().',
        },
      ],
    };
  },

  /**
   * Forge-aware publishing command.
   */
  publishCommand(forge, changeId) {
    const short = changeId.slice(0, 8);
    switch (forge) {
      case 'gerrit':
        return `jj gerrit upload -r ${short}`;
      case 'github-stack':
        return `jj-stack submit ${short}`;
      case 'github-spr':
        return `jj-spr diff -r ${short}`;
      case 'github-bookmarks':
      default:
        return `jj git push -c ${short}`;
    }
  },
};

/**
 * Dual Time-Axis Recovery Planner.
 * Prefers surgical single-change `evolog` restore over repo-wide `op restore`
 * whenever sibling arms have independent work worth preserving.
 *
 * @param {{
 *   scope: 'single-change' | 'repo-wide' | 'undo',
 *   targetOpId?: string,
 *   targetChangeId?: string,
 *   targetEvologCommit?: string,
 * }} params
 */
export function planTimeTravelRecovery(params) {
  if (params.scope === 'single-change' && params.targetChangeId && params.targetEvologCommit) {
    return {
      axis: 'evolog',
      args: ['restore', '--from', params.targetEvologCommit, '--to', params.targetChangeId],
      command: `jj restore --from ${params.targetEvologCommit.slice(0, 8)} --to ${params.targetChangeId.slice(0, 8)}`,
      explanation: `Restores only change ${params.targetChangeId.slice(0, 8)} to snapshot ${params.targetEvologCommit.slice(0, 8)} without disturbing sibling arms or repo bookmarks.`,
      blastRadius: 'single-change',
    };
  }

  if (params.targetOpId) {
    return {
      axis: 'op-log',
      args: ['op', 'restore', params.targetOpId],
      command: `jj op restore ${params.targetOpId.slice(0, 12)}`,
      explanation: `Rewinds the entire repository (commits, bookmarks, working copy) to operation ${params.targetOpId.slice(0, 12)}.`,
      blastRadius: 'repo-wide',
    };
  }

  return {
    axis: 'op-log',
    args: ['undo'],
    command: 'jj undo',
    explanation: 'Reverts the immediately preceding jj operation.',
    blastRadius: 'repo-wide',
  };
}

/**
 * Inspect a live JjrGraph and return the most relevant SDLC recipes tailored
 * to its current topology (e.g., megamerge composition when 2+ parallel roots exist,
 * Tidy First? when behavioral work is active, convergence when mutable changes exist).
 */
export function suggestPatternsForGraph(graph) {
  const recipes = [];
  const roots = graph.mutableRoots().filter((r) => !r.isWorkingCopy || !r.currentCommit.isEmpty);
  const wc = graph.workingCopy();

  if (roots.length >= 2) {
    recipes.push(JjrPatterns.localMegamerge(roots.slice(0, 4).map((r) => r.changeId)));
  }

  const activeBehavioral =
    (wc && wc.intent === 'behavioral' ? wc : null) ??
    graph.mutable().find((c) => c.intent === 'behavioral');
  if (activeBehavioral) {
    recipes.push(JjrPatterns.tidyFirstBelow(activeBehavioral.changeId, 'prep seam before feature'));
  }

  if (graph.mutable().length > 0) {
    recipes.push(JjrPatterns.postMergeConvergence(roots.length > 1));
  }

  return recipes;
}
