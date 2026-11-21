/**
 * Portable TUI Adapter (ANSI / Ink / Bubbletea / Ratatui compatible).
 *
 * Renders pure `jjr/ui/core.mjs` ViewModels into crisp terminal strings
 * and exposes a standard keybinding map.
 */

export const TUI_KEYBINDINGS = Object.freeze({
  navigateUp: 'k / ↑',
  navigateDown: 'j / ↓',
  toggleTimeAxis: 't',
  runDependencyGate: 'd',
  runJevTriage: 'v',
  suggestName: 'n',
  squashDown: 's',
  parallelize: 'p',
  applyDryRun: 'a',
  undoOp: 'u',
});

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(useColor, code, text) {
  return useColor ? `${code}${text}${ANSI.reset}` : text;
}

export function renderDagTui(vm, useColor = true) {
  const c = (code, text) => paint(useColor, code, text);
  const lines = [];
  lines.push(c(ANSI.bold, '┌─ JJR REVISION GRAPH ────────────────────────────────────────┐'));
  for (const node of vm.nodes) {
    const indent = '  '.repeat(Math.min(node.depth, 4));
    const glyphColor =
      node.glyph === '@'
        ? ANSI.green
        : node.glyph === '×'
          ? ANSI.red
          : node.zone === 'immutable'
            ? ANSI.dim
            : ANSI.cyan;
    const idStr = c(ANSI.magenta, node.shortChangeId);
    const shaStr = c(ANSI.dim, node.shortCommitId);
    const zoneTag = node.zone === 'immutable' ? c(ANSI.dim, ' [immutable]') : '';
    const bmTag = node.bookmarks.length ? c(ANSI.blue, ` (${node.bookmarks.join(', ')})`) : '';
    const statusTag = node.isDivergent
      ? c(ANSI.red, ' [divergent]')
      : node.isMegamerge
        ? c(ANSI.yellow, ' [local:megamerge]')
        : node.isConflicted
          ? c(ANSI.red, ' [conflict]')
          : node.isVerifiedGreen && node.zone === 'mutable'
            ? c(ANSI.green, ' ✓')
            : '';

    const pointer = vm.selectedChangeId === node.changeId ? c(ANSI.yellow, '▸ ') : '  ';
    lines.push(`${pointer}${indent}${c(glyphColor, node.glyph)} ${idStr} ${shaStr} ${node.title}${bmTag}${statusTag}${zoneTag}`);
  }
  lines.push(c(ANSI.bold, '└──────────────────────────────────────────────────────────────┘'));
  return lines.join('\n');
}

export function renderGuardrailBannerTui(vm, useColor = false) {
  const c = (code, text) => paint(useColor, code, text);
  if (vm.status === 'clear') {
    return c(ANSI.green, `✓ [GUARDRAILS] ${vm.headline}`);
  }
  const icon = vm.status === 'blocked' ? c(ANSI.red, '✖') : c(ANSI.yellow, '▲');
  const body = vm.items
    .map(
      (item) =>
        `  • [${item.ruleName}] ${item.message}${item.remediation ? `\n    Fix: ${item.remediation}` : ''}`,
    )
    .join('\n');
  return `${icon} [GUARDRAILS] ${vm.headline}\n${body}`;
}

export function renderDependencyGateTui(vm) {
  const probs =
    vm.causalProbability != null && vm.reviewabilityProbability != null
      ? `│ Jev p:   causal=${vm.causalProbability.toFixed(2)}, reviewable=${vm.reviewabilityProbability.toFixed(2)} (${vm.source})`
      : null;

  return [
    '┌─ TWO-PART DEPENDENCY GATE ─────────────────────────┐',
    `│ Base:    ${vm.baseLabel}`,
    `│ Child:   ${vm.childLabel}`,
    `│ Verdict: ${vm.verdict.outcome.toUpperCase()}`,
    ...(probs ? [probs] : []),
    `│ Reason:  ${vm.verdict.reason}`,
    vm.verdict.suggestedCommand
      ? `│ Command: ${vm.verdict.suggestedCommand}`
      : `│ Status:  ${vm.verdict.outcome === 'confirm' ? 'Awaiting confirmation' : 'Valid causal stack'}`,
    '└────────────────────────────────────────────────────┘',
  ].join('\n');
}

export function renderTriageTui(vm) {
  return [
    `┌─ JEV CHANGE TRIAGE (${vm.shortChangeId}) ───────────────────┐`,
    `│ Source:     ${vm.source} (${vm.model})`,
    `│ Intent:     ${vm.intent} (confidence ${vm.intentConfidence.toFixed(2)})`,
    `│ Entangled:  p=${vm.entangledProbability.toFixed(2)}${vm.entangledProbability >= 0.72 ? ' [split recommended]' : ''}`,
    `│ Readiness:  ${vm.publishReadiness} (score ${vm.publishScore.toFixed(2)}, conf ${vm.publishConfidence.toFixed(2)})`,
    `│ Debug/Keys: p=${vm.hasDebugOrSecretsProbability.toFixed(2)}`,
    '└────────────────────────────────────────────────────┘',
  ].join('\n');
}

export function renderNamingAssistantTui(vm) {
  return [
    `✦ Naming Suggestion (${vm.suggestion.detectedIntent}, conf ${vm.suggestion.intentConfidence.toFixed(2)})`,
    `  Title:    ${vm.suggestion.conventionalTitle}`,
    `  Bookmark: ${vm.suggestion.bookmarkSlug || '(none — local only)'}`,
    `  Why:      ${vm.suggestion.rationale}`,
  ].join('\n');
}

export function renderTimeTravelTui(vm) {
  return [
    `┌─ TIME-TRAVEL RECOVERY (${vm.axis}) ────────────────────┐`,
    `│ Scope:   ${vm.blastRadius}`,
    `│ Command: ${vm.previewCommand}`,
    `│ Why:     ${vm.explanation}`,
    '└────────────────────────────────────────────────────┘',
  ].join('\n');
}
