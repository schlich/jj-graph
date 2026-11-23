/**
 * Self-evident SDLC patterns, forge adapters, and Dual Time-Axis recovery planners.
 *
 * Every recipe produces exact, copyable `jj` commands AND structured argument
 * arrays that can be previewed directly inside jj-graph's dry-run engine
 * (`jj --at-op <tip> --no-integrate-operation ...`). Steps that run external
 * programs or need a human (`jj run`, `jj resolve`) are marked
 * `dryRunnable: false`.
 */

const short = (id) => String(id).slice(0, 8);
const q = (s) => JSON.stringify(s);

/**
 * Forge Integration Matrix: how each publishing bridge maps jj's model.
 * `stackAware` forges upload a whole stack from its top change.
 */
export const FORGE_ADAPTERS = Object.freeze({
  gerrit: Object.freeze({
    name: 'Gerrit (jj gerrit upload)',
    modelAlignment: 'Native 1:1: the Gerrit Change-Id matches the jj change id',
    rewritePropagation: 'Re-uploading creates a new patch set on the same Gerrit change',
    strengths: ['Zero bookmark overhead', 'Native stacks', 'Automatic trailers'],
    caveats: ['Server-side trailers can alter remote commit ids unless local commit trailers are configured (templates.commit_trailers)'],
    needsBookmark: false,
    stackAware: true,
    publish: (changeId) => `jj gerrit upload -r ${short(changeId)}`,
  }),
  'github-bookmarks': Object.freeze({
    name: 'GitHub native bookmarks (jj git push)',
    modelAlignment: 'Moderate: one bookmark = one Git branch',
    rewritePropagation: 'Safe force-push (--force-with-lease semantics)',
    strengths: ['Works everywhere with no extra tooling', 'jj git push -c creates the bookmark'],
    caveats: ['Force-pushes can disrupt GitHub incremental review diffs', 'Stacks need one bookmark per layer'],
    needsBookmark: true,
    stackAware: false,
    publish: (changeId) => `jj git push -c ${short(changeId)}`,
  }),
  'github-stack': Object.freeze({
    name: 'GitHub native stacks (jj-stack / gh stack)',
    modelAlignment: 'High: one local change = one PR',
    rewritePropagation: 'jj-stack tracks PRs by change id and updates bases and branches automatically',
    strengths: ['Native GitHub stack UI', 'Hides bookkeeping branches', 'Crash-recoverable'],
    caveats: ['Reordering middle commits with manual gh stack requires unstacking first to avoid false-merged PR states'],
    needsBookmark: false,
    stackAware: true,
    publish: (changeId) => `jj-stack submit ${short(changeId)}`,
  }),
  'github-spr': Object.freeze({
    name: 'GitHub append-only (jj-spr)',
    modelAlignment: 'High locally, translated remotely',
    rewritePropagation: 'Amend and squash freely locally; jj-spr appends commits to PR branches and squash-lands',
    strengths: ['Preserves GitHub "since last review" diffs', '--cherry-pick lands independent PRs in any order'],
    caveats: ['Requires direct repository write access (no fork PRs)', 'Incompatible with GitHub native stacks'],
    needsBookmark: false,
    stackAware: false,
    publish: (changeId) => `jj-spr diff -r ${short(changeId)}`,
  }),
});

