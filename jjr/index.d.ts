declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ChangeId = Brand<string, 'ChangeId'>;
export type CommitId = Brand<string, 'CommitId'>;
export type OpId = Brand<string, 'OpId'>;
export type BookmarkName = Brand<string, 'BookmarkName'>;

export type GraphZone = 'immutable' | 'mutable';
export type ForgeKind = 'gerrit' | 'github-bookmarks' | 'github-stack' | 'github-spr';

export type ChangeIntentKind =
  | 'structural'
  | 'behavioral'
  | 'test-harness'
  | 'activation'
  | 'blueprint'
  | 'megamerge'
  | 'working-copy';

export class JjrTypeError extends Error {
  readonly expectedKind: 'ChangeId' | 'CommitId' | 'OpId' | 'BookmarkName';
  readonly received: string;
  constructor(message: string, expectedKind: 'ChangeId' | 'CommitId' | 'OpId' | 'BookmarkName', received: string);
}

export function asChangeId(raw: string): ChangeId;
export function asCommitId(raw: string): CommitId;
export function asOpId(raw: string): OpId;
export function asBookmark(raw: string): BookmarkName;
export function isChangeId(raw: unknown): raw is ChangeId;
export function isCommitId(raw: unknown): raw is CommitId;
export function isOpId(raw: unknown): raw is OpId;
export function formatShortId(id: ChangeId | CommitId | OpId | string, len?: number): string;

export const CHANGE_INTENT_KINDS: readonly ChangeIntentKind[];
export const DEFAULT_REPO_CONFIG: Readonly<JjrRepoConfig>;

export interface JjrRepoConfig {
  readonly trunkRevset: string;
  readonly immutableHeadsRevset: string;
  readonly colocated: boolean;
  readonly mergeSameChange: 'accept' | 'keep';
  readonly megamergePrefix: string;
  readonly forge: ForgeKind;
}

export interface ConflictState {
  readonly isConflicted: true;
  readonly conflictedPaths: readonly string[];
}

export interface CleanState {
  readonly isConflicted: false;
}

export type TreeConflict = ConflictState | CleanState;

export interface VerificationStatus {
  readonly formatted: boolean;
  readonly builds: boolean;
  readonly testsPass: boolean;
  readonly verified?: boolean;
  readonly checkedAtCommit?: CommitId;
}

export interface CommitSnapshot {
  readonly commitId: CommitId;
  readonly changeId: ChangeId;
  readonly parentCommits: readonly CommitId[];
  readonly isEmpty: boolean;
  readonly conflict: TreeConflict;
  readonly author: string;
  readonly timestamp: string;
  readonly touchedPaths: readonly string[];
  readonly filesCount?: number;
  readonly description: string;
}

export interface JjrChange {
  readonly changeId: ChangeId;
  readonly prefix?: string;
  readonly currentCommit: CommitSnapshot;
  readonly zone: GraphZone;
  readonly parents: readonly ChangeId[];
  readonly children: readonly ChangeId[];
  readonly bookmarks: readonly BookmarkName[];
  readonly remotes?: readonly string[];
  readonly tags?: readonly string[];
  readonly isWorkingCopy: boolean;
  readonly intent: ChangeIntentKind;
  readonly verification: VerificationStatus;
  readonly isDivergent: boolean;
  readonly divergentCommits?: readonly CommitId[];
}

export type DependencyOutcome = 'stack' | 'parallelize' | 'collapse' | 'confirm';

export interface DependencyVerdict {
  readonly outcome: DependencyOutcome;
  readonly base: ChangeId | string;
  readonly child: ChangeId | string;
  readonly causalProbability?: number;
  readonly reviewabilityProbability?: number;
  readonly reason: string;
  readonly suggestedArgs: readonly string[] | null;
  readonly suggestedCommand: string | null;
}

export interface DependencyAssessment {
  readonly base: ChangeId | string;
  readonly child: ChangeId | string;
  readonly childCausallyDependsOnBase?: boolean;
  readonly baseIndependentlyReviewable?: boolean;
  readonly causalProbability?: number;
  readonly reviewabilityProbability?: number;
  readonly threshold?: { readonly high?: number; readonly low?: number };
}

export interface GraphDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code:
    | 'DIVERGENT_CHANGE'
    | 'UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL'
    | 'MEGAMERGE_WITH_BOOKMARK'
    | 'CONFLICT_IN_PUBLISHABLE'
    | 'LOSSY_MERGE_CONFIG'
    | 'EMPTY_NON_BLUEPRINT_CHANGE';
  readonly message: string;
  readonly affectedChanges: readonly ChangeId[];
  readonly suggestedArgs?: readonly string[];
  readonly suggestedCommand?: string;
}

