/**
 * Render-agnostic UI Component ViewModels for jjr.
 *
 * Every component computes pure, deterministic state from a JjrGraph,
 * GuardrailPipeline, Jev triage payload, or Narrator suggestion. Port 1:1
 * to TUI (`jjr/ui/tui.mjs`) or GUI (`jjr/ui/gui.mjs`) with zero duplicated
 * version-control logic.
 */

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
        isVerifiedGreen: Boolean(
          c.verification?.formatted && c.verification?.builds && c.verification?.testsPass,
        ),
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
