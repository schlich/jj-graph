/**
 * Branded identity-state primitives for jjr.
 *
 * Enforces Jujutsu's separation between logical identity and immutable snapshot:
 * - ChangeId: 16-byte reverse-hex (k-z) logical identity that survives rewrites.
 * - CommitId: 20-byte hex (0-9a-f) immutable filesystem snapshot SHA.
 * - OpId: hex operation log snapshot ID for repository-wide time travel.
 * - BookmarkName: non-empty whitespace-free bookmark label.
 */

const REVERSE_HEX_RE = /^[k-z]{8,32}$/;
const HEX_SHA_RE = /^[0-9a-f]{8,40}$/;
const OP_ID_RE = /^[0-9a-f]{8,128}$/;

export class JjrTypeError extends Error {
  /**
   * @param {string} message
   * @param {'ChangeId' | 'CommitId' | 'OpId' | 'BookmarkName'} expectedKind
   * @param {string} received
   */
  constructor(message, expectedKind, received) {
    super(message);
    this.name = 'JjrTypeError';
    this.expectedKind = expectedKind;
    this.received = received;
  }
}

/**
 * Validate and brand a Jujutsu ChangeId (reverse-hex k-z).
 * @param {string} raw
 * @returns {string}
 */
export function asChangeId(raw) {
  if (typeof raw !== 'string') {
    throw new JjrTypeError(`Invalid ChangeId (${typeof raw}). Expected reverse-hex string (k-z).`, 'ChangeId', String(raw));
  }
  const normalized = raw.trim().toLowerCase();
  if (!REVERSE_HEX_RE.test(normalized)) {
    const looksLikeCommit = HEX_SHA_RE.test(normalized);
    const hint = looksLikeCommit
      ? ' That looks like a hex CommitId (0-9a-f); never pass an ephemeral CommitId where a stable ChangeId is required.'
      : '';
    throw new JjrTypeError(
      `Invalid ChangeId "${raw}". Expected jj reverse-hex (characters k-z, 8-32 chars).${hint}`,
      'ChangeId',
      raw,
    );
  }
  return normalized;
}

/**
 * Validate and brand an immutable CommitId (hex 0-9a-f).
 * @param {string} raw
 * @returns {string}
 */
export function asCommitId(raw) {
  if (typeof raw !== 'string') {
    throw new JjrTypeError(`Invalid CommitId (${typeof raw}). Expected hex SHA (0-9a-f).`, 'CommitId', String(raw));
  }
  const normalized = raw.trim().toLowerCase();
  if (!HEX_SHA_RE.test(normalized)) {
    const looksLikeChange = REVERSE_HEX_RE.test(normalized);
    const hint = looksLikeChange
      ? ' That looks like a reverse-hex ChangeId (k-z); resolve it to a concrete snapshot CommitId first.'
      : '';
    throw new JjrTypeError(
      `Invalid CommitId "${raw}". Expected hex SHA (0-9a-f, 8-40 chars).${hint}`,
      'CommitId',
      raw,
    );
  }
  return normalized;
}

/**
 * Validate and brand a Jujutsu operation ID.
 * @param {string} raw
 * @returns {string}
 */
export function asOpId(raw) {
  if (typeof raw !== 'string') {
    throw new JjrTypeError(`Invalid OpId (${typeof raw}). Expected hex operation ID.`, 'OpId', String(raw));
  }
  const normalized = raw.trim().toLowerCase();
  if (!OP_ID_RE.test(normalized)) {
    throw new JjrTypeError(`Invalid OpId "${raw}". Expected hex operation ID (8-128 hex chars).`, 'OpId', raw);
  }
  return normalized;
}

/**
 * Validate and brand a Jujutsu bookmark name.
 * @param {string} raw
 * @returns {string}
 */
export function asBookmark(raw) {
  if (typeof raw !== 'string') {
    throw new JjrTypeError(`Invalid BookmarkName (${typeof raw}).`, 'BookmarkName', String(raw));
  }
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new JjrTypeError(`Invalid BookmarkName "${raw}". Bookmarks must be non-empty and contain no whitespace.`, 'BookmarkName', raw);
  }
  return trimmed;
}

export function isChangeId(raw) {
  return typeof raw === 'string' && REVERSE_HEX_RE.test(raw.trim().toLowerCase());
}

export function isCommitId(raw) {
  return typeof raw === 'string' && HEX_SHA_RE.test(raw.trim().toLowerCase());
}

export function isOpId(raw) {
  return typeof raw === 'string' && OP_ID_RE.test(raw.trim().toLowerCase());
}

export function formatShortId(id, len = 8) {
  return String(id).slice(0, len);
}

/** @type {readonly string[]} */
export const CHANGE_INTENT_KINDS = Object.freeze([
  'structural',   // Tidy First? pure refactor (rename, extract, guard clause)
  'behavioral',   // Feature or bugfix with bundled tests
  'test-harness', // Characterization tests or test-infrastructure change
  'activation',   // Small top-level flag, route, or config flip
  'blueprint',    // Intentional empty stub pre-describing a planned stack
  'megamerge',    // Local-only octopus composition (never push)
  'working-copy', // Ephemeral @ scratchpad
]);

/**
 * Default repository configuration for jjr.
 *
 * `immutableHeadsRevset` mirrors jj's `builtin_immutable_heads()`.
 * `maxStackDepth` is how long a linear chain of mutable changes may grow
 * before jjr suggests checking its edges with the Two-Part Dependency Test.
 */