export interface GraphSummary {
  readonly totalChanges: number;
  readonly mutableCount: number;
  readonly immutableCount: number;
  readonly mutableRootsCount: number;
  readonly divergentCount: number;
  readonly conflictedCount: number;
  readonly megamergeCount: number;
  readonly diagnosticsCount: number;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
  readonly status: 'clean' | 'attention' | 'blocked';
}

export class JjrGraph {
  readonly config: Readonly<JjrRepoConfig>;
  constructor(changes: readonly JjrChange[], config?: Partial<JjrRepoConfig>);
  static fromJjGraphNodes(
    nodes: readonly Record<string, unknown>[],
    options?: Partial<JjrRepoConfig> & {
      intents?: Record<string, ChangeIntentKind>;
      verifications?: Record<string, VerificationStatus>;
    },
  ): JjrGraph;
  static evaluateDependency(assessment: DependencyAssessment): DependencyVerdict;
  get(changeId: ChangeId | string): JjrChange | undefined;
  getByCommit(commitId: CommitId | string): JjrChange | undefined;
  require(changeId: ChangeId | string): JjrChange;
  all(): readonly JjrChange[];
  mutable(): readonly JjrChange[];
  immutable(): readonly JjrChange[];
  workingCopy(): JjrChange | undefined;
  divergent(): readonly JjrChange[];
  conflicted(): readonly JjrChange[];
  mutableRoots(): readonly JjrChange[];
  isMegamerge(change: JjrChange | undefined): boolean;
  mutableAncestorsOf(targetId: ChangeId | string): readonly JjrChange[];
  mutableEdges(): readonly { readonly base: JjrChange; readonly child: JjrChange }[];
  diagnose(): readonly GraphDiagnostic[];
  summary(): GraphSummary;
}

// Guardrails
export type GuardrailAction =
  | { readonly type: 'mutate'; readonly targetChanges: readonly (ChangeId | string)[]; readonly command: string }
  | { readonly type: 'push'; readonly targetChanges: readonly (ChangeId | string)[]; readonly bookmark?: string }
  | { readonly type: 'git-interop'; readonly rawGitCommand: string }
  | { readonly type: 'workspace-add'; readonly reason: 'switch-branch' | 'parallel-build-or-agent' };

export interface GuardrailDecision {
  readonly allowed: boolean;
  readonly ruleName: string;
  readonly severity: 'block' | 'warn' | 'pass';
  readonly message: string;
  readonly remediation?: string;
  readonly calibratedProbability?: number;
  readonly calibratedConfidence?: number;
}

export type GuardrailRule = (graph: JjrGraph, action: GuardrailAction) => GuardrailDecision;

export interface GuardrailResult {
  readonly allowed: boolean;
  readonly decisions: readonly GuardrailDecision[];
  readonly blockers: readonly GuardrailDecision[];
  readonly warnings: readonly GuardrailDecision[];
}

export const DEFAULT_GUARDRAILS: readonly GuardrailRule[];
export const immutableBedrockGuard: GuardrailRule;
export const divergenceGuard: GuardrailRule;
export const megamergeFence: GuardrailRule;
export const publishingGate: GuardrailRule;
export const colocatedGitGuard: GuardrailRule;
export const workspaceDisciplineGuard: GuardrailRule;

export function extractMutatedTargets(args: readonly string[]): readonly string[];

export class JjrGuardrailPipeline {
  constructor(rules?: readonly GuardrailRule[]);
  use(rule: GuardrailRule): this;
  evaluate(graph: JjrGraph, action: GuardrailAction): GuardrailResult;
  evaluateWithJev(
    graph: JjrGraph,
    action: GuardrailAction,
    opts?: { jev?: JjrJevAssistant; diffExcerpt?: string },
  ): Promise<GuardrailResult & { readonly jevAssessment: Record<string, unknown> | null }>;
}

// TypeSafe AI Jev System-One primitives & workflows
export interface ChoiceQuestion<K extends string = string> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<K, string | null>>;
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export interface ChoiceAnswer<K extends string = string> {
  readonly choice: K;
  readonly probabilities: Readonly<Record<K, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly score: number;
  readonly legend: string;
  readonly probabilities: readonly number[];
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly noul: number;
}

export function choice<K extends string>(instructions: string, criteria: Record<K, string | null>): ChoiceQuestion<K>;
export function score(instructions: string, criteria: readonly string[]): ScoreQuestion;
export function noul(instructions: string, criteria?: { true?: string; false?: string }): NoulQuestion;

