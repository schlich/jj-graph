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
  /** Longest linear chain of mutable changes before DEEP_STACK is reported. */
  readonly maxStackDepth: number;
}

export type DagShape = 'resting' | 'single' | 'stack' | 'parallel' | 'megamerge' | 'branching';

export interface CanonicalShape {
  readonly scenario: string;
  readonly dag: string;
  readonly primitives: readonly string[];
  readonly publishing: string;
}

export const CANONICAL_SHAPES: Readonly<Record<DagShape, CanonicalShape>>;

export type VerificationState = 'green' | 'red' | 'unknown';
export function verificationState(v: Partial<VerificationStatus> | null | undefined): VerificationState;
export function isTestPath(path: string): boolean;
export function isCodePath(path: string): boolean;

// jj command model
export type ArgumentRole = 'rewrite' | 'children' | 'parent' | 'source' | 'bookmark' | 'value' | 'fileset' | 'name' | 'none';

export interface JjCommandSpec {
  readonly positional: ArgumentRole;
  readonly positionalSlot?: string;
  readonly options: Readonly<Record<string, { readonly slot: string; readonly role: ArgumentRole }>>;
  readonly defaults?: Readonly<Record<string, string>>;
  readonly recovery?: boolean;
  readonly creates?: boolean;
}

export const JJ_COMMAND_SPECS: Readonly<Record<string, JjCommandSpec>>;

export interface ParsedJjArgs {
  readonly command: string;
  readonly spec: JjCommandSpec | null;
  readonly options: readonly { readonly name: string; readonly slot: string; readonly role: ArgumentRole; readonly value: string }[];
  readonly positional: readonly string[];
  readonly flags: readonly string[];
  readonly ignoreImmutable: boolean;
}

export interface MutationDescription {
  readonly command: string;
  readonly known: boolean;
  /** Revsets whose commits the command rewrites (children of `-A` targets as `X+`). */
  readonly rewrites: readonly string[];
  readonly parents: readonly string[];
  readonly sources: readonly string[];
  readonly bookmarks: readonly { readonly names: readonly string[]; readonly target: string }[];
  readonly revisionArgs: readonly string[];
  readonly filesets: readonly string[];
  readonly ignoreImmutable: boolean;
  readonly recovery: boolean;
  readonly creates: boolean;
}

export function parseJjArgs(args: readonly string[]): ParsedJjArgs;
export function describeMutation(args: readonly string[]): MutationDescription;
export function childrenOf(revset: string): string;
export function parentsOf(revset: string): string;

// Pre-flight facts gathered from the repository (jj-graph's server fills these in).
export interface PreflightRow {
  readonly changeId: string;
  readonly commitId: string;
  readonly immutable: boolean;
}

export interface PreflightFacts {
  readonly op?: string;
  readonly trunk:
    | ({ readonly resolved: true; readonly isRoot: boolean } & PreflightRow)
    | { readonly resolved: false; readonly error?: string };
  readonly immutableHeads:
    | { readonly resolved: true; readonly heads: readonly PreflightRow[] }
    | { readonly resolved: false; readonly error?: string };
  /** Mutable divergent change ids, including ones outside the loaded revset. */
  readonly divergent?: readonly string[];
  readonly mergeSameChange?: 'accept' | 'keep';
  readonly forge?: ForgeKind;
  readonly colocated?: boolean;
  readonly remotes?: readonly string[];
  readonly gitCompat?: readonly { readonly kind: string; readonly message: string; readonly suggestedCommand?: string }[];
  readonly keepRefs?: number;
}

export interface ConflictState {
  readonly isConflicted: true;
  readonly conflictedPaths: readonly string[];
}

export interface CleanState {
  readonly isConflicted: false;
}

export type TreeConflict = ConflictState | CleanState;

