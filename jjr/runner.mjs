/**
 * JjrRunner: guarded command planner and real Jujutsu dry-run executor.
 *
 * Wraps jj-graph's dry-run engine (`jj --at-op <tip> --no-integrate-operation`)
 * so every graph mutation passes through `JjrGuardrailPipeline` before
 * touching even a dry-run operation, previews entire SDLC pattern steps
 * safely before applying, and plans publishing layer by layer.
 */

import { describeMutation } from './commands.mjs';
import { JjrGraph } from './graph.mjs';
import { JjrGuardrailPipeline } from './guardrails.mjs';
import { JjrJevAssistant } from './jev.mjs';
import { JjrNarrator } from './narrator.mjs';
import { FORGE_ADAPTERS, JjrPatterns } from './patterns.mjs';

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
   * Pass `args` (the jj argv) when available so the guardrails see exactly
   * which revisions the command rewrites.
   */
  planMutation(graph, targetChanges, command, args = null) {
    const m = args ? describeMutation(args) : null;
    const guardResult = this.pipeline.evaluate(graph, {
      type: 'mutate',
      targetChanges: m ? [...new Set([...targetChanges, ...m.rewrites])] : targetChanges,
      command,
      ...(args ? { args, ignoreImmutable: m.ignoreImmutable, recovery: m.recovery } : {}),
    });
    return {
      command,
      guardResult,
      blocked: !guardResult.allowed,
    };
  }

  /**
   * Pure planning check for creating or moving a bookmark (an export pointer).
   */
  planBookmark(graph, names, targetChange) {
    const list = [].concat(names);
    const guardResult = this.pipeline.evaluate(graph, { type: 'bookmark', bookmarks: list, targetChanges: [targetChange] });
    return {
      command: `jj bookmark set ${list.join(' ')} -r ${String(targetChange).slice(0, 8)}`,
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
   * Plan publishing a stack layer by layer: walk the mutable ancestors of
   * `head` bottom-up and mark each layer publishable when the push guardrails
   * pass for it (its own ancestors included). Bottom layers that pass can be
   * published now; the rest stay local until they are ready.
   *
   * @param {JjrGraph} graph
   * @param {string} head change id, commit id, or simple revset of the top of the stack
   * @param {{ forge?: string }} [opts]
   */
  planLayeredPublish(graph, head, opts = {}) {
    const top = graph.get(head) ?? graph.getByCommit(head) ?? graph.resolve(head)[0];
    if (!top) throw new Error(`Change ${head} not found in the loaded graph.`);
    const forge = FORGE_ADAPTERS[opts.forge] ? opts.forge : FORGE_ADAPTERS[graph.config.forge] ? graph.config.forge : 'github-bookmarks';
    const adapter = FORGE_ADAPTERS[forge];
    const layers = graph.mutableAncestorsOf(top.changeId).map((c) => {
      const result = this.pipeline.evaluate(graph, { type: 'push', targetChanges: [c.changeId] });
      return {
        changeId: c.changeId,
        commitId: c.currentCommit.commitId,
        title: (c.currentCommit.description ?? '').split('\n')[0] || '(no description)',
        publishable: result.allowed,
        reasons: result.blockers.map((b) => `${b.ruleName}: ${b.message}`),
        warnings: result.warnings.map((w) => `${w.ruleName}: ${w.message}`),
        command: result.allowed ? JjrPatterns.publishCommand(forge, c.changeId) : null,
      };
    });
    const publishable = layers.filter((l) => l.publishable);
    // Stack-aware forges upload the top publishable layer and its ancestors at once.
    const publishableIds = new Set(publishable.map((l) => l.changeId));
    const heads = publishable.filter((l) => !graph.childrenOf(l.changeId).some((id) => publishableIds.has(id)));
    const commands = adapter.stackAware
      ? heads.map((l) => JjrPatterns.publishCommand(forge, l.changeId))
      : publishable.map((l) => l.command);
    return {
      forge,
      adapter: { name: adapter.name, modelAlignment: adapter.modelAlignment, caveats: adapter.caveats },
      head: top.changeId,
      layers,
      publish: publishable.map((l) => l.changeId),
      keepLocal: layers.filter((l) => !l.publishable).map((l) => l.changeId),
      commands,
    };
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
   * repository remains untouched until `apply()`. The server checks again
   * with revisions resolved by jj itself.
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
    const graph = JjrGraph.fromJjGraphNodes(liveState.nodes, { preflight: liveState.jjr?.preflight ?? null });
    const m = describeMutation(args);
    const action = {
      type: 'mutate',
      args,
      targetChanges: m.rewrites,
      command: `jj ${args.join(' ')}`,
      ignoreImmutable: m.ignoreImmutable,
      recovery: m.recovery,
    };

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

  /**
   * Verify a range of revisions on the bound `jj-graph` app: `jj fix` as a
   * formatting check plus the configured test command per revision. Results
   * feed the Publishing Gate.
   *
   * @param {{ revset?: string, range?: string }} [opts]
   */
  async verifyStack(opts = {}) {
    if (!this.app) {
      throw new Error('JjrRunner.verifyStack requires a bound jj-graph app instance (`new JjrRunner({ app })`).');
    }
    return this.app.handle('POST', '/api/jjr/verify', new URLSearchParams(), {
      range: opts.range,
      revset: opts.revset ?? 'all()',
    });
  }
}