export class JevClient {
  readonly isConfigured: boolean;
  readonly defaultModel: string;
  constructor(options?: {
    apiKey?: string;
    baseURL?: string;
    defaultModel?: string;
    sdkClient?: { systemOne: (req: unknown) => Promise<unknown> };
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  });
  systemOne(request: {
    model?: string;
    state: unknown;
    questions: Record<string, ChoiceQuestion | ScoreQuestion | NoulQuestion>;
  }): Promise<{ answers: Record<string, unknown>; usage?: Record<string, number> }>;
}

export interface ChangeTriageResult {
  readonly source: 'live-jev' | 'calibrated-offline';
  readonly model: string;
  readonly answers: {
    readonly intent: ChoiceAnswer<ChangeIntentKind>;
    readonly entangled: NoulAnswer;
    readonly publishReadiness: ScoreAnswer;
    readonly hasDebugOrSecrets: NoulAnswer;
  };
  readonly usage: Record<string, number> | null;
}

export class JjrJevAssistant {
  readonly mode: 'live-jev' | 'calibrated-offline';
  constructor(client?: JevClient | null);
  triageChange(input: {
    changeId: ChangeId | string;
    description?: string;
    touchedPaths?: readonly string[];
    diffExcerpt?: string;
    isEmpty?: boolean;
    isWorkingCopy?: boolean;
    mutableParentCount?: number;
    isConflicted?: boolean;
  }): Promise<ChangeTriageResult>;
  assessDependency(pair: {
    base: { changeId: ChangeId | string; description?: string; touchedPaths?: readonly string[]; diffExcerpt?: string };
    child: { changeId: ChangeId | string; description?: string; touchedPaths?: readonly string[]; diffExcerpt?: string };
  }): Promise<{
    readonly source: 'live-jev' | 'calibrated-offline';
    readonly answers: { readonly childCausallyDependsOnBase: NoulAnswer; readonly baseIndependentlyReviewable: NoulAnswer };
    readonly verdict: DependencyVerdict;
  }>;
  evaluateActionRisk(
    graph: JjrGraph,
    action: GuardrailAction,
    diffExcerpt?: string,
  ): Promise<{
    readonly source: 'live-jev' | 'calibrated-offline';
    readonly looksLikeScratchpad: NoulAnswer;
    readonly blastRadius: ScoreAnswer;
  }>;
  recommendRecovery(context: {
    symptom?: string;
    targetChangeId?: ChangeId | string;
    siblingArmsModifiedSince?: boolean;
    bookmarkOrTopologyCorrupted?: boolean;
  }): Promise<{
    readonly source: 'live-jev' | 'calibrated-offline';
    readonly decision: ChoiceAnswer<'evolog' | 'op-restore' | 'undo'>;
  }>;
  routeHunk(
    hunkDiff: string,
    candidateArms: readonly { changeId: ChangeId | string; description: string; touchedPaths?: readonly string[] }[],
  ): Promise<{
    readonly source: 'live-jev' | 'calibrated-offline';
    readonly decision: ChoiceAnswer | null;
  }>;
}

