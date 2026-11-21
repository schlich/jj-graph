/**
 * Light LLM Layer ("System Two") for jjr.
 *
 * Strictly scoped to prose generation: naming changes, proposing concise
 * bookmark slugs, and summarizing diagnostics or dependency critiques in
 * plain English. Classification, routing, and calibrated gating belong to
 * TypeSafe Jev (`jjr/jev.mjs`), so the LLM is never invoked on every
 * graph event.
 */

import { JjrGraph } from './graph.mjs';
import { JjrJevAssistant } from './jev.mjs';

/**
 * Minimal OpenAI-compatible HTTP transport using native Node `fetch`.
 */
export class OpenAiCompatibleTransport {
  /**
   * @param {{ apiKey?: string, baseURL?: string, model?: string, fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.JJR_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = (options.baseURL ?? process.env.JJR_LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model ?? process.env.JJR_LLM_MODEL ?? 'gpt-4o-mini';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  async complete(systemPrompt, userPrompt) {
    if (!this.apiKey) throw new Error('No LLM API key configured.');
    const res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM request failed (${res.status})`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }
}

const INTENT_TO_PREFIX = {
  structural: 'refactor',
  behavioral: 'feat',
  'test-harness': 'test',
  activation: 'feat',
  blueprint: 'plan',
  megamerge: 'local',
  'working-copy': 'wip',
};

/**
 * JjrNarrator pairs Jev's calibrated System-One classification with a light
 * LLM (or crisp offline fallback) to write clean titles, bookmark slugs, and
 * developer feedback.
 */
export class JjrNarrator {
  /**
   * @param {{
   *   transport?: { complete: (systemPrompt: string, userPrompt: string) => Promise<string>, isConfigured?: boolean } | null,
   *   jev?: JjrJevAssistant,
   * }} [options]
   */
  constructor(options = {}) {
    this.transport = options.transport ?? null;
    this.jev = options.jev ?? new JjrJevAssistant();
  }

  /**
   * Suggest a conventional change description and bookmark slug.
   * Step 1: Jev classifies intent + entanglement in parallel (System One).
   * Step 2: Light LLM (or deterministic fallback) writes the title & slug (System Two).
   *
   * @param {{ changeId?: string, description?: string, touchedPaths?: readonly string[], diffExcerpt?: string }} input
   */
  async suggestChangeName(input) {
    const touchedPaths = input.touchedPaths ?? [];
    const diffExcerpt = input.diffExcerpt ?? '';
    const triage = await this.jev.triageChange({
      changeId: input.changeId ?? 'kkkkkkkk',
      description: input.description ?? '',
      touchedPaths,
      diffExcerpt,
    });

    const detectedIntent = triage.answers.intent.choice;
    const intentConfidence = triage.answers.intent.confidence;
    const entangled = triage.answers.entangled.noul;

    const canCallLlm = this.transport && (this.transport.isConfigured ?? true);
    if (canCallLlm) {
      try {
        const raw = await this.transport.complete(
          'You name Jujutsu (jj) changes. Return strict JSON with keys: conventionalTitle (<=72 chars), bookmarkSlug (kebab-case with prefix/), rationale (1 sentence).',
          `Jev intent: ${detectedIntent} (confidence ${intentConfidence.toFixed(2)}), entangled=${entangled.toFixed(2)}\nTouched paths:\n${touchedPaths.join('\n')}\n\nDiff excerpt:\n${diffExcerpt.slice(0, 1800)}`,
        );
        const match = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match ? match[0] : raw);
        if (parsed.conventionalTitle && parsed.bookmarkSlug) {
          return {
            conventionalTitle: parsed.conventionalTitle,
            bookmarkSlug: parsed.bookmarkSlug,
            detectedIntent,
            intentConfidence,
            entangledProbability: entangled,
            rationale: parsed.rationale ?? `Classified as ${detectedIntent} by Jev.`,
            source: 'llm',
          };
        }
      } catch {
        // Fall through to deterministic prose formatter
      }
    }

    return this._deterministicName(touchedPaths, diffExcerpt, detectedIntent, intentConfidence, entangled);
  }

  /**
   * Summarize graph diagnostics into plain, actionable feedback.
   * @param {JjrGraph} graph
   */
  async explainGraphFeedback(graph) {
    const diagnostics = graph.diagnose();
    if (diagnostics.length === 0) {
      return {
        summary: 'Your revision graph is clean: every mutable change is non-divergent and properly ordered.',
        suggestions: [],
        source: 'deterministic',
      };
    }

    const suggestions = diagnostics.map((d) =>
      d.suggestedCommand ? `${d.message} -> Try: \`${d.suggestedCommand}\`` : d.message,
    );

    const canCallLlm = this.transport && (this.transport.isConfigured ?? true);
    if (canCallLlm) {
      try {
        const summary = await this.transport.complete(
          'Summarize these Jujutsu revision-graph diagnostics in 2 direct, calm sentences for a developer. No hype.',
          suggestions.join('\n'),
        );
        if (summary.trim()) {
          return { summary: summary.trim(), suggestions, source: 'llm' };
        }
      } catch {
        // Fall through
      }
    }

    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    const summary =
      errors > 0
        ? `Found ${errors} blocking graph issue(s) and ${warnings} warning(s) in mutable(). Resolve errors before stacking or pushing.`
        : `Found ${diagnostics.length} hygiene suggestion(s) in mutable() that can tidy your stack before review.`;

    return { summary, suggestions, source: 'deterministic' };
  }

  /**
   * Turn a Two-Part Dependency Test verdict into a concise explanation.
   */
  critiqueDependency(base, child, assessment) {
    const verdict = JjrGraph.evaluateDependency(assessment);
    const baseShort = base.changeId.slice(0, 8);
    const childShort = child.changeId.slice(0, 8);
    if (verdict.outcome === 'stack') {
      return `Keep ${childShort} stacked on ${baseShort}: ${verdict.reason}`;
    }
    if (verdict.outcome === 'confirm') {
      return `Confirm relationship between ${baseShort} and ${childShort}: ${verdict.reason}`;
    }
    return `${verdict.reason} Suggested: \`${verdict.suggestedCommand}\`.`;
  }

  _deterministicName(touchedPaths, diffExcerpt, detectedIntent, intentConfidence, entangled) {
    const prefix = INTENT_TO_PREFIX[detectedIntent] ?? 'feat';
    const primary = (touchedPaths[0] ?? 'core')
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .toLowerCase() || 'change';

    const verb =
      detectedIntent === 'structural'
        ? 'refactor'
        : detectedIntent === 'test-harness'
          ? 'add tests for'
          : detectedIntent === 'activation'
            ? 'enable'
            : /\bfix\b/i.test(diffExcerpt)
              ? 'fix'
              : 'update';

    const conventionalTitle =
      detectedIntent === 'megamerge'
        ? `local: dev megamerge (${primary})`
        : `${prefix}(${primary}): ${verb} ${primary}`;
    const bookmarkSlug = detectedIntent === 'megamerge' ? '' : `${prefix}/${primary}`;

    const splitNote =
      entangled >= 0.72 ? ' Jev also flagged structural/behavioral entanglement — consider splitting first.' : '';

    return {
      conventionalTitle,
      bookmarkSlug,
      detectedIntent,
      intentConfidence,
      entangledProbability: entangled,
      rationale: `Jev classified this change as "${detectedIntent}" (confidence ${intentConfidence.toFixed(2)}) across ${touchedPaths.length} file(s).${splitNote}`,
      source: 'deterministic',
    };
  }
}