export const JjrPatterns = {
  /**
   * Squash workflow: describe the intent first, work in an empty @ on top,
   * flush finished hunks down. Failed experiments are `jj abandon`ed.
   */
  squashWorkflow(description) {
    return {
      id: 'squash-workflow',
      pattern: 'Squash Workflow (Describe, Scratchpad, Flush)',
      summary: 'Name the unit of work before writing it, experiment in an empty @, and move finished hunks down.',
      steps: [
        {
          title: 'Describe the intended change',
          args: ['describe', '-m', description],
          command: `jj describe -m ${q(description)}`,
          dryRunnable: true,
          invariant: '@ names one coherent intention before any code exists.',
        },
        {
          title: 'Open an empty scratchpad on top',
          args: ['new'],
          command: 'jj new',
          dryRunnable: true,
          invariant: 'Experiments happen in @; the described change stays clean.',
        },
        {
          title: 'Flush finished hunks down',
          args: ['squash'],
          command: 'jj squash   # or: jj squash <path>, jj squash -i',
          dryRunnable: true,
          invariant: 'Failed experiments are discarded with `jj abandon`.',
        },
      ],
    };
  },

  /**
   * Edit workflow: edit the target in place, insert newly discovered
   * prerequisites below @, and walk the stack with next/prev --edit.
   */
  editWorkflow(changeId, prerequisite = null) {
    return {
      id: 'edit-workflow',
      pattern: 'Edit Workflow (In-Place Stack Editing)',
      summary: 'Put @ on the change itself for focused single-node work; descendants rebase automatically.',
      steps: [
        {
          title: 'Edit the target change in place',
          args: ['edit', changeId],
          command: `jj edit ${short(changeId)}`,
          dryRunnable: true,
          invariant: 'Edits amend the change directly; its change id stays stable.',
        },
        ...(prerequisite
          ? [{
              title: 'Insert a newly discovered prerequisite below @',
              args: ['new', '-B', '@', '-m', prerequisite],
              command: `jj new -B @ -m ${q(prerequisite)}`,
              dryRunnable: true,
              invariant: 'Descendants auto-rebase onto the prerequisite.',
            }]
          : []),
        {
          title: 'Walk the stack',
          args: ['next', '--edit'],
          command: 'jj next --edit   # or: jj prev --edit',
          dryRunnable: true,
          invariant: 'Each step edits one node of the stack in place.',
        },
      ],
    };
  },

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
          command: `jj new -B ${short(behavioralChangeId)} -m ${q(msg)}`,
          dryRunnable: true,
          invariant: 'Descendants auto-rebase onto the structural commit cleanly.',
        },
        {
          title: 'Split tangled edits if already mixed in the behavioral change',
          args: ['split', '-r', behavioralChangeId],
          command: `jj split -r ${short(behavioralChangeId)}`,
          dryRunnable: false,
          invariant: 'Structural layer builds and passes tests on its own.',
        },
      ],
    };
  },

  /**
   * Characterization tests before a refactor of untested code: a test-only
   * change slipped below the refactor locks existing behavior down first.
   */
  characterizationTestsBelow(refactorChangeId, area, testCommand = '<test command>') {
    const id = refactorChangeId;
    return {
      id: 'characterization-tests',
      pattern: 'Characterization Tests Before Refactors',
      summary: 'Lock down existing behavior in a test-only change below the refactor, so reviewers and CI see it hold before structure moves.',
      steps: [
        {
          title: 'Insert a test-only change below the refactor',
          args: ['new', '--no-edit', '-B', id, '-m', `test: characterize ${area}`],
          command: `jj new --no-edit -B ${short(id)} -m ${q(`test: characterize ${area}`)}`,
          dryRunnable: true,
          invariant: 'The refactor now sits on top of its safety net.',
        },
        {
          title: 'Write the characterization tests there',
          args: ['edit', `${id}-`],
          command: `jj edit ${short(id)}-`,
          dryRunnable: true,
          invariant: 'The tests pass against the old structure.',
        },
        {
          title: 'Verify both sides of the refactor',
          args: null,
          command: `jj run --ignore-changes -r '${short(id)}- | ${short(id)}' -- ${testCommand}`,
          dryRunnable: false,
          invariant: 'Behavior is identical before and after the structural change.',
        },
      ],
    };
  },

  /**
   * TDD Red-Test Verification: temporarily lift the implementation into a
   * parallel sibling so the tests prove they fail without it, then fold the
   * tests back. `jj split` keeps the change id on the selected (implementation)
   * side and gives the remaining tests a new id, so the tests fold into the
   * implementation and the change keeps its id. No red commit stays in the DAG.
   *
   * @param {readonly string[]} implFiles implementation paths to lift out
   * @param {{ changeId?: string, description?: string, testCommand?: string }} [opts]
   *   changeId: the change under test (its tests and implementation together)
   */
  verifyRedTest(implFiles, opts = {}) {
    const files = [...implFiles];
    const { changeId = null, description = null, testCommand = 'npm test' } = opts;
    const target = changeId ? short(changeId) : '<change>';
    const message = description ? ['-m', description] : [];
    return {
      id: 'tdd-red-test',
      pattern: 'TDD Red-Test Verification',
      summary: 'Verify tests fail without the implementation, without polluting final history with failing commits.',
      steps: [
        ...(changeId
          ? [{
              title: 'Put the working copy on the change under test',
              args: ['edit', changeId],
              command: `jj edit ${target}`,
              dryRunnable: true,
              invariant: '@ holds the behavior together with its tests.',
            }]
          : []),
        {
          title: 'Lift implementation into a parallel sibling change',
          args: ['split', '--parallel', ...message, ...files],
          command: `jj split --parallel ${description ? `-m ${q(description)} ` : ''}${files.join(' ')}`,
          dryRunnable: true,
          invariant: 'The implementation keeps the change id; @ becomes a tests-only sibling.',
        },
        {
          title: 'Run the tests without the implementation (expect red)',
          args: null,
          command: `jj run --ignore-changes -r @ -- ${testCommand}`,
          dryRunnable: false,
          invariant: 'A failing run proves the tests exercise the new behavior.',
        },
        {
          title: 'Fold the tests back into the implementation change',
          args: changeId ? ['squash', '--from', '@', '--into', changeId, '--use-destination-message'] : null,
          command: `jj squash --from @ --into ${target} --use-destination-message`,
          dryRunnable: Boolean(changeId),
          invariant: 'One self-verifying green revision again, under its original change id.',
        },
        ...(changeId
          ? [{
              title: 'Return to the change',
              args: ['edit', changeId],
              command: `jj edit ${target}`,
              dryRunnable: true,
              invariant: 'The temporary tests-only change is gone.',
            }]
          : []),
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
   * Parallel Change (Expand & Contract) for breaking API, signature, or
   * schema changes: expand, migrate, contract, each buildable on its own.
   */
  expandContract(subject, { from = 'the old path', to = 'the new path' } = {}) {
    return {
      id: 'expand-contract',
      pattern: 'Parallel Change (Expand & Contract)',
      summary: `Change ${subject} without a breaking intermediate state: add ${to} beside ${from}, migrate, then delete ${from}.`,
      steps: [
        {
          title: '1. Expand: add the new path alongside the old',
          args: ['new', 'trunk()', '-m', `feat: expand ${subject} with ${to}`],
          command: `jj new trunk() -m ${q(`feat: expand ${subject} with ${to}`)}`,
          dryRunnable: true,
          invariant: `Existing callers of ${from} keep working; ${to} is exercised by tests.`,
        },
        {
          title: '2. Migrate: move callers and data (dual-write, backfill)',
          args: ['new', '-m', `refactor: migrate ${subject} callers to ${to}`],
          command: `jj new -m ${q(`refactor: migrate ${subject} callers to ${to}`)}`,
          dryRunnable: true,
          invariant: 'Each migration step builds on its own; repeat per group of consumers.',
        },
        {
          title: '3. Contract: delete the legacy path',
          args: ['new', '-m', `chore: contract ${subject}, remove ${from}`],
          command: `jj new -m ${q(`chore: contract ${subject}, remove ${from}`)}`,
          dryRunnable: true,
          invariant: 'Lands only once every consumer has migrated, often as a later topic.',
        },
      ],
    };
  },

  /**
   * Separate plumbing from activation: flip the user-facing switch in its
   * own tiny change on top of the finished, dark implementation.
   */
  isolateActivation(stackHeadChangeId, flag) {
    return {
      id: 'isolate-activation',
      pattern: 'Isolated Activation Switch',
      summary: `Keep the implementation dark and flip ${flag} in a tiny top-level change, so a rollback reverts one switch.`,
      steps: [
        {
          title: 'Add the activation switch on top of the plumbing',
          args: ['new', stackHeadChangeId, '-m', `feat: activate ${flag}`],
          command: `jj new ${short(stackHeadChangeId)} -m ${q(`feat: activate ${flag}`)}`,
          dryRunnable: true,
          invariant: 'The switch lands last and reverts alone.',
        },
        {
          title: 'If the switch is still mixed into the plumbing, split it out',
          args: null,
          command: `jj split -r ${short(stackHeadChangeId)}`,
          dryRunnable: false,
          invariant: 'Plumbing changes behavior only once the switch flips.',
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
          command: `jj new ${ids.map(short).join(' ')} -m ${q(prefix)}`,
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
   * Route integration fixups made atop (or inside) a megamerge to their arms.
   */
  absorbFixups(pollutedMegamergeId = null) {
    return {
      id: 'absorb-fixups',
      pattern: 'Absorb Fixups Into Their Arms',
      summary: 'Send each fixup hunk to the arm that last touched those lines; ambiguous hunks stay for a manual squash.',
      steps: [
        ...(pollutedMegamergeId
          ? [{
              title: 'Move edits out of the megamerge itself',
              args: ['absorb', '--from', pollutedMegamergeId],
              command: `jj absorb --from ${short(pollutedMegamergeId)}`,
              dryRunnable: true,
              invariant: 'The megamerge returns to a pure composition node.',
            }]
          : []),
        {
          title: 'Absorb working-copy fixups',
          args: ['absorb'],
          command: 'jj absorb',
          dryRunnable: true,
          invariant: 'Unambiguous hunks land in their owning arms.',
        },
        {
          title: 'Squash each ambiguous hunk into its arm',
          args: null,
          command: 'jj squash --into <arm> <paths>   # Jev routeHunk ranks candidate arms',
          dryRunnable: false,
          invariant: 'Nothing that belongs to an arm stays in @ or the megamerge.',
        },
      ],
    };
  },

  /**
   * When composition reveals a primitive several arms need, extract it into
   * a common ancestor beneath them instead of stacking one arm on another.
   *
   * @param {readonly string[]} arms change ids of the arms that share the primitive
   * @param {string} description
   * @param {{ from?: string, paths?: readonly string[] }} [opts] where the primitive's hunks live now
   */
  extractSharedPrimitive(arms, description, opts = {}) {
    const ids = [...arms];
    const { from = '@', paths = [] } = opts;
    const common = ids.map((id) => `${id}-`).join(' & ');
    const commonShort = ids.map((id) => `${short(id)}-`).join(' & ');
    return {
      id: 'extract-shared-primitive',
      pattern: 'Extract Shared Primitive Into a Common Ancestor',
      summary: 'Let dependencies emerge empirically: the primitive goes beneath every arm that needs it; the arms stay parallel.',
      steps: [
        {
          title: 'Insert one change beneath every arm',
          args: ['new', '--no-edit', ...ids.flatMap((id) => ['-B', id]), '-m', description],
          command: `jj new --no-edit ${ids.map((id) => `-B ${short(id)}`).join(' ')} -m ${q(description)}`,
          dryRunnable: true,
          invariant: 'The new change is the common parent of the arms; they remain siblings.',
        },
        {
          title: 'Move the primitive into it',
          args: paths.length ? ['squash', '--from', from, '--into', common, ...paths] : null,
          command: `jj squash --from ${from === '@' ? '@' : short(from)} --into '${commonShort}' ${paths.length ? paths.join(' ') : '-i'}`,
          dryRunnable: paths.length > 0,
          invariant: 'Each arm now depends on the primitive, and on nothing else.',
        },
      ],
    };
  },

  /**
   * Clean conflict resolution: resolve in a child, inspect, squash down.
   */
  resolveConflictCleanly(conflictedChangeId) {
    const id = conflictedChangeId;
    return {
      id: 'resolve-conflict',
      pattern: 'Clean Conflict Resolution',
      summary: 'Resolve in a child commit so the resolution is reviewable on its own, then fold it into the conflicted change.',
      steps: [
        {
          title: 'Open a resolution child on the conflicted change',
          args: ['new', id],
          command: `jj new ${short(id)}`,
          dryRunnable: true,
          invariant: 'The conflicted change is untouched while you work.',
        },
        {
          title: 'Resolve the conflict markers',
          args: null,
          command: 'jj resolve   # or edit the markers in your editor',
          dryRunnable: false,
          invariant: 'No conflict markers remain in @.',
        },
        {
          title: 'Inspect the exact resolution',
          args: null,
          command: 'jj diff',
          dryRunnable: false,
          invariant: 'The diff of @ is the resolution and nothing else.',
        },
        {
          title: 'Fold the resolution down',
          args: ['squash'],
          command: 'jj squash',
          dryRunnable: true,
          invariant: 'The resolution propagates cleanly to every descendant.',
        },
      ],
    };
  },

  /**
   * Stack-wide validation before publishing: format every mutable revision
   * with `jj fix`, then build and test each one with `jj run`.
   */
  stackValidation(range = 'trunk()..@', testCommand = '<test command>') {
    const revs = `(${range}) & mutable()`;
    return {
      id: 'stack-validation',
      pattern: 'Stack-Wide Validation',
      summary: 'Every publishable node is formatted, builds, and passes its tests on its own, so the stack stays bisectable.',
      steps: [
        {
          title: 'Format every mutable revision in the range',
          args: ['fix', '-s', `roots(${revs})`],
          command: `jj fix -s 'roots(${revs})'`,
          dryRunnable: true,
          invariant: 'Fixes land in the revision that introduced the code; descendants keep them.',
        },
        {
          title: 'Build and test every revision',
          args: null,
          command: `jj run --ignore-changes -r '${revs}' -- ${testCommand}`,
          dryRunnable: false,
          invariant: 'Each revision is green on its own (jj bisect run stays meaningful).',
        },
      ],
    };
  },

  /**
   * Multi-agent composition: an orchestrator joins the agents' working copies
   * (`<workspace>@`) in a local megamerge, with no Git worktree branch locks.
   */
  composeAgentWorkspaces(workspaces, prefix = 'local: agents megamerge') {
    const heads = [...workspaces].map((w) => `${w}@`);
    return {
      id: 'compose-agent-workspaces',
      pattern: 'Compose Agent Workspaces',
      summary: 'Parallel agents work in their own jj workspaces; the orchestrator composes their outputs in one local megamerge.',
      steps: [
        {
          title: "Join the agents' working copies in a local megamerge",
          args: ['new', ...heads, '-m', prefix],
          command: `jj new ${heads.join(' ')} -m ${q(prefix)}`,
          dryRunnable: true,
          invariant: 'Never pushed; MegamergeFence blocks it.',
        },
        {
          title: 'Open an empty scratchpad on top',
          args: ['new'],
          command: 'jj new',
          dryRunnable: true,
          invariant: 'Integration fixes start in @.',
        },
        {
          title: "Route integration fixes back to each agent's arm",
          args: ['absorb'],
          command: 'jj absorb',
          dryRunnable: true,
          invariant: 'Each fix lands in the arm that owns the lines.',
        },
      ],
    };
  },

  /**
   * Post-Merge Convergence Loop: sync upstream and return to minimal resting state.
   * (jj 0.47 accepts several revisions for `-s` without the old `all:` prefix.)
   */
  postMergeConvergence(includeParkedSiblings = false) {
    const rootExpr = includeParkedSiblings ? 'roots(mutable())' : 'roots(trunk()..@)';
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
          args: ['rebase', '-s', rootExpr, '-o', 'trunk()', '--skip-emptied'],
          command: `jj rebase -s '${rootExpr}' -o 'trunk()' --skip-emptied`,
          dryRunnable: true,
          invariant: 'Changes whose diffs already landed become empty and collapse.',
        },
        {
          title: 'Confirm the resting state',
          args: null,
          command: "jj log -r 'mutable()'",
          dryRunnable: false,
          invariant: 'Once everything landed, a single empty @ sits directly atop trunk().',
        },
      ],
    };
  },

  /**
   * Forge-aware publishing command.
   */
  publishCommand(forge, changeId) {
    return (FORGE_ADAPTERS[forge] ?? FORGE_ADAPTERS['github-bookmarks']).publish(changeId);
  },
};

/**
 * End-to-end SDLC graph lifecycle: the graph state and discipline of each
 * phase, with the recipes (by id) that serve it.
 */
export const SDLC_LIFECYCLE = Object.freeze([
  { phase: 1, name: 'Discovery / Spike', discipline: 'Work anonymously and freely in @; ignore commit hygiene while exploring the design space.', recipes: ['squash-workflow'] },
  { phase: 2, name: 'Safety Net', discipline: 'Before modifying untested legacy code, insert characterization tests below active work (jj new -B).', recipes: ['characterization-tests'] },
  { phase: 3, name: 'Structural Prep (Tidy / Expand)', discipline: 'Extract prerequisite refactors, interface seams, or backward-compatible schema expansions beneath behavioral work.', recipes: ['tidy-first', 'expand-contract', 'branch-by-abstraction'] },
  { phase: 4, name: 'Behavioral Implementation', discipline: 'Build cohesive vertical slices with bundled tests: parallel siblings when independent, shallow causal stacks when strictly ordered.', recipes: ['tdd-red-test', 'edit-workflow', 'squash-workflow'] },
  { phase: 5, name: 'Integration & Verification', discipline: 'Compose arms in a megamerge, route fixups with jj absorb, format with jj fix, and verify every publishable node is green.', recipes: ['local-megamerge', 'absorb-fixups', 'extract-shared-primitive', 'resolve-conflict', 'stack-validation'] },
  { phase: 6, name: 'Activation & Cleanup (Contract)', discipline: 'Publish layer by layer as each becomes self-contained, flip flags in an isolated change, then contract and converge.', recipes: ['isolate-activation', 'expand-contract', 'post-merge-convergence'] },
]);

/**
 * Dual Time-Axis Recovery Planner.
 * Prefers surgical single-change `evolog` restore over repo-wide `op restore`
 * whenever sibling arms have independent work worth preserving. An earlier
 * version is named by its hidden commit id or by an offset (`<change>/1`).
 *
 * @param {{
 *   scope: 'single-change' | 'repo-wide' | 'undo',
 *   targetOpId?: string,
 *   targetChangeId?: string,
 *   targetEvologCommit?: string,
 *   targetEvologOffset?: number,
 * }} params
 */
export function planTimeTravelRecovery(params) {
  const version = params.targetEvologCommit
    ? { full: params.targetEvologCommit, shown: short(params.targetEvologCommit) }
    : Number.isInteger(params.targetEvologOffset) && params.targetEvologOffset > 0 && params.targetChangeId
      ? { full: `${params.targetChangeId}/${params.targetEvologOffset}`, shown: `${short(params.targetChangeId)}/${params.targetEvologOffset}` }
      : null;
  if (params.scope === 'single-change' && params.targetChangeId && version) {
    return {
      axis: 'evolog',
      args: ['restore', '--from', version.full, '--to', params.targetChangeId],
      command: `jj restore --from ${version.shown} --to ${short(params.targetChangeId)}`,
      explanation: `Restores only change ${short(params.targetChangeId)} to snapshot ${version.shown} without disturbing sibling arms or repo bookmarks.`,
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
 * to its current topology (clean conflict resolution, megamerge composition or
 * fixup routing, Tidy First?, characterization tests, stack validation, and
 * convergence).
 */
export function suggestPatternsForGraph(graph) {
  const recipes = [];
  const roots = graph.mutableRoots().filter((r) => !graph.isScratchpad(r));
  const wc = graph.workingCopy();
  const megamerge = graph.mutable().find((c) => graph.isMegamerge(c));

  const conflicted = graph
    .conflicted()
    .find((c) => c.zone === 'mutable' && !(c.parents ?? []).some((p) => graph.get(p)?.currentCommit.conflict?.isConflicted));
  if (conflicted) {
    recipes.push(JjrPatterns.resolveConflictCleanly(conflicted.changeId));
  }

  if (megamerge) {
    recipes.push(JjrPatterns.absorbFixups(megamerge.currentCommit.isEmpty ? null : megamerge.changeId));
  } else if (roots.length >= 2) {
    recipes.push(JjrPatterns.localMegamerge(roots.slice(0, 4).map((r) => r.changeId)));
  }

  const activeBehavioral =
    (wc && wc.intent === 'behavioral' ? wc : null) ??
    graph.mutable().find((c) => c.intent === 'behavioral');
  if (activeBehavioral) {
    recipes.push(JjrPatterns.tidyFirstBelow(activeBehavioral.changeId, 'prep seam before feature'));
  }

  const structural = graph.mutable().find((c) => c.intent === 'structural');
  if (structural && !graph.mutableAncestorsOf(structural.changeId).some((a) => a.intent === 'test-harness')) {
    recipes.push(JjrPatterns.characterizationTestsBelow(structural.changeId, 'current behavior'));
  }

  if (graph.mutable().some((c) => !graph.isScratchpad(c))) {
    recipes.push(JjrPatterns.stackValidation());
  }

  if (graph.mutable().length > 0) {
    recipes.push(JjrPatterns.postMergeConvergence(roots.length > 1));
  }

  return recipes;
}
