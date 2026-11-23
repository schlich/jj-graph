/**
 * Render-agnostic UI Component ViewModels for jjr.
 *
 * Every component computes pure, deterministic state from a JjrGraph,
 * GuardrailPipeline, Jev triage payload, or Narrator suggestion. Port 1:1
 * to TUI (`jjr/ui/tui.mjs`) or GUI (`jjr/ui/gui.mjs`) with zero duplicated
 * version-control logic.
 */

import { verificationState } from '../types.mjs';

export function buildDagGraphViewModel(graph, selectedChangeId = null) {
  const all = graph.all();
  const depthMap = new Map();

  const computeDepth = (id, visiting = new Set()) => {
    if (depthMap.has(id)) return depthMap.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = graph.get(id);
    if (!node || node.zone === 'immutable' || (node.parents?.length ?? 0) === 0) {
      depthMap.set(id, 0);
      return 0;
    }
    const maxParent = Math.max(...node.parents.map((p) => computeDepth(p, visiting)));
    const d = maxParent + 1;
    depthMap.set(id, d);
    return d;
  };

  for (const c of all) computeDepth(c.changeId);

  const nodes = all
    .slice()
    .sort((a, b) => (depthMap.get(b.changeId) ?? 0) - (depthMap.get(a.changeId) ?? 0))
    .map((c) => {
      const isMegamerge = graph.isMegamerge(c);
      let glyph = '○';
      if (c.isWorkingCopy) glyph = '@';
      else if (c.currentCommit.conflict?.isConflicted) glyph = '×';
      else if (c.zone === 'immutable') glyph = '◆';
      else if (c.intent === 'blueprint') glyph = '◇';

      return {
        changeId: c.changeId,
        shortChangeId: c.changeId.slice(0, 8),
        shortCommitId: c.currentCommit.commitId.slice(0, 8),
        title: (c.currentCommit.description ?? '').split('\n')[0] || '(no description)',
        zone: c.zone,
        glyph,
        intent: c.intent,
        bookmarks: c.bookmarks ?? [],
        isConflicted: Boolean(c.currentCommit.conflict?.isConflicted),
        isDivergent: Boolean(c.isDivergent),
        isMegamerge,
        isEmpty: Boolean(c.currentCommit.isEmpty),
        verification: verificationState(c.verification),
        isVerifiedGreen: verificationState(c.verification) === 'green',
        depth: depthMap.get(c.changeId) ?? 0,
        parentIds: c.parents ?? [],
      };
    });

  return {
    nodes,
    diagnostics: graph.diagnose(),
    summary: graph.summary(),
    selectedChangeId,
  };
}

export function buildGuardrailBanner(decisions) {
  const blockers = decisions.filter((d) => !d.allowed && d.severity === 'block');
  const warnings = decisions.filter((d) => d.severity === 'warn');

  if (blockers.length > 0) {
    return {
      status: 'blocked',
      headline: `Blocked by ${blockers.length} guardrail(s)`,
      items: blockers,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warning',
      headline: `${warnings.length} guardrail warning(s)`,
      items: warnings,
    };
  }
  return {
    status: 'clear',
    headline: 'All guardrails passed',
    items: [],
  };
}

export function buildDependencyGate({ baseLabel, childLabel, verdict, source = 'deterministic' }) {
  return {
    baseLabel,
    childLabel,
    verdict,
    source,
    causalProbability: verdict.causalProbability ?? null,
    reviewabilityProbability: verdict.reviewabilityProbability ?? null,
  };
}

export function buildTriageCard(changeId, triageResult) {
  const { answers, source, model } = triageResult;
  return {
    changeId,
    shortChangeId: changeId.slice(0, 8),
    source,
    model,
    intent: answers.intent.choice,
    intentConfidence: answers.intent.confidence,
    entangledProbability: answers.entangled.noul,
    publishReadiness: answers.publishReadiness.legend,
    publishScore: answers.publishReadiness.score,
    publishConfidence: answers.publishReadiness.confidence,
    hasDebugOrSecretsProbability: answers.hasDebugOrSecrets.noul,
    apiWithoutConsumerProbability: answers.apiWithoutConsumer?.noul ?? null,
  };
}

/**
 * Pre-flight panel: where trunk() and the immutable boundary resolve, and
 * which repository conditions need attention.
 */
export function buildPreflightPanel(preflight, diagnostics = []) {
  if (!preflight) {
    return { status: 'unknown', trunk: null, immutableHeads: [], colocated: null, issues: [] };
  }
  const trunk = preflight.trunk?.resolved
    ? {
        label: preflight.trunk.isRoot ? 'root()' : preflight.trunk.changeId.slice(0, 8),
        isRoot: Boolean(preflight.trunk.isRoot),
        immutable: Boolean(preflight.trunk.immutable),
      }
    : null;
  const issues = diagnostics.filter((d) => /^(PREFLIGHT_|GIT_COMPAT|GC_RECOMMENDED)/.test(d.code));
  const status = issues.some((d) => d.severity === 'error')
    ? 'blocked'
    : issues.some((d) => d.severity === 'warning')
      ? 'attention'
      : 'clean';
  return {
    status,
    trunk,
    immutableHeads: (preflight.immutableHeads?.heads ?? []).map((h) => h.changeId.slice(0, 8)),
    colocated: preflight.colocated ?? null,
    mergeSameChange: preflight.mergeSameChange ?? null,
    issues: issues.map((d) => ({ severity: d.severity, code: d.code, message: d.message, command: d.suggestedCommand ?? null })),
  };
}

/**
 * Layered publish plan: which layers of a stack can be published now.
 */
export function buildPublishPlan(plan) {
  return {
    forge: plan.forge,
    forgeName: plan.adapter?.name ?? plan.forge,
    caveats: plan.adapter?.caveats ?? [],
    rows: plan.layers.map((l) => ({
      changeId: l.changeId.slice(0, 8),
      title: l.title,
      publishable: l.publishable,
      reasons: l.reasons,
      warnings: l.warnings ?? [],
      command: l.command,
    })),
    commands: plan.commands,
    publishCount: plan.publish.length,
    keepLocalCount: plan.keepLocal.length,
  };
}

export function buildTimeTravelScrubber({ axis, entries, activeIndex, plan }) {
  return {
    axis,
    entries,
    activeIndex,
    previewCommand: plan.command,
    explanation: plan.explanation,
    blastRadius: plan.blastRadius,
  };
}

export function buildNamingAssistant(suggestion, accepted = false) {
  return { suggestion, accepted };
}
