/**
 * TypeSafe AI Jev ("System One") Decision Model integration for jjr.
 *
 * Jev is a non-autoregressive decision model served via `POST /v1/systemone`
 * (compatible with `@typesafe-ai/sdk`, OpenRouter Decisions API, Liquid AI,
 * GreenPT, and Mouse). Instead of generating prose token-by-token, a single
 * call evaluates a shared `state` against multiple typed questions in parallel
 * and returns calibrated probabilities and confidence scores:
 *
 * - `choice(instructions, criteria)` -> `{ choice, probabilities, confidence }`
 * - `score(instructions, criteria)`  -> `{ score, legend, probabilities, confidence }`
 * - `noul(instructions, criteria?)`  -> `{ noul }` (calibrated probability 0..1)
 *
 * jjr uses Jev both visibly (change triage, Two-Part Dependency Gate,
 * publish readiness meter) and behind the scenes (scratchpad detection,
 * blast-radius dry-run routing, surgical evolog vs op-log recovery, and
 * ambiguous hunk routing for `jj absorb`).
 */

import { JjrGraph } from './graph.mjs';
import { inferIntentFallback } from './types.mjs';

// ---------------------------------------------------------------------------
// Question primitive builders (1:1 wire format with @typesafe-ai/sdk)
// ---------------------------------------------------------------------------

/**
 * Unordered closed-set selection (up to 255 options).
 * @param {string} instructions
 * @param {Record<string, string | null>} criteria
 */
export function choice(instructions, criteria) {
  return Object.freeze({ type: 'choice', instructions, criteria });
}

/**
 * Ordered rubric spectrum (2-10 levels).
 * @param {string} instructions
 * @param {readonly string[]} criteria
 */
export function score(instructions, criteria) {
  return Object.freeze({ type: 'score', instructions, criteria: [...criteria] });
}

/**
 * Boolean proposition returning calibrated probability in [0, 1].
 * @param {string} instructions
 * @param {{ true?: string, false?: string }} [criteria]
 */
export function noul(instructions, criteria) {
  return Object.freeze(
    criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions },
  );
}

// ---------------------------------------------------------------------------
// Wire-compatible System One client (zero dependencies, Node 20+ native fetch)
// ---------------------------------------------------------------------------

/**
 * Minimal, wire-compatible client for `POST /v1/systemone`.
 * Also accepts an existing `@typesafe-ai/sdk` `TypeSafeClient` instance via
 * `{ sdkClient }` so teams already using the official SDK can pass it directly.
 */
