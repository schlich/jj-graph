/**
 * JjrRunner: guarded command planner and real Jujutsu dry-run executor.
 *
 * Wraps jj-graph's dry-run engine (`jj --at-op <tip> --no-integrate-operation`)
 * so every graph mutation passes through `JjrGuardrailPipeline` before
 * touching even a dry-run operation, and supports previewing entire SDLC
 * pattern steps safely before applying.
 */

import { JjrGraph } from './graph.mjs';
import { JjrGuardrailPipeline, extractMutatedTargets } from './guardrails.mjs';
import { JjrJevAssistant } from './jev.mjs';
import { JjrNarrator } from './narrator.mjs';

export class JjrRunner {
  /**
   * @param {{
   *   pipeline?: JjrGuardrailPipeline,
   *   jev?: JjrJevAssistant,
   *   narrator?: JjrNarrator,
   *   app?: { handle: Function, plan?: any } | null,
   * }} [options]
   */
  constructor(options = {}) {
    this.pipeline = options.pipeline ?? new JjrGuardrailPipeline();
    this.jev = options.jev ?? new JjrJevAssistant();
    this.narrator = options.narrator ?? new JjrNarrator({ jev: this.jev });
    this.app = options.app ?? null;
  }

  /**
   * Pure planning check for a mutation against an in-memory JjrGraph.
   */
  planMutation(graph, targetChanges, command) {
    const guardResult = this.pipeline.evaluate(graph, {
      type: 'mutate',
      targetChanges,
      command,
    });
    return {
      command,
      guardResult,
      blocked: !guardResult.allowed,
    };
  }

  /**
   * Pure planning check for a push against an in-memory JjrGraph.
   */
  planPush(graph, targetChanges, bookmark) {
    const cmd = bookmark
      ? `jj git push --bookmark ${bookmark}`
      : `jj git push -c ${targetChanges.map((id) => id.slice(0, 8)).join(' ')}`;
    const guardResult = this.pipeline.evaluate(
      graph,
      bookmark ? { type: 'push', targetChanges, bookmark } : { type: 'push', targetChanges },
    );
    return { command: cmd, guardResult, blocked: !guardResult.allowed };
  }

  /**
   * Pure planning check for a raw Git command in a colocated repo.
   */
  planGitInterop(graph, rawGitCommand) {
    const guardResult = this.pipeline.evaluate(graph, { type: 'git-interop', rawGitCommand });
    return { command: rawGitCommand, guardResult, blocked: !guardResult.allowed };
  }

  /**
   * Pure planning check for `jj workspace add`.
   */
  planWorkspaceAdd(graph, reason) {
    const guardResult = this.pipeline.evaluate(graph, { type: 'workspace-add', reason });
    return { command: 'jj workspace add', guardResult, blocked: !guardResult.allowed };
  }

  /**
   * Execute a guarded dry-run against a live `jj-graph` app instance.
   * Checks deterministic guardrails against the live `JjrGraph` first; if
   * clear, previews via `jj --at-op <tip> --no-integrate-operation` so the
   * repository remains untouched until `apply()`.
   *
   * @param {string[]} args
   * @param {{ revset?: string, useJev?: boolean }} [opts]
   */
  async dryRun(args, opts = {}) {
    if (!this.app) {
      throw new Error('JjrRunner.dryRun requires a bound jj-graph app instance (`new JjrRunner({ app })`).');
    }
    const revset = opts.revset ?? 'all()';
    const liveState = await this.app.handle('GET', '/api/state', new URLSearchParams({ revset }), null);
    const graph = JjrGraph.fromJjGraphNodes(liveState.nodes);
    const targetChanges = extractMutatedTargets(args);
    const action = { type: 'mutate', targetChanges, command: `jj ${args.join(' ')}` };

    const guardResult = opts.useJev
      ? await this.pipeline.evaluateWithJev(graph, action, { jev: this.jev })
      : this.pipeline.evaluate(graph, action);

    if (!guardResult.allowed) {
      return { blocked: true, guardResult, result: null, state: liveState };
    }

    const dryRes = await this.app.handle('POST', '/api/dry', new URLSearchParams(), { args, revset });
    return { blocked: false, guardResult, result: dryRes.result, state: dryRes.state };
  }

  /**
   * Preview all dry-runnable steps of a jjr SDLC pattern on the bound `jj-graph` app.
   */
  async previewPattern(recipe, opts = {}) {
    const outcomes = [];
    for (const step of recipe.steps) {
      if (!step.dryRunnable || !step.args) {
        outcomes.push({ title: step.title, skipped: true, reason: 'Interactive or external step', command: step.command });
        continue;
      }
      const res = await this.dryRun(step.args, opts);
      outcomes.push({ title: step.title, skipped: false, ...res });
      if (res.blocked) break;
    }
    return outcomes;
  }
}
