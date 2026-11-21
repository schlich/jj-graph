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
 */
export const DEFAULT_REPO_CONFIG = Object.freeze({
  trunkRevset: 'trunk()',
  immutableHeadsRevset: 'trunk() | tags() | untracked_remote_bookmarks()',
  colocated: true,
  mergeSameChange: 'keep',
  megamergePrefix: 'local:',
  forge: 'github-bookmarks',
});

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
  if (paths.length > 0 && paths.every((p) => /\.(test|spec)\.|__tests__|\/tests?\//i.test(p))) {
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
