/**
 * Portable GUI Adapter (Web / React / Electron / Tauri / jj-graph compatible).
 *
 * Translates `jjr/ui/core.mjs` ViewModels into semantic state tokens (never
 * branch-lane colors) so any GUI toolkit can bind directly without duplicating
 * version-control logic.
 */

export function toGuiDagRows(vm) {
  return vm.nodes.map((node) => {
    const badges = [];
    if (node.zone === 'immutable') badges.push({ label: 'immutable()', tone: 'muted' });
    if (node.isMegamerge) badges.push({ label: 'local megamerge', tone: 'dry' });
    if (node.isDivergent) badges.push({ label: 'divergent()', tone: 'danger' });
    if (node.isConflicted) badges.push({ label: 'conflict', tone: 'danger' });
    if (node.isEmpty && node.intent === 'blueprint') badges.push({ label: 'blueprint', tone: 'past' });
    if (node.isVerifiedGreen && node.zone === 'mutable') badges.push({ label: 'green', tone: 'accent' });
    for (const bm of node.bookmarks) {
      badges.push({ label: bm, tone: 'neutral' });
    }

    return {
      key: node.changeId,
      glyph: node.glyph,
      changeId: node.shortChangeId,
      commitId: node.shortCommitId,
      title: node.title,
      intent: node.intent,
      zone: node.zone,
      indentLevel: node.depth,
      badges,
      selected: vm.selectedChangeId === node.changeId,
    };
  });
}

export function toGuiAlertProps(vm) {
  return {
    tone: vm.status === 'blocked' ? 'danger' : vm.status === 'warning' ? 'dry' : 'accent',
    title: vm.headline,
    items: vm.items.map((i) => ({
      rule: i.ruleName,
      message: i.message,
      remediationCommand: i.remediation ?? null,
    })),
  };
}

export function toGuiDependencyCard(vm) {
  return {
    base: vm.baseLabel,
    child: vm.childLabel,
    outcome: vm.verdict.outcome,
    tone:
      vm.verdict.outcome === 'stack'
        ? 'accent'
        : vm.verdict.outcome === 'confirm'
          ? 'past'
          : 'dry',
    causalProbability: vm.causalProbability,
    reviewabilityProbability: vm.reviewabilityProbability,
    reason: vm.verdict.reason,
    suggestedCommand: vm.verdict.suggestedCommand ?? null,
    suggestedArgs: vm.verdict.suggestedArgs ?? null,
  };
}

export function toGuiTriageProps(vm) {
  return {
    changeId: vm.shortChangeId,
    source: vm.source,
    intent: { label: vm.intent, confidence: vm.intentConfidence },
    entangled: {
      probability: vm.entangledProbability,
      tone: vm.entangledProbability >= 0.72 ? 'dry' : 'accent',
    },
    readiness: {
      label: vm.publishReadiness,
      score: vm.publishScore,
      confidence: vm.publishConfidence,
      tone: vm.publishScore >= 2 ? 'accent' : vm.publishScore >= 1 ? 'dry' : 'danger',
    },
    debugRisk: {
      probability: vm.hasDebugOrSecretsProbability,
      tone: vm.hasDebugOrSecretsProbability >= 0.65 ? 'danger' : 'muted',
    },
  };
}

export function toGuiTimeTravelProps(vm) {
  return {
    axis: vm.axis,
    blastRadius: vm.blastRadius,
    tone: vm.axis === 'evolog' ? 'accent' : 'past',
    previewCommand: vm.previewCommand,
    explanation: vm.explanation,
  };
}