export const DEFAULT_REPO_CONFIG = Object.freeze({
  trunkRevset: 'trunk()',
  immutableHeadsRevset: 'trunk() | tags() | untracked_remote_bookmarks() | untracked_remote_tags()',
  colocated: true,
  mergeSameChange: 'keep',
  megamergePrefix: 'local:',
  forge: 'github-bookmarks',
  maxStackDepth: 6,
});

/**
 * The canonical DAG shapes of the reference, keyed by the shape
 * `JjrGraph.classifyShape()` reports for the mutable zone.
 */
export const CANONICAL_SHAPES = Object.freeze({
  resting: Object.freeze({
    scenario: 'All work landed',
    dag: 'A single empty @ directly atop trunk()',
    primitives: ['jj git fetch', "jj rebase -s 'roots(trunk()..@)' -o trunk()"],
    publishing: 'Nothing to publish.',
  }),
  single: Object.freeze({
    scenario: 'Isolated fix or cohesive feature',
    dag: 'Single change rooted at trunk()',
    primitives: ['jj new trunk()'],
    publishing: 'Attach one bookmark or run `jj git push -c @-` when ready.',
  }),
  stack: Object.freeze({
    scenario: 'Multi-layer feature with real dependencies',
    dag: 'Shallow linear stack (trunk() <- A <- B <- C), ordered bottom-up by stability and merge order',
    primitives: ['jj new', 'jj new -B / -A', 'jj rebase -r X -B Y'],
    publishing: 'Publish bottom layer(s) once independently reviewable; keep draft top layers local.',
  }),
  parallel: Object.freeze({
    scenario: 'Unrelated concurrent tasks / context switch',
    dag: 'Parallel sibling arms off trunk()',
    primitives: ['jj new trunk()', 'jj parallelize', 'jj split --parallel'],
    publishing: 'Independent bookmarks / PRs that can land in any order.',
  }),
  megamerge: Object.freeze({
    scenario: 'Simultaneous multi-branch development and full-app testing',
    dag: 'Parallel arms joined by a local-only octopus megamerge + empty @',
    primitives: ['jj new a b c -m "local: dev megamerge"', 'jj absorb', 'jj squash --into'],
    publishing: 'Never push the megamerge; push only the underlying feature arms.',
  }),
  branching: Object.freeze({
    scenario: 'Not canonical: a stack that forks',
    dag: 'One root whose descendants fork into several heads',
    primitives: ['jj parallelize', 'jj rebase -s X -o trunk()'],
    publishing: 'Run the Two-Part Dependency Test on each fork; independent heads belong off trunk().',
  }),
});

/**
 * Whether a verification record proves a revision green (formatted, builds,
 * tests pass), proves it red, or proves nothing yet.
 *
 * @param {{ formatted?: boolean | null, builds?: boolean | null, testsPass?: boolean | null, verified?: boolean } | null | undefined} v
 * @returns {'green' | 'red' | 'unknown'}
 */
export function verificationState(v) {
  if (!v) return 'unknown';
  const checks = [v.formatted, v.builds, v.testsPass];
  if (checks.some((c) => c === false)) return 'red';
  if (v.verified !== false && checks.every((c) => c === true)) return 'green';
  return 'unknown';
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|specs?|testdata|fixtures)\/|[._-](test|spec)s?\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|exs?)$/i;
const CODE_PATH_RE = /\.(m?[jt]sx?|cjs|cts|py|rb|go|rs|java|kts?|scala|swift|c|cc|cpp|cxx|h|hh|hpp|cs|php|exs?|erl|hs|ml|clj|lua|dart|zig|nim|vue|svelte)$/i;

/** Whether a repository path holds tests or test fixtures. */
export function isTestPath(p) {
  return TEST_PATH_RE.test(String(p));
}

/** Whether a repository path holds program code (as opposed to docs or config). */
export function isCodePath(p) {
  return CODE_PATH_RE.test(String(p));
}

/**
 * Lightweight deterministic fallback for inferring a change's intent from its
 * description, emptiness, parent count, and touched paths when Jev is offline.
 *
 * @param {{
 *   description?: string,
 *   isEmpty?: boolean,
 *   isWorkingCopy?: boolean,
 *   mutableParentCount?: number,
 *   touchedPaths?: readonly string[],
 *   megamergePrefix?: string,
 * }} info
 * @returns {string}
 */
export function inferIntentFallback(info) {
  const desc = (info.description ?? '').trim();
  const lower = desc.toLowerCase();
  const prefix = (info.megamergePrefix ?? 'local:').toLowerCase();

  if (lower.startsWith(prefix) || lower.includes('megamerge') || (info.mutableParentCount ?? 0) >= 2) {
    return 'megamerge';
  }
  if (info.isWorkingCopy && info.isEmpty && !desc) {
    return 'working-copy';
  }
  if (info.isEmpty && desc && !info.isWorkingCopy) {
    return 'blueprint';
  }
  const paths = info.touchedPaths ?? [];
  if (paths.length > 0 && paths.every(isTestPath)) {
    return 'test-harness';
  }
  if (/^(refactor|style|tidy|chore)(\(|:|!|\s)/i.test(desc)) {
    return 'structural';
  }
  if (/^(test|tests)(\(|:|!|\s)/i.test(desc)) {
    return 'test-harness';
  }
  if (/^(enable|activate|flip|wire|rollout)\b/i.test(desc) || /\b(feature[_ -]?flag|activation)\b/i.test(lower)) {
    return 'activation';
  }
  if (info.isWorkingCopy && !desc) {
    return 'working-copy';
  }
  return 'behavioral';
}