// Light LLM Narrator (System Two)
export interface LlmTransport {
  readonly isConfigured?: boolean;
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class OpenAiCompatibleTransport implements LlmTransport {
  readonly isConfigured: boolean;
  constructor(options?: { apiKey?: string; baseURL?: string; model?: string; fetchImpl?: typeof fetch });
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface NamingSuggestion {
  readonly conventionalTitle: string;
  readonly bookmarkSlug: string;
  readonly detectedIntent: ChangeIntentKind;
  readonly intentConfidence: number;
  readonly entangledProbability: number;
  readonly rationale: string;
  readonly source: 'llm' | 'deterministic';
}

export class JjrNarrator {
  constructor(options?: { transport?: LlmTransport | null; jev?: JjrJevAssistant });
  suggestChangeName(input: {
    changeId?: ChangeId | string;
    description?: string;
    touchedPaths?: readonly string[];
    diffExcerpt?: string;
  }): Promise<NamingSuggestion>;
  explainGraphFeedback(graph: JjrGraph): Promise<{
    readonly summary: string;
    readonly suggestions: readonly string[];
    readonly source: 'llm' | 'deterministic';
  }>;
  critiqueDependency(base: JjrChange, child: JjrChange, assessment: DependencyAssessment): string;
}

// Patterns & Runner
export interface PatternStep {
  readonly title: string;
  readonly args: readonly string[] | null;
  readonly command: string;
  readonly dryRunnable: boolean;
  readonly invariant: string;
}

export interface JjrRecipe {
  readonly id: string;
  readonly pattern: string;
  readonly summary: string;
  readonly steps: readonly PatternStep[];
}

export const JjrPatterns: {
  tidyFirstBelow(behavioralChangeId: ChangeId | string, description: string): JjrRecipe;
  verifyRedTest(implFiles: readonly string[]): JjrRecipe;
  branchByAbstraction(seamName: string): JjrRecipe;
  localMegamerge(arms: readonly (ChangeId | string)[], prefix?: string): JjrRecipe;
  postMergeConvergence(includeParkedSiblings?: boolean): JjrRecipe;
  publishCommand(forge: ForgeKind, changeId: ChangeId | string): string;
};

export function planTimeTravelRecovery(params: {
  scope: 'single-change' | 'repo-wide' | 'undo';
  targetOpId?: OpId | string;
  targetChangeId?: ChangeId | string;
  targetEvologCommit?: CommitId | string;
}): {
  readonly axis: 'evolog' | 'op-log';
  readonly args: readonly string[];
  readonly command: string;
  readonly explanation: string;
  readonly blastRadius: 'single-change' | 'repo-wide';
};

export function suggestPatternsForGraph(graph: JjrGraph): readonly JjrRecipe[];

export class JjrRunner {
  readonly pipeline: JjrGuardrailPipeline;
  readonly jev: JjrJevAssistant;
  readonly narrator: JjrNarrator;
  constructor(options?: {
    pipeline?: JjrGuardrailPipeline;
    jev?: JjrJevAssistant;
    narrator?: JjrNarrator;
    app?: { handle: (...args: unknown[]) => Promise<unknown> } | null;
  });
  planMutation(graph: JjrGraph, targetChanges: readonly (ChangeId | string)[], command: string): {
    readonly command: string;
    readonly guardResult: GuardrailResult;
    readonly blocked: boolean;
  };
  planPush(graph: JjrGraph, targetChanges: readonly (ChangeId | string)[], bookmark?: string): {
    readonly command: string;
    readonly guardResult: GuardrailResult;
    readonly blocked: boolean;
  };
  planGitInterop(graph: JjrGraph, rawGitCommand: string): {
    readonly command: string;
    readonly guardResult: GuardrailResult;
    readonly blocked: boolean;
  };
  planWorkspaceAdd(graph: JjrGraph, reason: 'switch-branch' | 'parallel-build-or-agent'): {
    readonly command: string;
    readonly guardResult: GuardrailResult;
    readonly blocked: boolean;
  };
  dryRun(args: readonly string[], opts?: { revset?: string; useJev?: boolean }): Promise<{
    readonly blocked: boolean;
    readonly guardResult: GuardrailResult;
    readonly result: unknown;
    readonly state: unknown;
  }>;
  previewPattern(recipe: JjrRecipe, opts?: { revset?: string; useJev?: boolean }): Promise<readonly unknown[]>;
}

// Portable UI ViewModels & Adapters
export function buildDagGraphViewModel(graph: JjrGraph, selectedChangeId?: ChangeId | string | null): Record<string, unknown>;
export function buildGuardrailBanner(decisions: readonly GuardrailDecision[]): Record<string, unknown>;
export function buildDependencyGate(params: { baseLabel: string; childLabel: string; verdict: DependencyVerdict; source?: string }): Record<string, unknown>;
export function buildTriageCard(changeId: ChangeId | string, triageResult: ChangeTriageResult): Record<string, unknown>;
export function buildTimeTravelScrubber(params: { axis: 'evolog' | 'op-log'; entries: readonly unknown[]; activeIndex: number; plan: ReturnType<typeof planTimeTravelRecovery> }): Record<string, unknown>;
export function buildNamingAssistant(suggestion: NamingSuggestion, accepted?: boolean): Record<string, unknown>;

export const TUI_KEYBINDINGS: Readonly<Record<string, string>>;
export function renderDagTui(vm: Record<string, unknown>, useColor?: boolean): string;
export function renderGuardrailBannerTui(vm: Record<string, unknown>, useColor?: boolean): string;
export function renderDependencyGateTui(vm: Record<string, unknown>): string;
export function renderTriageTui(vm: Record<string, unknown>): string;
export function renderNamingAssistantTui(vm: Record<string, unknown>): string;
export function renderTimeTravelTui(vm: Record<string, unknown>): string;

export function toGuiDagRows(vm: Record<string, unknown>): readonly Record<string, unknown>[];
export function toGuiAlertProps(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiDependencyCard(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiTriageProps(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiTimeTravelProps(vm: Record<string, unknown>): Record<string, unknown>;