/** `null` means not checked for this snapshot. */
export interface VerificationStatus {
  readonly formatted: boolean | null;
  readonly builds: boolean | null;
  readonly testsPass: boolean | null;
  readonly verified?: boolean;
  readonly checkedAtCommit?: CommitId | string;
  readonly command?: string | null;
  readonly unformattedFiles?: readonly string[];
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
  /** Workspaces whose working copy is this change (`<name>@`). */
  readonly workspaces?: readonly string[];
  readonly isWorkingCopy: boolean;
  readonly isHidden?: boolean;
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

export type GraphDiagnosticCode =
  | 'DIVERGENT_CHANGE'
  | 'UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL'
  | 'MEGAMERGE_WITH_BOOKMARK'
  | 'MEGAMERGE_NOT_EMPTY'
  | 'MEGAMERGE_AS_WORKING_COPY'
  | 'CONFLICT_IN_PUBLISHABLE'
  | 'CONFLICTED_CHANGE'
  | 'LOSSY_MERGE_CONFIG'
  | 'EMPTY_NON_BLUEPRINT_CHANGE'
  | 'EDITING_BOOKMARK_TIP'
  | 'ACTIVATION_NOT_ON_TOP'
  | 'ACTIVATION_NOT_ISOLATED'
  | 'BEHAVIOR_WITHOUT_TESTS'
  | 'ROOT_BEHIND_TRUNK'
  | 'DEEP_STACK'
  | 'PREFLIGHT_UNRESOLVED'
  | 'PREFLIGHT_NO_BEDROCK'
  | 'PREFLIGHT_TRUNK_IS_ROOT'
  | 'PREFLIGHT_TRUNK_NOT_IMMUTABLE'
  | 'GIT_COMPAT'
  | 'GC_RECOMMENDED';

export interface GraphDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: GraphDiagnosticCode;
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
  readonly verifiedGreenCount: number;
  readonly shape: DagShape;
  readonly canonicalShape: CanonicalShape;
  readonly resting: boolean;
  readonly diagnosticsCount: number;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
  readonly status: 'clean' | 'attention' | 'blocked';
}