export class JevClient {
  /**
   * @param {{
   *   apiKey?: string,
   *   baseURL?: string,
   *   defaultModel?: string,
   *   sdkClient?: { systemOne: Function },
   *   fetchImpl?: typeof fetch,
   *   timeoutMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.baseURL = (options.baseURL ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
    this.defaultModel = options.defaultModel ?? process.env.TYPESAFE_JEV_MODEL ?? 'jev-latest';
    this.sdkClient = options.sdkClient ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  get isConfigured() {
    return Boolean(this.sdkClient || this.apiKey);
  }

  /**
   * Execute a System One decision batch.
   *
   * @param {{
   *   model?: string,
   *   state: unknown,
   *   questions: Record<string, { type: 'choice' | 'score' | 'noul', instructions: string, criteria?: any }>,
   * }} request
   */
  async systemOne(request) {
    if (this.sdkClient) {
      return this.sdkClient.systemOne({
        model: request.model ?? this.defaultModel,
        state: request.state,
        questions: request.questions,
      });
    }

    if (!this.apiKey) {
      throw new Error('JevClient has no apiKey (set TYPESAFE_API_KEY or pass { apiKey, sdkClient }).');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseURL}/v1/systemone`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? this.defaultModel,
          state: request.state,
          questions: request.questions,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Jev System One request failed (${res.status}): ${text.slice(0, 240)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// JjrJevAssistant: creative user-facing & behind-the-scenes System-One workflows
// ---------------------------------------------------------------------------

/**
 * Clamp and round a calibrated probability.
 */
function prob(v) {
  return Math.round(Math.max(0.01, Math.min(0.99, v)) * 100) / 100;
}

function normalizeDist(rawMap) {
  const entries = Object.entries(rawMap);
  const sum = entries.reduce((acc, [, v]) => acc + v, 0) || 1;
  const out = {};
  let bestKey = entries[0]?.[0] ?? '';
  let bestVal = -1;
  for (const [k, v] of entries) {
    const p = Math.round((v / sum) * 1000) / 1000;
    out[k] = p;
    if (p > bestVal) {
      bestVal = p;
      bestKey = k;
    }
  }
  return { choice: bestKey, probabilities: out, confidence: bestVal };
}

/**
 * High-level System One decision engine for jjr.
 * Uses live TypeSafe Jev when configured, and falls back seamlessly to a
 * calibrated local heuristic scorer when offline or unauthenticated.
 */
export class JjrJevAssistant {
  /**
   * @param {JevClient | null} [client]
   */
  constructor(client = new JevClient()) {
    this.client = client;
  }

  get mode() {
    return this.client?.isConfigured ? 'live-jev' : 'calibrated-offline';
  }

  /**
   * 1. Single-Pass Change Triage (4 parallel questions in 1 System One call):
   *    - `intent` (`choice`): structural / behavioral / test-harness / activation / blueprint / megamerge / working-copy
   *    - `entangled` (`noul`): mixes structural refactoring with behavioral edits?
   *    - `publishReadiness` (`score`): scratchpad -> needs-cleanup -> reviewable -> ready-to-land
   *    - `hasDebugOrSecrets` (`noul`): contains debug prints, TODO hacks, or secret-like literals?
   *
   * @param {{
   *   changeId: string,
   *   description?: string,
   *   touchedPaths?: readonly string[],
   *   diffExcerpt?: string,
   *   isEmpty?: boolean,
   *   isWorkingCopy?: boolean,
   *   mutableParentCount?: number,
   *   isConflicted?: boolean,
   * }} input
   */
  async triageChange(input) {
    const state = {
      change_id: input.changeId,
      description: input.description ?? '',
      touched_paths: input.touchedPaths ?? [],
      diff_excerpt: (input.diffExcerpt ?? '').slice(0, 6000),
      is_empty: Boolean(input.isEmpty),
      is_working_copy: Boolean(input.isWorkingCopy),
      mutable_parent_count: input.mutableParentCount ?? 1,
      is_conflicted: Boolean(input.isConflicted),
    };

    const questions = {
      intent: choice('Classify the primary VCS intent of this Jujutsu change.', {
        structural: 'Zero-behavior-change refactoring, renaming, extraction, or formatting (Tidy First?)',
        behavioral: 'New feature, bug fix, or behavior change (with or without bundled tests)',
        'test-harness': 'Only test files, fixtures, or characterization test infrastructure',
        activation: 'Small wiring change flipping a feature flag, route, or config switch',
        blueprint: 'Intentional empty change whose description outlines a planned future step',
        megamerge: 'Local integration merge combining 2+ mutable feature arms',
        'working-copy': 'Unfinished ephemeral @ scratchpad with no clear intent yet',
      }),
      entangled: noul('Does this diff mix structural refactoring with behavioral changes that should be split?', {
        true: 'Contains both structural tidying (renames/moves/extractions) and new behavior or bugfixes',
        false: 'Focused cleanly on a single concern (either structural or behavioral)',
      }),
      publishReadiness: score('How ready is this change to be reviewed and pushed to a shared forge?', [
        'scratchpad',
        'needs-cleanup',
        'reviewable',
        'ready-to-land',
      ]),
      hasDebugOrSecrets: noul('Does the diff contain stray debug logging, temporary hacks, or hardcoded credentials?', {
        true: 'Contains console.log/dbg!/print debugging, FIXME/HACK markers, or API keys/tokens',
        false: 'Clean production or test code without debug artifacts or secrets',
      }),
    };

    if (this.client?.isConfigured) {
      try {
        const res = await this.client.systemOne({ state, questions });
        return { source: 'live-jev', model: this.client.defaultModel, answers: res.answers, usage: res.usage ?? null };
      } catch {
        // Fall through to calibrated offline heuristic so VCS flow never stalls
      }
    }

    return { source: 'calibrated-offline', model: 'offline-heuristic', answers: this._offlineTriage(input), usage: null };
  }

  /**
   * 2. Two-Part Dependency Test via Jev (`noul` x 2 in parallel):
   *    Evaluates Causal Necessity and Independent Reviewability from diffs + paths,
   *    then feeds the calibrated probabilities into `JjrGraph.evaluateDependency`.
   *
   * @param {{
   *   base: { changeId: string, description?: string, touchedPaths?: readonly string[], diffExcerpt?: string },
   *   child: { changeId: string, description?: string, touchedPaths?: readonly string[], diffExcerpt?: string },
   * }} pair
   */
  async assessDependency(pair) {
    const state = {
      base_change: {
        change_id: pair.base.changeId,
        description: pair.base.description ?? '',
        touched_paths: pair.base.touchedPaths ?? [],
        diff_excerpt: (pair.base.diffExcerpt ?? '').slice(0, 4000),
      },
      child_change: {
        change_id: pair.child.changeId,
        description: pair.child.description ?? '',
        touched_paths: pair.child.touchedPaths ?? [],
        diff_excerpt: (pair.child.diffExcerpt ?? '').slice(0, 4000),
      },
    };

    const questions = {
      childCausallyDependsOnBase: noul(
        'Does child_change causally depend on base_change to compile, pass tests, or make logical sense?',
        {
          true: 'child_change calls symbols, modifies lines, or relies on behavior introduced in base_change',
          false: 'child_change touches independent modules/concerns and works cleanly directly atop trunk()',
        },
      ),
      baseIndependentlyReviewable: noul(
        'Can base_change be reviewed, understood, and merged safely without reading child_change?',
        {
          true: 'base_change is self-contained, builds cleanly, and has a coherent purpose on its own',
          false: 'base_change leaves broken callers, incomplete renames, or dead scaffolding only completed by child_change',
        },
      ),
    };

    let answers;
    let source = 'calibrated-offline';
    if (this.client?.isConfigured) {
      try {
        const res = await this.client.systemOne({ state, questions });
        answers = res.answers;
        source = 'live-jev';
      } catch {
        answers = this._offlineDependency(pair);
      }
    } else {
      answers = this._offlineDependency(pair);
    }

    const verdict = JjrGraph.evaluateDependency({
      base: pair.base.changeId,
      child: pair.child.changeId,
      causalProbability: answers.childCausallyDependsOnBase.noul,
      reviewabilityProbability: answers.baseIndependentlyReviewable.noul,
    });

    return { source, answers, verdict };
  }

  /**
   * 3. Behind-the-Scenes Guardrail Risk Augmentation (`noul` + `score`):
   *    Detects unmarked scratchpads/megamerges and estimates blast radius to decide
   *    whether a command should be dry-run first.
   */
  async evaluateActionRisk(graph, action, diffExcerpt = '') {
    const targetNodes = (action.targetChanges ?? [])
      .map((id) => graph.get(id) ?? graph.getByCommit(id))
      .filter(Boolean);

    const state = {
      action_type: action.type,
      command: action.command ?? action.rawGitCommand ?? '',
      targets: targetNodes.map((n) => ({
        change_id: n.changeId,
        description: n.currentCommit.description,
        intent: n.intent,
        children_count: n.children.length,
        is_conflicted: Boolean(n.currentCommit.conflict?.isConflicted),
        is_empty: Boolean(n.currentCommit.isEmpty),
      })),
      diff_excerpt: diffExcerpt.slice(0, 3000),
    };

    const questions = {
      looksLikeScratchpad: noul(
        'Does the targeted change look like an unfinished local scratchpad, WIP dump, or unmarked integration megamerge?',
      ),
      blastRadius: score('What is the blast radius of this VCS action on the repository graph?', [
        'trivial',
        'single-change',
        'stack-wide',
        'repo-wide',
      ]),
    };

    if (this.client?.isConfigured) {
      try {
        const res = await this.client.systemOne({ state, questions });
        return { source: 'live-jev', ...res.answers };
      } catch {
        // fall through
      }
    }

    return { source: 'calibrated-offline', ...this._offlineActionRisk(targetNodes, action, diffExcerpt) };
  }

  /**
   * 4. Behind-the-Scenes Dual Time-Axis Recovery Advisor (`choice`):
   *    Decides whether a regression calls for surgical single-change `evolog`
   *    restore or repository-wide `op restore` / `jj undo`.
   */
  async recommendRecovery(context) {
    const state = {
      symptom: context.symptom ?? '',
      target_change_id: context.targetChangeId ?? null,
      sibling_arms_modified_since: Boolean(context.siblingArmsModifiedSince),
      bookmark_or_topology_corrupted: Boolean(context.bookmarkOrTopologyCorrupted),
    };

    const questions = {
      axis: choice('Which Jujutsu recovery time axis minimizes collateral loss?', {
        evolog: 'Surgical single-change restore (`jj restore --from <commit> --to <change>`) preserving sibling arms',
        'op-restore': 'Repository-wide rewind (`jj op restore <op>`) when bookmarks or multi-branch topology broke',
        undo: 'Simple `jj undo` when the immediately preceding operation was a mistake',
      }),
    };

    if (this.client?.isConfigured) {
      try {
        const res = await this.client.systemOne({ state, questions });
        return { source: 'live-jev', decision: res.answers.axis };
      } catch {
        // fall through
      }
    }

    const weights = {
      evolog: context.targetChangeId && context.siblingArmsModifiedSince ? 0.88 : context.targetChangeId ? 0.62 : 0.12,
      'op-restore': context.bookmarkOrTopologyCorrupted ? 0.86 : 0.2,
      undo: !context.siblingArmsModifiedSince && !context.bookmarkOrTopologyCorrupted ? 0.78 : 0.14,
    };
    return { source: 'calibrated-offline', decision: normalizeDist(weights) };
  }

  /**
   * 5. Behind-the-Scenes Absorb / Split Hunk Router (`choice`):
   *    When a working-copy fixup atop a megamerge could belong to several arms,
   *    ranks candidate arms with calibrated confidence.
   *
   * @param {string} hunkDiff
   * @param {readonly { changeId: string, description: string, touchedPaths?: readonly string[] }[]} candidateArms
   */
  async routeHunk(hunkDiff, candidateArms) {
    if (candidateArms.length === 0) {
      return { source: 'calibrated-offline', decision: null };
    }
    const criteria = {};
    for (const arm of candidateArms) {
      const files = (arm.touchedPaths ?? []).slice(0, 6).join(', ');
      criteria[arm.changeId] = `${arm.description.split('\n')[0] || '(undescribed)'}${files ? ` [files: ${files}]` : ''}`;
    }

    const questions = {
      ownerArm: choice('Which parallel feature arm should absorb this diff hunk?', criteria),
    };

    if (this.client?.isConfigured) {
      try {
        const res = await this.client.systemOne({ state: { hunk_diff: hunkDiff.slice(0, 4000) }, questions });
        return { source: 'live-jev', decision: res.answers.ownerArm };
      } catch {
        // fall through
      }
    }

    const lowerHunk = hunkDiff.toLowerCase();
    const weights = {};
    for (const arm of candidateArms) {
      let w = 0.15;
      const tokens = `${arm.description} ${(arm.touchedPaths ?? []).join(' ')}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3);
      for (const tok of new Set(tokens)) {
        if (lowerHunk.includes(tok)) w += 0.25;
      }
      weights[arm.changeId] = w;
    }
    return { source: 'calibrated-offline', decision: normalizeDist(weights) };
  }

  // -------------------------------------------------------------------------
  // Calibrated offline heuristics (deterministic, zero-network fallback)
  // -------------------------------------------------------------------------

  _offlineTriage(input) {
    const desc = (input.description ?? '').trim();
    const diff = input.diffExcerpt ?? '';
    const lowerDiff = diff.toLowerCase();
    const inferred = inferIntentFallback({
      description: desc,
      isEmpty: input.isEmpty,
      isWorkingCopy: input.isWorkingCopy,
      mutableParentCount: input.mutableParentCount,
      touchedPaths: input.touchedPaths,
    });

    const intentWeights = {
      structural: 0.06,
      behavioral: 0.08,
      'test-harness': 0.05,
      activation: 0.04,
      blueprint: 0.04,
      megamerge: 0.03,
      'working-copy': 0.05,
    };
    intentWeights[inferred] = 0.72;
    const intent = normalizeDist(intentWeights);

    const hasRefactorSignals = /\b(rename|extract|refactor|cleanup|move|inline)\b/i.test(`${desc}\n${diff}`);
    const hasFeatureSignals = /\b(feat|add|support|endpoint|handler|fix|bug)\b/i.test(`${desc}\n${diff}`);
    const entangledP = prob(hasRefactorSignals && hasFeatureSignals ? 0.84 : hasRefactorSignals || hasFeatureSignals ? 0.18 : 0.35);

    const hasDebug = /\b(console\.log|debugger|dbg!|print\(|TODO:|FIXME:|HACK:|sk-[a-z0-9]{12,}|AKIA[0-9A-Z]{16})\b/i.test(diff);
    const debugP = prob(hasDebug ? 0.91 : 0.06);

    const levels = ['scratchpad', 'needs-cleanup', 'reviewable', 'ready-to-land'];
    let levelIdx = 2;
    if (input.isConflicted || inferred === 'megamerge' || inferred === 'working-copy' || !desc) {
      levelIdx = 0;
    } else if (hasDebug || entangledP > 0.7 || /\b(wip|tmp|scratch|test)\b/i.test(desc)) {
      levelIdx = 1;
    } else if ((input.touchedPaths ?? []).length > 0 && desc.length >= 12) {
      levelIdx = 3;
    }

    const levelProbs = [0.05, 0.08, 0.12, 0.05];
    levelProbs[levelIdx] = 0.75;
    const sum = levelProbs.reduce((a, b) => a + b, 0);
    const normProbs = levelProbs.map((v) => Math.round((v / sum) * 1000) / 1000);
    const expectedScore = Math.round(normProbs.reduce((acc, p, idx) => acc + p * idx, 0) * 100) / 100;

    return {
      intent,
      entangled: { noul: entangledP },
      publishReadiness: {
        score: expectedScore,
        legend: levels[levelIdx],
        probabilities: normProbs,
        confidence: normProbs[levelIdx],
      },
      hasDebugOrSecrets: { noul: debugP },
    };
  }

  _offlineDependency(pair) {
    const basePaths = new Set(pair.base.touchedPaths ?? []);
    const childPaths = new Set(pair.child.touchedPaths ?? []);
    const overlap = [...childPaths].filter((p) => basePaths.has(p));

    const baseText = `${pair.base.description ?? ''} ${pair.base.diffExcerpt ?? ''}`.toLowerCase();
    const childText = `${pair.child.description ?? ''} ${pair.child.diffExcerpt ?? ''}`.toLowerCase();

    // Check shared identifier tokens or overlapping files
    const baseDirs = new Set([...basePaths].map((p) => p.split('/').slice(0, -1).join('/')));
    const sharedDir = [...childPaths].some((p) => baseDirs.has(p.split('/').slice(0, -1).join('/')) && p.includes('/'));

    const mentionsBaseSymbol =
      overlap.length > 0 ||
      (/\b(rename|interface|schema|type|extract)\b/.test(baseText) && sharedDir);

    const baseLooksIncomplete =
      /\b(wip|part\s*1|todo|broken|without caller|rename helper)\b/i.test(baseText) ||
      (overlap.length > 0 && /\b(update.*caller|fix.*caller)\b/i.test(childText));

    const causalP = prob(overlap.length > 0 ? 0.89 : mentionsBaseSymbol ? 0.81 : sharedDir ? 0.52 : 0.11);
    const reviewP = prob(baseLooksIncomplete ? 0.14 : 0.88);

    return {
      childCausallyDependsOnBase: { noul: causalP },
      baseIndependentlyReviewable: { noul: reviewP },
    };
  }

  _offlineActionRisk(targetNodes, action, diffExcerpt) {
    const anyWip = targetNodes.some((n) => {
      const d = (n.currentCommit.description ?? '').trim();
      return !d || /^(wip|tmp|local:|scratch|fixup)/i.test(d) || n.intent === 'working-copy';
    });
    const hasDebug = /\b(console\.log|debugger|TODO:|FIXME:)\b/i.test(diffExcerpt);
    const scratchpadP = prob(anyWip ? 0.86 : hasDebug ? 0.54 : 0.08);

    const levels = ['trivial', 'single-change', 'stack-wide', 'repo-wide'];
    const totalChildren = targetNodes.reduce((acc, n) => acc + (n.children?.length ?? 0), 0);
    let idx = 1;
    if (action.type === 'mutate' && /^op\s+(restore|revert)/i.test(action.command ?? '')) idx = 3;
    else if (totalChildren >= 2 || action.type === 'push') idx = 2;
    else if (targetNodes.length <= 1 && totalChildren === 0) idx = 0;

    const raw = [0.06, 0.08, 0.08, 0.04];
    raw[idx] = 0.78;
    const sum = raw.reduce((a, b) => a + b, 0);
    const probs = raw.map((v) => Math.round((v / sum) * 1000) / 1000);
    const expected = Math.round(probs.reduce((acc, p, i) => acc + p * i, 0) * 100) / 100;

    return {
      looksLikeScratchpad: { noul: scratchpadP },
      blastRadius: {
        score: expected,
        legend: levels[idx],
        probabilities: probs,
        confidence: probs[idx],
      },
    };
  }
}