export class JjrGraph {
  readonly config: Readonly<JjrRepoConfig>;
  readonly preflight: PreflightFacts | null;
  constructor(changes: readonly JjrChange[], config?: Partial<JjrRepoConfig>, context?: { preflight?: PreflightFacts | null });
  static fromJjGraphNodes(
    nodes: readonly Record<string, unknown>[],
    options?: Partial<JjrRepoConfig> & {
      intents?: Record<string, ChangeIntentKind>;
      verifications?: Record<string, VerificationStatus>;
      preflight?: PreflightFacts | null;
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
  childrenOf(changeId: ChangeId | string): readonly ChangeId[];
  /** Resolve `@`, `<ws>@`, names, id prefixes, and trailing `-`/`+` against the loaded graph. */
  resolve(revset: string): readonly JjrChange[];
  trunk(): JjrChange | null;
  /** Immutable, or trunk() history even when immutable_heads() leaves it out. */
  isBedrock(change: JjrChange | undefined): boolean;
  isScratchpad(change: JjrChange | undefined): boolean;
  mutableRoots(): readonly JjrChange[];
  isMegamerge(change: JjrChange | undefined): boolean;
  /** Mutable ancestors (inclusive), parents before children. */
  mutableAncestorsOf(targetId: ChangeId | string): readonly JjrChange[];
  mutableEdges(): readonly { readonly base: JjrChange; readonly child: JjrChange }[];
  classifyShape(): DagShape;
  longestChain(): readonly JjrChange[];
  preflightDiagnostics(): readonly GraphDiagnostic[];
  diagnose(): readonly GraphDiagnostic[];
  summary(): GraphSummary;
}

// Guardrails
export interface ResolvedTarget {
  readonly changeId: string;
  readonly commitId?: string;
  readonly immutable?: boolean;
  readonly divergent?: boolean;
  /** Contained in ::trunk(). */
  readonly inTrunk?: boolean;
}

export type GuardrailAction =
  | {
      readonly type: 'mutate';
      readonly targetChanges: readonly (ChangeId | string)[];
      readonly command: string;
      /** The jj argv; lets guards see exactly what the command rewrites. */
      readonly args?: readonly string[];
      readonly resolvedTargets?: readonly ResolvedTarget[];
      readonly bookmarks?: readonly { readonly names: readonly string[]; readonly targetChanges: readonly string[] }[];
      readonly ignoreImmutable?: boolean;
      readonly recovery?: boolean;
    }
  | { readonly type: 'bookmark'; readonly bookmarks?: readonly string[]; readonly targetChanges: readonly (ChangeId | string)[] }
  | { readonly type: 'push'; readonly targetChanges: readonly (ChangeId | string)[]; readonly bookmark?: string }
  | { readonly type: 'git-interop'; readonly rawGitCommand: string }
  | { readonly type: 'workspace-add'; readonly reason?: 'switch-branch' | 'parallel-build-or-agent' };

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
export const preflightGuard: GuardrailRule;
export const immutableBedrockGuard: GuardrailRule;
export const divergenceGuard: GuardrailRule;
export const megamergeFence: GuardrailRule;
export const publishingGate: GuardrailRule;
export const colocatedGitGuard: GuardrailRule;
export const workspaceDisciplineGuard: GuardrailRule;
export const changeIdAddressingGuard: GuardrailRule;

export function isReadOnlyGitCommand(rawGitCommand: string): boolean;
/** The revisions a jj argv rewrites (see `describeMutation`). */
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
    /** Pair new APIs with a consumer: adds an API nothing in the change calls or tests. */
    readonly apiWithoutConsumer?: NoulAnswer;
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

export interface ForgeAdapter {
  readonly name: string;
  readonly modelAlignment: string;
  readonly rewritePropagation: string;
  readonly strengths: readonly string[];
  readonly caveats: readonly string[];
  readonly needsBookmark: boolean;
  /** Uploads a whole stack from its top change. */
  readonly stackAware: boolean;
  publish(changeId: ChangeId | string): string;
}

export const FORGE_ADAPTERS: Readonly<Record<ForgeKind, ForgeAdapter>>;

export const JjrPatterns: {
  squashWorkflow(description: string): JjrRecipe;
  editWorkflow(changeId: ChangeId | string, prerequisite?: string | null): JjrRecipe;
  tidyFirstBelow(behavioralChangeId: ChangeId | string, description: string): JjrRecipe;
  characterizationTestsBelow(refactorChangeId: ChangeId | string, area: string, testCommand?: string): JjrRecipe;
  verifyRedTest(
    implFiles: readonly string[],
    opts?: { changeId?: ChangeId | string; description?: string; testCommand?: string },
  ): JjrRecipe;
  branchByAbstraction(seamName: string): JjrRecipe;
  expandContract(subject: string, opts?: { from?: string; to?: string }): JjrRecipe;
  isolateActivation(stackHeadChangeId: ChangeId | string, flag: string): JjrRecipe;
  localMegamerge(arms: readonly (ChangeId | string)[], prefix?: string): JjrRecipe;
  absorbFixups(pollutedMegamergeId?: ChangeId | string | null): JjrRecipe;
  extractSharedPrimitive(
    arms: readonly (ChangeId | string)[],
    description: string,
    opts?: { from?: string; paths?: readonly string[] },
  ): JjrRecipe;
  resolveConflictCleanly(conflictedChangeId: ChangeId | string): JjrRecipe;
  stackValidation(range?: string, testCommand?: string): JjrRecipe;
  composeAgentWorkspaces(workspaces: readonly string[], prefix?: string): JjrRecipe;
  postMergeConvergence(includeParkedSiblings?: boolean): JjrRecipe;
  publishCommand(forge: ForgeKind, changeId: ChangeId | string): string;
};

export const SDLC_LIFECYCLE: readonly {
  readonly phase: 1 | 2 | 3 | 4 | 5 | 6;
  readonly name: string;
  readonly discipline: string;
  readonly recipes: readonly string[];
}[];

export function planTimeTravelRecovery(params: {
  scope: 'single-change' | 'repo-wide' | 'undo';
  targetOpId?: OpId | string;
  targetChangeId?: ChangeId | string;
  targetEvologCommit?: CommitId | string;
  /** Name the earlier version as `<change>/<offset>` instead of by commit id. */
  targetEvologOffset?: number;
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
  planMutation(graph: JjrGraph, targetChanges: readonly (ChangeId | string)[], command: string, args?: readonly string[] | null): {
    readonly command: string;
    readonly guardResult: GuardrailResult;
    readonly blocked: boolean;
  };
  planBookmark(graph: JjrGraph, names: string | readonly string[], targetChange: ChangeId | string): {
    readonly command: string;
    readonly guardResult: GuardrailResult;
    readonly blocked: boolean;
  };
  planLayeredPublish(graph: JjrGraph, head: ChangeId | string, opts?: { forge?: ForgeKind }): LayeredPublishPlan;
  verifyStack(opts?: { range?: string; revset?: string }): Promise<StackVerification>;
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

export interface LayeredPublishPlan {
  readonly forge: ForgeKind;
  readonly adapter: { readonly name: string; readonly modelAlignment: string; readonly caveats: readonly string[] };
  readonly head: ChangeId;
  readonly layers: readonly {
    readonly changeId: ChangeId;
    readonly commitId: CommitId;
    readonly title: string;
    readonly publishable: boolean;
    readonly reasons: readonly string[];
    readonly warnings: readonly string[];
    readonly command: string | null;
  }[];
  readonly publish: readonly ChangeId[];
  readonly keepLocal: readonly ChangeId[];
  readonly commands: readonly string[];
}

/** Result of jj-graph's POST /api/jjr/verify. */
export interface StackVerification {
  readonly op: string;
  readonly range: string;
  readonly command: string | null;
  readonly formatter: { readonly configured: boolean; readonly fixed: number; readonly checked: number; readonly error: string | null };
  readonly results: readonly {
    readonly changeId: ChangeId;
    readonly commitId: CommitId;
    readonly title: string;
    readonly state: VerificationState;
    readonly formatted: boolean | null;
    readonly testsPass: boolean | null;
    readonly unformattedFiles: readonly string[];
    readonly output: string;
  }[];
  readonly skipped: number;
  readonly summary: { readonly green: number; readonly red: number; readonly unknown: number };
  readonly hint: string | null;
}

// Portable UI ViewModels & Adapters
export function buildDagGraphViewModel(graph: JjrGraph, selectedChangeId?: ChangeId | string | null): Record<string, unknown>;
export function buildGuardrailBanner(decisions: readonly GuardrailDecision[]): Record<string, unknown>;
export function buildDependencyGate(params: { baseLabel: string; childLabel: string; verdict: DependencyVerdict; source?: string }): Record<string, unknown>;
export function buildTriageCard(changeId: ChangeId | string, triageResult: ChangeTriageResult): Record<string, unknown>;
export function buildTimeTravelScrubber(params: { axis: 'evolog' | 'op-log'; entries: readonly unknown[]; activeIndex: number; plan: ReturnType<typeof planTimeTravelRecovery> }): Record<string, unknown>;
export function buildNamingAssistant(suggestion: NamingSuggestion, accepted?: boolean): Record<string, unknown>;
export function buildPreflightPanel(preflight: PreflightFacts | null, diagnostics?: readonly GraphDiagnostic[]): Record<string, unknown>;
export function buildPublishPlan(plan: LayeredPublishPlan): Record<string, unknown>;

export const TUI_KEYBINDINGS: Readonly<Record<string, string>>;
export function renderDagTui(vm: Record<string, unknown>, useColor?: boolean): string;
export function renderGuardrailBannerTui(vm: Record<string, unknown>, useColor?: boolean): string;
export function renderDependencyGateTui(vm: Record<string, unknown>): string;
export function renderTriageTui(vm: Record<string, unknown>): string;
export function renderNamingAssistantTui(vm: Record<string, unknown>): string;
export function renderTimeTravelTui(vm: Record<string, unknown>): string;
export function renderPreflightTui(vm: Record<string, unknown>): string;
export function renderPublishPlanTui(vm: Record<string, unknown>): string;

export function toGuiDagRows(vm: Record<string, unknown>): readonly Record<string, unknown>[];
export function toGuiAlertProps(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiDependencyCard(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiTriageProps(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiTimeTravelProps(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiPreflightProps(vm: Record<string, unknown>): Record<string, unknown>;
export function toGuiPublishPlanRows(vm: Record<string, unknown>): readonly Record<string, unknown>[];
