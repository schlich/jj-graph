//! `JjrGraph`: an in-memory model of a living Jujutsu revision DAG.
//!
//! Built from jj-graph's revision nodes (`JjrGraph::from_nodes`) or
//! constructed directly, it keeps the immutable and mutable zones apart,
//! knows about conflicts and divergence, applies the Two-Part Dependency
//! Test, classifies the canonical DAG shapes, and reports topological
//! diagnostics.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::OnceLock;

use indexmap::IndexMap;
use indexmap::IndexSet;
use serde::Deserialize;
use serde::Serialize;

use crate::types::CanonicalShape;
use crate::types::ChangeIntent;
use crate::types::DagShape;
use crate::types::ForgeKind;
use crate::types::IntentInfo;
use crate::types::JjrRepoConfig;
use crate::types::MergeSameChange;
use crate::types::VerificationState;
use crate::types::VerificationStatus;
use crate::types::Zone;
use crate::types::canonical_shape;
use crate::types::infer_intent_fallback;
use crate::types::is_code_path;
use crate::types::is_test_path;
use crate::types::short;
use crate::types::verification_state;

/// The commit id of jj's root commit.
pub const ROOT_COMMIT: &str = "0000000000000000000000000000000000000000";
/// Loose `refs/jj/keep/*` refs above which `jj util gc` is worth running.
const GC_KEEP_REF_THRESHOLD: usize = 5000;
/// An activation switch touching more files than this is carrying plumbing.
const ACTIVATION_MAX_FILES: usize = 3;

// ---------------------------------------------------------------------------
// Revision nodes: the shape jj-graph's server reads from the repository and
// sends to the web UI.

/// A local bookmark on a revision; `conflict` when it points at several commits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeBookmark {
    pub name: String,
    #[serde(default)]
    pub conflict: bool,
}

/// One parent edge of a drawn revision. A parent outside the drawn revset
/// is replaced by its nearest drawn ancestors, marked `indirect`; with none,
/// the edge is a stub (`to: None`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub to: Option<String>,
    pub parent: String,
    pub indirect: bool,
}

/// One revision as jj-graph draws it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GraphNode {
    /// Commit id.
    pub id: String,
    /// Change id.
    pub change: String,
    /// Shortest unique change-id prefix.
    pub prefix: String,
    /// Parent commit ids.
    pub parents: Vec<String>,
    pub description: String,
    pub author: String,
    /// Committer timestamp, RFC 3339.
    pub time: String,
    pub bookmarks: Vec<NodeBookmark>,
    /// Remote bookmarks as `name@remote`.
    pub remotes: Vec<String>,
    pub tags: Vec<String>,
    /// The working copy of the workspace jj-graph serves.
    pub wc: bool,
    pub immutable: bool,
    pub conflict: bool,
    pub empty: bool,
    pub divergent: bool,
    pub hidden: bool,
    /// Workspaces whose working copy this is.
    pub workspaces: Vec<String>,
    /// Number of changed files (0 for immutable revisions).
    pub files: usize,
    /// Changed paths (empty for immutable revisions).
    pub paths: Vec<String>,
    #[serde(rename = "conflictedPaths", skip_serializing_if = "Vec::is_empty")]
    pub conflicted_paths: Vec<String>,
    pub edges: Vec<Edge>,
}

// ---------------------------------------------------------------------------
// Pre-flight facts.

/// A revision as a pre-flight check resolved it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightRow {
    pub change_id: String,
    pub commit_id: String,
    pub immutable: bool,
}

/// Where `trunk()` resolves, or why it does not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrunkFact {
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub immutable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_root: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TrunkFact {
    pub fn resolved(row: PreflightRow) -> Self {
        let is_root = row.commit_id == ROOT_COMMIT;
        Self {
            resolved: true,
            change_id: Some(row.change_id),
            commit_id: Some(row.commit_id),
            immutable: Some(row.immutable),
            is_root: Some(is_root),
            error: None,
        }
    }

    pub fn unresolved(error: impl Into<String>) -> Self {
        Self {
            resolved: false,
            error: Some(error.into()),
            ..Self::default()
        }
    }

    pub fn is_root(&self) -> bool {
        self.is_root == Some(true)
    }

    pub fn change_id(&self) -> &str {
        self.change_id.as_deref().unwrap_or("")
    }
}

/// Where `immutable_heads()` resolves, or why it does not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImmutableHeadsFact {
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heads: Option<Vec<PreflightRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ImmutableHeadsFact {
    pub fn resolved(heads: Vec<PreflightRow>) -> Self {
        Self {
            resolved: true,
            heads: Some(heads),
            error: None,
        }
    }

    pub fn unresolved(error: impl Into<String>) -> Self {
        Self {
            resolved: false,
            heads: None,
            error: Some(error.into()),
        }
    }
}

/// A Git feature in use that jj does not support.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCompatIssue {
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_command: Option<String>,
}

/// Facts a pre-flight check gathered from the repository.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PreflightFacts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    pub trunk: TrunkFact,
    pub immutable_heads: ImmutableHeadsFact,
    /// Mutable divergent change ids, including ones outside the loaded revset.
    pub divergent: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_same_change: Option<MergeSameChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge: Option<ForgeKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colocated: Option<bool>,
    pub remotes: Vec<String>,
    pub git_compat: Vec<GitCompatIssue>,
    pub keep_refs: usize,
}

// ---------------------------------------------------------------------------
// Changes.

/// Whether a snapshot's tree has unresolved conflicts, and where.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TreeConflict {
    pub is_conflicted: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub conflicted_paths: Vec<String>,
}

/// One snapshot of a change.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitSnapshot {
    pub commit_id: String,
    pub change_id: String,
    pub parent_commits: Vec<String>,
    pub is_empty: bool,
    pub conflict: TreeConflict,
    pub author: String,
    pub timestamp: String,
    pub touched_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_count: Option<usize>,
    pub description: String,
}

/// A change: its identity, current snapshot, place in the graph and what
/// is known about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JjrChange {
    pub change_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    pub current_commit: CommitSnapshot,
    pub zone: Zone,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub children: Vec<String>,
    #[serde(default)]
    pub bookmarks: Vec<String>,
    #[serde(default)]
    pub remotes: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Workspaces whose working copy is this change (`<name>@`).
    #[serde(default)]
    pub workspaces: Vec<String>,
    #[serde(default)]
    pub is_working_copy: bool,
    #[serde(default)]
    pub is_hidden: bool,
    pub intent: ChangeIntent,
    #[serde(default = "VerificationStatus::unknown")]
    pub verification: VerificationStatus,
    #[serde(default)]
    pub is_divergent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divergent_commits: Option<Vec<String>>,
}

impl JjrChange {
    /// The first line of the description, or `(no description)`.
    pub fn title(&self) -> &str {
        match self.current_commit.description.lines().next() {
            Some(line) if !line.is_empty() => line,
            _ => "(no description)",
        }
    }

    pub fn is_conflicted(&self) -> bool {
        self.current_commit.conflict.is_conflicted
    }

    pub fn is_mutable(&self) -> bool {
        self.zone == Zone::Mutable
    }
}

// ---------------------------------------------------------------------------
// Diagnostics.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "info",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticCode {
    DivergentChange,
    UnorderedStructuralAboveBehavioral,
    MegamergeWithBookmark,
    MegamergeNotEmpty,
    MegamergeAsWorkingCopy,
    ConflictInPublishable,
    ConflictedChange,
    LossyMergeConfig,
    EmptyNonBlueprintChange,
    EditingBookmarkTip,
    ActivationNotOnTop,
    ActivationNotIsolated,
    BehaviorWithoutTests,
    RootBehindTrunk,
    DeepStack,
    PreflightUnresolved,
    PreflightNoBedrock,
    PreflightTrunkIsRoot,
    PreflightTrunkNotImmutable,
    GitCompat,
    GcRecommended,
}

impl DiagnosticCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DivergentChange => "DIVERGENT_CHANGE",
            Self::UnorderedStructuralAboveBehavioral => "UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL",
            Self::MegamergeWithBookmark => "MEGAMERGE_WITH_BOOKMARK",
            Self::MegamergeNotEmpty => "MEGAMERGE_NOT_EMPTY",
            Self::MegamergeAsWorkingCopy => "MEGAMERGE_AS_WORKING_COPY",
            Self::ConflictInPublishable => "CONFLICT_IN_PUBLISHABLE",
            Self::ConflictedChange => "CONFLICTED_CHANGE",
            Self::LossyMergeConfig => "LOSSY_MERGE_CONFIG",
            Self::EmptyNonBlueprintChange => "EMPTY_NON_BLUEPRINT_CHANGE",
            Self::EditingBookmarkTip => "EDITING_BOOKMARK_TIP",
            Self::ActivationNotOnTop => "ACTIVATION_NOT_ON_TOP",
            Self::ActivationNotIsolated => "ACTIVATION_NOT_ISOLATED",
            Self::BehaviorWithoutTests => "BEHAVIOR_WITHOUT_TESTS",
            Self::RootBehindTrunk => "ROOT_BEHIND_TRUNK",
            Self::DeepStack => "DEEP_STACK",
            Self::PreflightUnresolved => "PREFLIGHT_UNRESOLVED",
            Self::PreflightNoBedrock => "PREFLIGHT_NO_BEDROCK",
            Self::PreflightTrunkIsRoot => "PREFLIGHT_TRUNK_IS_ROOT",
            Self::PreflightTrunkNotImmutable => "PREFLIGHT_TRUNK_NOT_IMMUTABLE",
            Self::GitCompat => "GIT_COMPAT",
            Self::GcRecommended => "GC_RECOMMENDED",
        }
    }
}

impl std::fmt::Display for DiagnosticCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A finding about the graph, with a fix to dry-run when there is one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDiagnostic {
    pub severity: Severity,
    pub code: DiagnosticCode,
    pub message: String,
    pub affected_changes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_command: Option<String>,
}

impl GraphDiagnostic {
    fn new(
        severity: Severity,
        code: DiagnosticCode,
        message: String,
        affected_changes: Vec<String>,
    ) -> Self {
        Self {
            severity,
            code,
            message,
            affected_changes,
            suggested_args: None,
            suggested_command: None,
        }
    }

    fn args<S: Into<String>>(mut self, args: impl IntoIterator<Item = S>) -> Self {
        self.suggested_args = Some(args.into_iter().map(Into::into).collect());
        self
    }

    fn command(mut self, command: impl Into<String>) -> Self {
        self.suggested_command = Some(command.into());
        self
    }
}

/// A compact health summary for status bars, API payloads and banners.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSummary {
    pub total_changes: usize,
    pub mutable_count: usize,
    pub immutable_count: usize,
    pub mutable_roots_count: usize,
    pub divergent_count: usize,
    pub conflicted_count: usize,
    pub megamerge_count: usize,
    pub verified_green_count: usize,
    pub shape: DagShape,
    pub canonical_shape: CanonicalShape,
    pub resting: bool,
    pub diagnostics_count: usize,
    pub errors: usize,
    pub warnings: usize,
    pub info: usize,
    pub status: GraphStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphStatus {
    Clean,
    Attention,
    Blocked,
}

impl GraphStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Attention => "attention",
            Self::Blocked => "blocked",
        }
    }
}

// ---------------------------------------------------------------------------
// The Two-Part Dependency Test.

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct DependencyThreshold {
    pub high: Option<f64>,
    pub low: Option<f64>,
}

/// What is known about whether `child` depends on `base`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DependencyAssessment {
    pub base: String,
    pub child: String,
    pub child_causally_depends_on_base: Option<bool>,
    pub base_independently_reviewable: Option<bool>,
    pub causal_probability: Option<f64>,
    pub reviewability_probability: Option<f64>,
    pub threshold: Option<DependencyThreshold>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DependencyOutcome {
    Stack,
    Parallelize,
    Collapse,
    Confirm,
}

impl DependencyOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stack => "stack",
            Self::Parallelize => "parallelize",
            Self::Collapse => "collapse",
            Self::Confirm => "confirm",
        }
    }
}

/// What to do with a pair of stacked changes, with the jj command for it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyVerdict {
    pub outcome: DependencyOutcome,
    pub base: String,
    pub child: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causal_probability: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewability_probability: Option<f64>,
    pub reason: String,
    pub suggested_args: Option<Vec<String>>,
    pub suggested_command: Option<String>,
}

// ---------------------------------------------------------------------------
// The graph.

/// Options for [`JjrGraph::from_nodes`].
#[derive(Clone, Debug, Default)]
pub struct FromNodesOptions {
    pub config: JjrRepoConfig,
    /// Intents by change id; the rest are inferred offline.
    pub intents: HashMap<String, ChangeIntent>,
    /// Verification records by change id, for the snapshots shown.
    pub verifications: HashMap<String, VerificationStatus>,
    pub preflight: Option<PreflightFacts>,
}

/// A mutable parent-child pair, eligible for the Two-Part Dependency Test.
#[derive(Clone, Copy, Debug)]
pub struct MutableEdge<'a> {
    pub base: &'a JjrChange,
    pub child: &'a JjrChange,
}

#[derive(Debug, thiserror::Error)]
#[error("Change {0} not found in active JjrGraph.")]
pub struct ChangeNotFound(pub String);

/// The revision DAG, keyed by change id.
#[derive(Debug)]
pub struct JjrGraph {
    pub config: JjrRepoConfig,
    /// Pre-flight facts (trunk(), immutable_heads(), Git compatibility), or
    /// `None` when no check ran.
    pub preflight: Option<PreflightFacts>,
    by_change: IndexMap<String, JjrChange>,
    by_commit: HashMap<String, JjrChange>,
    children: HashMap<String, IndexSet<String>>,
    trunk_ancestry: OnceLock<HashSet<String>>,
}

fn strip_parens(expr: &str) -> &str {
    let mut s = expr.trim();
    while s.starts_with('(') && s.ends_with(')') {
        let bytes = s.as_bytes();
        let mut depth = 0i32;
        let mut balanced = true;
        for &b in &bytes[..bytes.len() - 1] {
            if b == b'(' {
                depth += 1;
            } else if b == b')' {
                depth -= 1;
            }
            if depth == 0 {
                balanced = false;
                break;
            }
        }
        if !balanced {
            break;
        }
        s = s[1..s.len() - 1].trim();
    }
    s
}

fn is_symbol(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '@' | '-'))
}

impl JjrGraph {
    /// A graph of `changes`. When several share a change id, the working
    /// copy (or the first one) is the change's primary entry and all of them
    /// are marked divergent.
    pub fn new(
        changes: Vec<JjrChange>,
        config: JjrRepoConfig,
        preflight: Option<PreflightFacts>,
    ) -> Self {
        let mut by_change: IndexMap<String, JjrChange> = IndexMap::new();
        let mut by_commit: HashMap<String, JjrChange> = HashMap::new();
        let mut versions: IndexMap<String, Vec<String>> = IndexMap::new();
        for c in changes {
            versions
                .entry(c.change_id.clone())
                .or_default()
                .push(c.current_commit.commit_id.clone());
            if !c.current_commit.commit_id.is_empty() {
                by_commit.insert(c.current_commit.commit_id.clone(), c.clone());
            }
            let replace = !by_change.contains_key(&c.change_id) || c.is_working_copy;
            if replace {
                by_change.insert(c.change_id.clone(), c);
            }
        }
        // Several visible commits sharing a change id are divergent.
        for (change_id, commits) in versions {
            if commits.len() > 1
                && let Some(primary) = by_change.get_mut(&change_id)
            {
                primary.is_divergent = true;
                primary.divergent_commits = Some(commits);
            }
        }
        let mut children: HashMap<String, IndexSet<String>> = HashMap::new();
        for c in by_change.values() {
            for p in &c.parents {
                children
                    .entry(p.clone())
                    .or_default()
                    .insert(c.change_id.clone());
            }
            for ch in &c.children {
                children
                    .entry(c.change_id.clone())
                    .or_default()
                    .insert(ch.clone());
            }
        }
        Self {
            config,
            preflight,
            by_change,
            by_commit,
            children,
            trunk_ancestry: OnceLock::new(),
        }
    }

    /// A graph of jj-graph's revision nodes, as `/api/state` returns them.
    pub fn from_nodes(nodes: &[GraphNode], options: FromNodesOptions) -> Self {
        let FromNodesOptions {
            config,
            intents,
            verifications,
            preflight,
        } = options;
        // Index commit id -> node so parent commit ids resolve to change ids.
        let mut commit_to_node: HashMap<&str, &GraphNode> = HashMap::new();
        for n in nodes {
            commit_to_node.insert(n.id.as_str(), n);
        }
        let mut children_by_change: HashMap<&str, Vec<String>> = HashMap::new();
        for n in nodes {
            for p in &n.parents {
                if let Some(pn) = commit_to_node.get(p.as_str()) {
                    let list = children_by_change.entry(pn.change.as_str()).or_default();
                    if !list.contains(&n.change) {
                        list.push(n.change.clone());
                    }
                }
            }
        }
        let changes = nodes
            .iter()
            .map(|n| {
                let parent_nodes: Vec<&GraphNode> = n
                    .parents
                    .iter()
                    .filter_map(|p| commit_to_node.get(p.as_str()).copied())
                    .collect();
                let mut parents: Vec<String> = Vec::new();
                for p in &parent_nodes {
                    if !parents.contains(&p.change) {
                        parents.push(p.change.clone());
                    }
                }
                let mutable_parent_count = parent_nodes.iter().filter(|p| !p.immutable).count();
                let intent = intents.get(&n.change).copied().unwrap_or_else(|| {
                    infer_intent_fallback(&IntentInfo {
                        description: &n.description,
                        is_empty: n.empty,
                        is_working_copy: n.wc,
                        mutable_parent_count,
                        touched_paths: &n.paths,
                        megamerge_prefix: Some(&config.megamerge_prefix),
                    })
                });
                JjrChange {
                    change_id: n.change.clone(),
                    prefix: Some(if n.prefix.is_empty() {
                        n.change.chars().take(4).collect()
                    } else {
                        n.prefix.clone()
                    }),
                    current_commit: CommitSnapshot {
                        commit_id: n.id.clone(),
                        change_id: n.change.clone(),
                        parent_commits: n.parents.clone(),
                        is_empty: n.empty,
                        conflict: TreeConflict {
                            is_conflicted: n.conflict,
                            conflicted_paths: if n.conflict {
                                n.conflicted_paths.clone()
                            } else {
                                Vec::new()
                            },
                        },
                        author: n.author.clone(),
                        timestamp: n.time.clone(),
                        touched_paths: n.paths.clone(),
                        files_count: Some(n.files),
                        description: n.description.clone(),
                    },
                    zone: if n.immutable {
                        Zone::Immutable
                    } else {
                        Zone::Mutable
                    },
                    parents,
                    children: children_by_change
                        .get(n.change.as_str())
                        .cloned()
                        .unwrap_or_default(),
                    bookmarks: n.bookmarks.iter().map(|b| b.name.clone()).collect(),
                    remotes: n.remotes.clone(),
                    tags: n.tags.clone(),
                    workspaces: n.workspaces.clone(),
                    is_working_copy: n.wc,
                    is_hidden: n.hidden,
                    intent,
                    // Verification is per snapshot: without a record for this commit, nothing is known.
                    verification: verifications
                        .get(&n.change)
                        .cloned()
                        .unwrap_or_else(VerificationStatus::unknown),
                    is_divergent: n.divergent,
                    divergent_commits: n.divergent.then(|| vec![n.id.clone()]),
                }
            })
            .collect();
        Self::new(changes, config, preflight)
    }

    pub fn get(&self, change_id: &str) -> Option<&JjrChange> {
        self.by_change.get(change_id)
    }

    /// The change version whose current commit is `commit_id`.
    pub fn get_by_commit(&self, commit_id: &str) -> Option<&JjrChange> {
        self.by_commit.get(commit_id)
    }

    /// A change by change id, then by commit id.
    pub fn get_any(&self, id: &str) -> Option<&JjrChange> {
        self.get(id).or_else(|| self.get_by_commit(id))
    }

    pub fn require(&self, change_id: &str) -> Result<&JjrChange, ChangeNotFound> {
        self.get(change_id)
            .ok_or_else(|| ChangeNotFound(change_id.to_owned()))
    }

    /// Every change, in the order the graph was built.
    pub fn all(&self) -> Vec<&JjrChange> {
        self.by_change.values().collect()
    }

    pub fn mutable(&self) -> Vec<&JjrChange> {
        self.by_change
            .values()
            .filter(|c| c.zone == Zone::Mutable)
            .collect()
    }

    pub fn immutable(&self) -> Vec<&JjrChange> {
        self.by_change
            .values()
            .filter(|c| c.zone == Zone::Immutable)
            .collect()
    }

    pub fn working_copy(&self) -> Option<&JjrChange> {
        self.by_change.values().find(|c| c.is_working_copy)
    }

    pub fn divergent(&self) -> Vec<&JjrChange> {
        self.by_change.values().filter(|c| c.is_divergent).collect()
    }

    pub fn conflicted(&self) -> Vec<&JjrChange> {
        self.by_change
            .values()
            .filter(|c| c.is_conflicted())
            .collect()
    }

    /// Change ids of the loaded children of a change.
    pub fn children_of(&self, change_id: &str) -> Vec<String> {
        self.children
            .get(change_id)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Resolve a small revset against the loaded graph: `@`, `<workspace>@`,
    /// bookmark and tag names, change-id and commit-id prefixes, wrapped in
    /// parentheses and followed by any number of `-` (parents) and `+`
    /// (children). Anything richer (functions, `::`, `|`) resolves to
    /// nothing: jj-graph resolves those with jj itself.
    pub fn resolve(&self, revset: &str) -> Vec<&JjrChange> {
        if revset.trim().is_empty() {
            return Vec::new();
        }
        let mut expr = strip_parens(revset);
        let mut ops: Vec<char> = Vec::new();
        while expr.chars().count() >= 2 && (expr.ends_with('+') || expr.ends_with('-')) {
            ops.insert(0, expr.chars().last().unwrap());
            expr = strip_parens(&expr[..expr.len() - 1]);
        }
        let mut nodes = self.resolve_symbol(expr);
        for op in ops {
            let mut next: IndexMap<&str, &JjrChange> = IndexMap::new();
            for n in nodes {
                let ids = if op == '-' {
                    n.parents.clone()
                } else {
                    self.children_of(&n.change_id)
                };
                for id in ids {
                    if let Some(node) = self.by_change.get(&id) {
                        next.insert(node.change_id.as_str(), node);
                    }
                }
            }
            nodes = next.into_values().collect();
        }
        nodes
    }

    fn resolve_symbol(&self, sym: &str) -> Vec<&JjrChange> {
        if sym == "@" {
            return self.working_copy().into_iter().collect();
        }
        if !is_symbol(sym) {
            return Vec::new();
        }
        if sym.len() > 1
            && let Some(ws) = sym.strip_suffix('@')
        {
            return self
                .by_change
                .values()
                .filter(|c| c.workspaces.iter().any(|w| w == ws))
                .collect();
        }
        // Like jj, names win over id prefixes.
        let by_name: Vec<&JjrChange> = self
            .by_change
            .values()
            .filter(|c| c.bookmarks.iter().any(|b| b == sym) || c.tags.iter().any(|t| t == sym))
            .collect();
        if !by_name.is_empty() {
            return by_name;
        }
        let lower = sym.to_lowercase();
        if lower.chars().all(|c| ('k'..='z').contains(&c)) {
            let hits: Vec<&JjrChange> = self
                .by_change
                .values()
                .filter(|c| c.change_id.starts_with(&lower))
                .collect();
            return if hits.len() == 1 { hits } else { Vec::new() };
        }
        if lower.chars().all(|c| c.is_ascii_hexdigit()) {
            let hits: Vec<&JjrChange> = self
                .by_commit
                .iter()
                .filter(|(cid, _)| cid.starts_with(&lower))
                .map(|(_, c)| c)
                .collect();
            return if hits.len() == 1 {
                vec![self.by_change.get(&hits[0].change_id).unwrap_or(hits[0])]
            } else {
                Vec::new()
            };
        }
        Vec::new()
    }

    /// The loaded `trunk()` change, when a pre-flight resolved it to
    /// something other than `root()`.
    pub fn trunk(&self) -> Option<&JjrChange> {
        let t = &self.preflight.as_ref()?.trunk;
        if !t.resolved || t.is_root() {
            return None;
        }
        self.get(t.change_id())
            .or_else(|| t.commit_id.as_deref().and_then(|id| self.get_by_commit(id)))
    }

    /// Whether a change is shared bedrock: immutable, or an ancestor of
    /// `trunk()` even when a misconfigured `immutable_heads()` left it mutable.
    pub fn is_bedrock(&self, change: &JjrChange) -> bool {
        if change.zone == Zone::Immutable {
            return true;
        }
        let ancestry = self.trunk_ancestry.get_or_init(|| {
            let mut set = HashSet::new();
            let mut stack: Vec<String> = self
                .trunk()
                .map(|t| vec![t.change_id.clone()])
                .unwrap_or_default();
            while let Some(id) = stack.pop() {
                if !set.insert(id.clone()) {
                    continue;
                }
                if let Some(c) = self.by_change.get(&id) {
                    stack.extend(c.parents.iter().cloned());
                }
            }
            set
        });
        ancestry.contains(&change.change_id)
    }

    /// The empty, undescribed working copy: the scratchpad, not a unit of work.
    pub fn is_scratchpad(&self, change: &JjrChange) -> bool {
        change.is_working_copy
            && change.current_commit.is_empty
            && change.current_commit.description.trim().is_empty()
            && change.parents.len() <= 1
    }

    /// Mutable changes whose parents are all immutable (or not loaded).
    pub fn mutable_roots(&self) -> Vec<&JjrChange> {
        self.mutable()
            .into_iter()
            .filter(|c| {
                c.parents.iter().all(|p| {
                    self.by_change
                        .get(p)
                        .is_none_or(|p| p.zone == Zone::Immutable)
                })
            })
            .collect()
    }

    /// Whether a change is a local composition megamerge: tagged with
    /// `config.megamerge_prefix`, of intent `megamerge`, or with 2+ mutable parents.
    pub fn is_megamerge(&self, change: &JjrChange) -> bool {
        if change.intent == ChangeIntent::Megamerge {
            return true;
        }
        let desc = change.current_commit.description.trim().to_lowercase();
        let prefix = self.config.megamerge_prefix.to_lowercase();
        if !prefix.is_empty() && desc.starts_with(&prefix) {
            return true;
        }
        change
            .parents
            .iter()
            .filter(|p| {
                self.by_change
                    .get(*p)
                    .is_some_and(|p| p.zone == Zone::Mutable)
            })
            .count()
            >= 2
    }

    /// The mutable ancestors of `target_id` (inclusive) in topological
    /// order: every change comes after its parents, so the result reads
    /// bottom-up the way a stack lands.
    pub fn mutable_ancestors_of(&self, target_id: &str) -> Vec<&JjrChange> {
        let mut found: IndexMap<&str, &JjrChange> = IndexMap::new();
        let mut stack: Vec<&str> = vec![target_id];
        while let Some(id) = stack.pop() {
            if found.contains_key(id) {
                continue;
            }
            let Some(node) = self.by_change.get(id) else {
                continue;
            };
            if node.zone == Zone::Immutable {
                continue;
            }
            found.insert(node.change_id.as_str(), node);
            stack.extend(node.parents.iter().map(String::as_str));
        }
        fn place<'a>(
            id: &str,
            found: &IndexMap<&str, &'a JjrChange>,
            placed: &mut HashSet<String>,
            ordered: &mut Vec<&'a JjrChange>,
        ) {
            if placed.contains(id) {
                return;
            }
            let Some(node) = found.get(id).copied() else {
                return;
            };
            placed.insert(id.to_owned());
            for p in &node.parents {
                place(p, found, placed, ordered);
            }
            ordered.push(node);
        }
        let mut ordered = Vec::new();
        let mut placed = HashSet::new();
        for id in found.keys().rev() {
            place(id, &found, &mut placed, &mut ordered);
        }
        ordered
    }

    /// Direct mutable parent-child pairs.
    pub fn mutable_edges(&self) -> Vec<MutableEdge<'_>> {
        let mut edges = Vec::new();
        for c in self.mutable() {
            for p in &c.parents {
                if let Some(parent) = self.by_change.get(p)
                    && parent.zone == Zone::Mutable
                {
                    edges.push(MutableEdge {
                        base: parent,
                        child: c,
                    });
                }
            }
        }
        edges
    }

    /// Classify the mutable zone as one of the reference's canonical DAG
    /// shapes, or the non-canonical `branching` (one root that forks). The
    /// empty `@` scratchpad is not counted as work.
    pub fn classify_shape(&self) -> DagShape {
        let work: Vec<&JjrChange> = self
            .mutable()
            .into_iter()
            .filter(|c| !self.is_scratchpad(c))
            .collect();
        if work.is_empty() {
            return DagShape::Resting;
        }
        if work.iter().any(|c| self.is_megamerge(c)) {
            return DagShape::Megamerge;
        }
        let in_work: HashSet<&str> = work.iter().map(|c| c.change_id.as_str()).collect();
        let roots = work
            .iter()
            .filter(|c| !c.parents.iter().any(|p| in_work.contains(p.as_str())))
            .count();
        if roots >= 2 {
            return DagShape::Parallel;
        }
        if work.len() == 1 {
            return DagShape::Single;
        }
        let linear = work.iter().all(|c| {
            self.children_of(&c.change_id)
                .iter()
                .filter(|id| in_work.contains(id.as_str()))
                .count()
                <= 1
        });
        if linear {
            DagShape::Stack
        } else {
            DagShape::Branching
        }
    }

    /// The longest chain of mutable work, bottom-up.
    pub fn longest_chain(&self) -> Vec<&JjrChange> {
        let work: Vec<&JjrChange> = self
            .mutable()
            .into_iter()
            .filter(|c| !self.is_scratchpad(c) && !self.is_megamerge(c))
            .collect();
        let in_work: HashSet<&str> = work.iter().map(|c| c.change_id.as_str()).collect();
        fn chain(
            graph: &JjrGraph,
            id: &str,
            in_work: &HashSet<&str>,
            memo: &mut HashMap<String, Vec<String>>,
        ) -> Vec<String> {
            if let Some(found) = memo.get(id) {
                return found.clone();
            }
            memo.insert(id.to_owned(), vec![id.to_owned()]); // cycle guard; a DAG never revisits
            let mut best: Vec<String> = Vec::new();
            if let Some(c) = graph.by_change.get(id) {
                for p in &c.parents {
                    if graph.by_change.contains_key(p) && in_work.contains(p.as_str()) {
                        let sub = chain(graph, p, in_work, memo);
                        if sub.len() > best.len() {
                            best = sub;
                        }
                    }
                }
            }
            best.push(id.to_owned());
            memo.insert(id.to_owned(), best.clone());
            best
        }
        let mut memo = HashMap::new();
        let mut longest: Vec<String> = Vec::new();
        for c in &work {
            let ch = chain(self, &c.change_id, &in_work, &mut memo);
            if ch.len() > longest.len() {
                longest = ch;
            }
        }
        longest
            .iter()
            .filter_map(|id| self.by_change.get(id))
            .collect()
    }

    /// The Two-Part Dependency Test:
    ///  1. Causal necessity: the child cannot compile, pass tests, or make
    ///     sense without the base.
    ///  2. Independent reviewability: the base is self-contained and
    ///     landable without reading the child.
    ///
    /// Calibrated probabilities (TypeSafe Jev `noul` scores in [0, 1]) inside
    /// the ambiguous band give a `confirm` verdict.
    pub fn evaluate_dependency(assessment: &DependencyAssessment) -> DependencyVerdict {
        let base = assessment.base.clone();
        let child = assessment.child.clone();
        let causal = assessment.causal_probability;
        let reviewable = assessment.reviewability_probability;
        let high = assessment.threshold.and_then(|t| t.high).unwrap_or(0.72);
        let low = assessment.threshold.and_then(|t| t.low).unwrap_or(0.28);
        let uncertain = |p: Option<f64>| p.is_some_and(|p| p > low && p < high);

        let depends = assessment
            .child_causally_depends_on_base
            .unwrap_or(causal.unwrap_or(0.5) >= 0.5);
        let independent = assessment
            .base_independently_reviewable
            .unwrap_or(reviewable.unwrap_or(0.5) >= 0.5);
        let verdict = |outcome,
                       reason: String,
                       args: Option<Vec<String>>,
                       command: Option<String>| DependencyVerdict {
            outcome,
            base: base.clone(),
            child: child.clone(),
            causal_probability: causal,
            reviewability_probability: reviewable,
            reason,
            suggested_args: args,
            suggested_command: command,
        };
        let fmt = |p: Option<f64>| p.map_or_else(|| "n/a".to_owned(), |p| format!("{p:.2}"));
        let (b, c) = (short(&base), short(&child));

        if uncertain(causal) || uncertain(reviewable) {
            return verdict(
                DependencyOutcome::Confirm,
                format!(
                    "Calibrated confidence is in the ambiguous band (causal={}, reviewable={}). Confirm dependency intent before rewriting the graph.",
                    fmt(causal),
                    fmt(reviewable)
                ),
                None,
                None,
            );
        }
        if !depends && independent {
            return verdict(
                DependencyOutcome::Parallelize,
                format!(
                    "No causal dependency between {b} and {c}. Linear stacking creates an artificial merge bottleneck."
                ),
                Some(vec!["parallelize".into(), base.clone(), child.clone()]),
                Some(format!("jj parallelize {base} {child}")),
            );
        }
        let collapse_args = || {
            Some(vec![
                "squash".into(),
                "--from".into(),
                child.clone(),
                "--into".into(),
                base.clone(),
            ])
        };
        let collapse_command = || Some(format!("jj squash --from {child} --into {base}"));
        if depends && !independent {
            return verdict(
                DependencyOutcome::Collapse,
                format!("{b} is not independently reviewable without {c} (mutually entangled)."),
                collapse_args(),
                collapse_command(),
            );
        }
        if !depends && !independent {
            return verdict(
                DependencyOutcome::Collapse,
                format!(
                    "{b} is incomplete on its own and {c} does not causally depend on it; consolidate or split along a clean seam."
                ),
                collapse_args(),
                collapse_command(),
            );
        }
        verdict(
            DependencyOutcome::Stack,
            format!("{c} causally depends on {b}, and {b} is independently reviewable."),
            None,
            None,
        )
    }

    /// Diagnostics from the pre-flight check: whether `trunk()` and
    /// `immutable_heads()` resolve, whether `trunk()` is protected, and which
    /// Git features jj does not support are in use.
    pub fn preflight_diagnostics(&self) -> Vec<GraphDiagnostic> {
        let Some(p) = &self.preflight else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if !p.trunk.resolved || !p.immutable_heads.resolved {
            let error = [&p.trunk.error, &p.immutable_heads.error]
                .into_iter()
                .flatten()
                .find(|e| !e.is_empty())
                .map_or("unknown error", String::as_str);
            out.push(
                GraphDiagnostic::new(
                    Severity::Error,
                    DiagnosticCode::PreflightUnresolved,
                    format!("trunk() or immutable_heads() does not resolve ({error}). Without the immutable boundary jjr blocks every rewrite."),
                    Vec::new(),
                )
                .command("jj log -r 'trunk() | immutable_heads()'"),
            );
            return out;
        }
        let heads = p.immutable_heads.heads.as_deref().unwrap_or_default();
        let protects_only_root = heads.iter().all(|h| h.commit_id == ROOT_COMMIT);
        if p.trunk.is_root() && protects_only_root {
            // Without a remote nothing is shared yet, so this is advice, not a warning.
            out.push(
                GraphDiagnostic::new(
                    if p.remotes.is_empty() { Severity::Info } else { Severity::Warning },
                    DiagnosticCode::PreflightNoBedrock,
                    "trunk() resolves to root() and immutable_heads() protects nothing else, so every revision is mutable and shared history has no protection.".into(),
                    Vec::new(),
                )
                .command("jj bookmark track main@origin   # or: jj config set --repo 'revset-aliases.\"trunk()\"' main"),
            );
        } else if p.trunk.is_root() {
            out.push(
                GraphDiagnostic::new(
                    Severity::Info,
                    DiagnosticCode::PreflightTrunkIsRoot,
                    format!(
                        "trunk() resolves to root() (no tracked remote trunk). immutable_heads() still protects {} head(s); recipes that start at trunk() will start at root().",
                        heads.len()
                    ),
                    Vec::new(),
                )
                .command("jj config set --repo 'revset-aliases.\"trunk()\"' main"),
            );
        } else if p.trunk.immutable != Some(true) {
            let id = p.trunk.change_id();
            out.push(
                GraphDiagnostic::new(
                    Severity::Warning,
                    DiagnosticCode::PreflightTrunkNotImmutable,
                    format!(
                        "trunk() ({}) is not in immutable(): immutable_heads() was overridden without it. jjr still treats ::trunk() as bedrock.",
                        short(id)
                    ),
                    if id.is_empty() { Vec::new() } else { vec![id.to_owned()] },
                )
                .command("jj config set --repo 'revset-aliases.\"immutable_heads()\"' 'builtin_immutable_heads()'"),
            );
        }
        for issue in &p.git_compat {
            let mut d = GraphDiagnostic::new(
                Severity::Warning,
                DiagnosticCode::GitCompat,
                issue.message.clone(),
                Vec::new(),
            );
            d.suggested_command = issue.suggested_command.clone();
            out.push(d);
        }
        if p.keep_refs > GC_KEEP_REF_THRESHOLD {
            out.push(
                GraphDiagnostic::new(
                    Severity::Info,
                    DiagnosticCode::GcRecommended,
                    format!("The backing Git repository holds {} refs/jj/keep refs. Compact them periodically.", p.keep_refs),
                    Vec::new(),
                )
                .command("jj util gc"),
            );
        }
        out
    }

    /// Deterministic topological and workflow-hygiene diagnostics across `mutable()`.
    pub fn diagnose(&self) -> Vec<GraphDiagnostic> {
        let mut diagnostics = self.preflight_diagnostics();

        if self.config.merge_same_change == MergeSameChange::Accept {
            diagnostics.push(
                GraphDiagnostic::new(
                    Severity::Info,
                    DiagnosticCode::LossyMergeConfig,
                    "merge.same-change is set to \"accept\" (lossy under round-trip rebases). Prefer \"keep\" for strict invertibility.".into(),
                    Vec::new(),
                )
                .command("jj config set --repo merge.same-change keep"),
            );
        }

        let trunk = self.trunk();
        for c in self.mutable() {
            let id = c.change_id.as_str();
            let s = short(id);
            let is_megamerge = self.is_megamerge(c);
            let is_conflicted = c.is_conflicted();
            let paths = &c.current_commit.touched_paths;

            if c.is_divergent {
                diagnostics.push(
                    GraphDiagnostic::new(
                        Severity::Error,
                        DiagnosticCode::DivergentChange,
                        format!(
                            "Change {s} is divergent ({}+ visible commits share one ChangeId). Resolve before stacking or pushing.",
                            c.divergent_commits.as_ref().map_or(2, Vec::len)
                        ),
                        vec![id.to_owned()],
                    )
                    .command(format!(
                        "jj log -r 'divergent()' # then jj converge --no-interactive -r 'change_id({s})' or jj abandon <commit-id>"
                    )),
                );
            }

            if is_megamerge && !c.bookmarks.is_empty() {
                diagnostics.push(
                    GraphDiagnostic::new(
                        Severity::Error,
                        DiagnosticCode::MegamergeWithBookmark,
                        format!("Local composition megamerge {s} carries bookmark(s) [{}]. Never publish megamerges.", c.bookmarks.join(", ")),
                        vec![id.to_owned()],
                    )
                    .args(["bookmark".to_owned(), "delete".to_owned()].into_iter().chain(c.bookmarks.iter().cloned()))
                    .command(format!("jj bookmark delete {}", c.bookmarks.join(" "))),
                );
            }

            if is_megamerge && !c.current_commit.is_empty && !is_conflicted {
                diagnostics.push(
                    GraphDiagnostic::new(
                        Severity::Info,
                        DiagnosticCode::MegamergeNotEmpty,
                        format!("Megamerge {s} carries its own edits, which can never be published. Route them to the arms that own those lines."),
                        vec![id.to_owned()],
                    )
                    .args(["absorb", "--from", id])
                    .command(format!("jj absorb --from {s}")),
                );
            }

            if is_megamerge && c.is_working_copy {
                diagnostics.push(
                    GraphDiagnostic::new(
                        Severity::Info,
                        DiagnosticCode::MegamergeAsWorkingCopy,
                        format!(
                            "The working copy is the megamerge {s} itself, so edits land in a commit that is never pushed. Work in an empty @ on top and absorb fixups into the arms."
                        ),
                        vec![id.to_owned()],
                    )
                    .args(["new", id])
                    .command(format!("jj new {s}")),
                );
            }

            if c.is_working_copy && !is_megamerge && !c.bookmarks.is_empty() {
                diagnostics.push(
                    GraphDiagnostic::new(
                        Severity::Info,
                        DiagnosticCode::EditingBookmarkTip,
                        format!(
                            "The working copy {s} is the tip of bookmark(s) [{}], so edits land directly on a named branch. Edit in an empty @ on top and squash what is finished.",
                            c.bookmarks.join(", ")
                        ),
                        vec![id.to_owned()],
                    )
                    .args(["new", id])
                    .command(format!("jj new {s}")),
                );
            }

            // Descendants inherit a conflict; flag where it starts (and every bookmarked tip).
            let inherited = c
                .parents
                .iter()
                .any(|p| self.by_change.get(p).is_some_and(JjrChange::is_conflicted));
            if is_conflicted && (!inherited || !c.bookmarks.is_empty()) {
                // Clean resolution pattern: resolve in a child, inspect, squash it down.
                let resolution: Vec<&JjrChange> = self
                    .children_of(id)
                    .iter()
                    .filter_map(|ch| self.by_change.get(ch))
                    .filter(|ch| {
                        ch.zone == Zone::Mutable && !ch.is_conflicted() && !self.is_megamerge(ch)
                    })
                    .collect();
                let fold = if resolution.len() == 1 {
                    Some(resolution[0])
                } else {
                    None
                };
                let bookmarked = !c.bookmarks.is_empty();
                let message = if bookmarked {
                    format!(
                        "Bookmarked change {s} ({}) has an unresolved conflict. Resolve before pushing.",
                        c.bookmarks.join(", ")
                    )
                } else if let Some(f) = fold {
                    format!(
                        "Change {s} is conflicted and its child {} resolves it. Fold the resolution down.",
                        short(&f.change_id)
                    )
                } else {
                    format!(
                        "Change {s} is conflicted. Resolve it in a child commit, inspect the resolution with jj diff, then squash it down."
                    )
                };
                let affected = match fold {
                    Some(f) => vec![id.to_owned(), f.change_id.clone()],
                    None => vec![id.to_owned()],
                };
                let d = GraphDiagnostic::new(
                    if bookmarked {
                        Severity::Warning
                    } else {
                        Severity::Info
                    },
                    if bookmarked {
                        DiagnosticCode::ConflictInPublishable
                    } else {
                        DiagnosticCode::ConflictedChange
                    },
                    message,
                    affected,
                );
                diagnostics.push(match fold {
                    Some(f) => d
                        .args(["squash", "--from", f.change_id.as_str(), "--into", id])
                        .command(format!(
                            "jj squash --from {} --into {s}",
                            short(&f.change_id)
                        )),
                    None => d.args(["new", id]).command(format!(
                        "jj new {s}   # resolve markers here, check jj diff, then jj squash"
                    )),
                });
            }

            // Tidy First?: a structural refactor sitting ABOVE a behavioral change.
            if c.intent == ChangeIntent::Structural {
                for p in &c.parents {
                    if let Some(parent) = self.by_change.get(p)
                        && parent.zone == Zone::Mutable
                        && parent.intent == ChangeIntent::Behavioral
                    {
                        let ps = short(&parent.change_id);
                        diagnostics.push(
                            GraphDiagnostic::new(
                                Severity::Warning,
                                DiagnosticCode::UnorderedStructuralAboveBehavioral,
                                format!(
                                    "Structural refactor {s} sits above behavioral change {ps}. Slip structural tidying beneath behavioral work for low-risk review and revert."
                                ),
                                vec![parent.change_id.clone(), id.to_owned()],
                            )
                            .args(["rebase", "-r", id, "-B", parent.change_id.as_str()])
                            .command(format!("jj rebase -r {s} -B {ps}")),
                        );
                    }
                }
            }

            if c.intent == ChangeIntent::Activation {
                diagnostics.extend(self.activation_diagnostics(c));
            }

            // Empty non-working-copy, non-blueprint commit; an empty merge documents the merge.
            if c.current_commit.is_empty
                && !c.is_working_copy
                && c.intent != ChangeIntent::Blueprint
                && !is_megamerge
                && c.parents.len() < 2
            {
                diagnostics.push(
                    GraphDiagnostic::new(
                        Severity::Info,
                        DiagnosticCode::EmptyNonBlueprintChange,
                        format!(
                            "Change {s} is empty and undescribed (neither @ nor a stack blueprint)."
                        ),
                        vec![id.to_owned()],
                    )
                    .args(["abandon", id])
                    .command(format!("jj abandon {s}")),
                );
            }

            // Bundle tests with behavior: a finished behavioral change carries its tests.
            if c.intent == ChangeIntent::Behavioral
                && !c.is_working_copy
                && !c.current_commit.is_empty
                && !is_megamerge
                && paths.iter().any(|p| is_code_path(p))
                && !paths.iter().any(|p| is_test_path(p))
            {
                let code: Vec<&str> = paths
                    .iter()
                    .filter(|p| is_code_path(p))
                    .take(3)
                    .map(String::as_str)
                    .collect();
                diagnostics.push(GraphDiagnostic::new(
                    Severity::Info,
                    DiagnosticCode::BehaviorWithoutTests,
                    format!(
                        "Behavioral change {s} touches code ({}) but no tests. Bundle its tests in the same change so it is self-verifying and bisectable.",
                        code.join(", ")
                    ),
                    vec![id.to_owned()],
                ));
            }

            // Arms belong on trunk(); after trunk() moves, converge them.
            if let Some(trunk) = trunk
                && !is_megamerge
                && !c.parents.is_empty()
            {
                let parents: Vec<&JjrChange> = c
                    .parents
                    .iter()
                    .filter_map(|p| self.by_change.get(p))
                    .collect();
                let is_root = parents.len() == c.parents.len()
                    && parents.iter().all(|p| p.zone == Zone::Immutable);
                if is_root && !c.parents.contains(&trunk.change_id) {
                    let based_on: Vec<&str> = parents.iter().map(|p| short(&p.change_id)).collect();
                    diagnostics.push(
                        GraphDiagnostic::new(
                            Severity::Info,
                            DiagnosticCode::RootBehindTrunk,
                            format!(
                                "{} {s} is based on {}, not on trunk() ({}). Rebase it to converge.",
                                if c.is_working_copy { "The working copy" } else { "Mutable root" },
                                based_on.join(", "),
                                short(&trunk.change_id)
                            ),
                            vec![id.to_owned()],
                        )
                        .args(["rebase", "-s", id, "-o", "trunk()"])
                        .command(format!("jj rebase -s {s} -o 'trunk()'")),
                    );
                }
            }
        }

        let chain = self.longest_chain();
        if chain.len() > self.config.max_stack_depth
            && let Some(top) = chain.last()
        {
            diagnostics.push(GraphDiagnostic::new(
                Severity::Info,
                DiagnosticCode::DeepStack,
                format!(
                    "A linear stack of {} mutable changes ends at {} (limit {}). Deep stacks are usually horizontal slices; run the Two-Part Dependency Test on their edges and parallelize what does not depend.",
                    chain.len(),
                    short(&top.change_id),
                    self.config.max_stack_depth
                ),
                chain.iter().map(|c| c.change_id.clone()).collect(),
            ));
        }

        // Divergence the loaded revset did not show still blocks.
        let shown: HashSet<&str> = self
            .divergent()
            .iter()
            .map(|c| c.change_id.as_str())
            .collect();
        let hidden: Vec<String> = self
            .preflight
            .as_ref()
            .map(|p| {
                p.divergent
                    .iter()
                    .filter(|id| !shown.contains(id.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !hidden.is_empty() {
            let shorts: Vec<&str> = hidden.iter().map(|id| short(id)).collect();
            diagnostics.push(
                GraphDiagnostic::new(
                    Severity::Error,
                    DiagnosticCode::DivergentChange,
                    format!("Divergent change(s) outside the loaded revisions: {}. Resolve before stacking or pushing.", shorts.join(", ")),
                    hidden.clone(),
                )
                .command("jj log -r 'divergent()'"),
            );
        }
        diagnostics
    }

    fn activation_diagnostics(&self, c: &JjrChange) -> Vec<GraphDiagnostic> {
        let mut out = Vec::new();
        let id = c.change_id.as_str();
        let s = short(id);
        let files = c
            .current_commit
            .files_count
            .unwrap_or(c.current_commit.touched_paths.len());
        if files > ACTIVATION_MAX_FILES {
            out.push(
                GraphDiagnostic::new(
                    Severity::Info,
                    DiagnosticCode::ActivationNotIsolated,
                    format!(
                        "Activation change {s} touches {files} files. Keep the switch tiny and move its plumbing into a change below, so a rollback reverts one switch."
                    ),
                    vec![id.to_owned()],
                )
                .command(format!("jj split -r {s}")),
            );
        }
        let work = |cid: &str| {
            self.by_change.get(cid).is_some_and(|n| {
                n.zone == Zone::Mutable
                    && !self.is_megamerge(n)
                    && !self.is_scratchpad(n)
                    && !n.current_commit.is_empty
            })
        };
        let above: Vec<String> = self
            .children_of(id)
            .into_iter()
            .filter(|ch| work(ch))
            .collect();
        if above.is_empty() {
            return out;
        }
        // Heads of the work stacked above the switch.
        let mut seen: HashSet<String> = HashSet::new();
        let mut heads: Vec<String> = Vec::new();
        let mut stack = above.clone();
        while let Some(cid) = stack.pop() {
            if !seen.insert(cid.clone()) {
                continue;
            }
            let kids: Vec<String> = self
                .children_of(&cid)
                .into_iter()
                .filter(|k| work(k))
                .collect();
            if kids.is_empty() {
                heads.push(cid);
            }
            stack.extend(kids);
        }
        let shorts: Vec<&str> = above.iter().map(|a| short(a)).collect();
        let mut d = GraphDiagnostic::new(
            Severity::Warning,
            DiagnosticCode::ActivationNotOnTop,
            format!(
                "Activation change {s} has implementation work stacked above it ({}). Flip the switch in a top-level change so it lands last and rolls back alone.",
                shorts.join(", ")
            ),
            std::iter::once(id.to_owned())
                .chain(above.iter().cloned())
                .collect(),
        );
        if heads.len() == 1 {
            let head = &heads[0];
            d = d
                .args(["rebase", "-r", id, "-A", head.as_str()])
                .command(format!("jj rebase -r {s} -A {}", short(head)));
        }
        out.push(d);
        out
    }

    /// A compact health summary.
    pub fn summary(&self) -> GraphSummary {
        let diagnostics = self.diagnose();
        let count = |sev: Severity| diagnostics.iter().filter(|d| d.severity == sev).count();
        let (errors, warnings, info) = (
            count(Severity::Error),
            count(Severity::Warning),
            count(Severity::Info),
        );
        let shape = self.classify_shape();
        let mutable = self.mutable();
        GraphSummary {
            total_changes: self.by_change.len(),
            mutable_count: mutable.len(),
            immutable_count: self.immutable().len(),
            mutable_roots_count: self.mutable_roots().len(),
            divergent_count: self.divergent().len(),
            conflicted_count: self.conflicted().len(),
            megamerge_count: mutable.iter().filter(|c| self.is_megamerge(c)).count(),
            verified_green_count: mutable
                .iter()
                .filter(|c| verification_state(Some(&c.verification)) == VerificationState::Green)
                .count(),
            shape,
            canonical_shape: *canonical_shape(shape),
            resting: shape == DagShape::Resting,
            diagnostics_count: diagnostics.len(),
            errors,
            warnings,
            info,
            status: if errors > 0 {
                GraphStatus::Blocked
            } else if warnings > 0 {
                GraphStatus::Attention
            } else {
                GraphStatus::Clean
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(change: &str, id: &str, parents: &[&str], description: &str) -> GraphNode {
        GraphNode {
            id: id.into(),
            change: change.into(),
            parents: parents.iter().map(|p| (*p).to_owned()).collect(),
            description: description.into(),
            paths: vec!["src/lib.rs".into(), "tests/lib.rs".into()],
            files: 2,
            ..Default::default()
        }
    }

    fn trunk_preflight(change: &str, commit: &str) -> PreflightFacts {
        PreflightFacts {
            trunk: TrunkFact::resolved(PreflightRow {
                change_id: change.into(),
                commit_id: commit.into(),
                immutable: true,
            }),
            immutable_heads: ImmutableHeadsFact::resolved(vec![PreflightRow {
                change_id: change.into(),
                commit_id: commit.into(),
                immutable: true,
            }]),
            ..Default::default()
        }
    }

    fn graph(nodes: Vec<GraphNode>) -> JjrGraph {
        JjrGraph::from_nodes(
            &nodes,
            FromNodesOptions {
                preflight: Some(trunk_preflight("zzzztrunk", "aaaa0001")),
                ..Default::default()
            },
        )
    }

    #[test]
    fn stack_shape_and_ancestors() {
        let mut t = node("zzzztrunk", "aaaa0001", &[], "trunk");
        t.immutable = true;
        let g = graph(vec![
            node("kkkkzzzz", "cccc0003", &["bbbb0002"], "feat: three"),
            node("kkkkyyyy", "bbbb0002", &["cccc0001"], "feat: two"),
            node("kkkkxxxx", "cccc0001", &["aaaa0001"], "feat: one"),
            t,
        ]);
        assert_eq!(g.classify_shape(), DagShape::Stack);
        let ids: Vec<&str> = g
            .mutable_ancestors_of("kkkkzzzz")
            .iter()
            .map(|c| c.change_id.as_str())
            .collect();
        assert_eq!(ids, ["kkkkxxxx", "kkkkyyyy", "kkkkzzzz"]);
        assert_eq!(g.longest_chain().len(), 3);
        assert_eq!(
            g.resolve("kkkkz--").first().map(|c| c.change_id.as_str()),
            Some("kkkkxxxx")
        );
        assert_eq!(g.resolve("(kkkkx)+")[0].change_id, "kkkkyyyy");
        assert_eq!(g.resolve("cccc0003-")[0].change_id, "kkkkyyyy");
        assert!(g.is_bedrock(g.get("zzzztrunk").unwrap()));
        assert_eq!(g.summary().status, GraphStatus::Clean);
    }

    #[test]
    fn structural_above_behavioral_is_reported() {
        let mut t = node("zzzztrunk", "aaaa0001", &[], "trunk");
        t.immutable = true;
        let mut beh = node("kkkkbehav", "bbbb0001", &["aaaa0001"], "Add the parser");
        beh.paths = vec!["src/parser.rs".into(), "tests/parser.rs".into()];
        let g = graph(vec![
            node("kkkkstruc", "bbbb0002", &["bbbb0001"], "refactor: rename"),
            beh,
            t,
        ]);
        let d = g.diagnose();
        let found = d
            .iter()
            .find(|d| d.code == DiagnosticCode::UnorderedStructuralAboveBehavioral)
            .unwrap();
        assert_eq!(
            found.suggested_args.as_deref().unwrap(),
            ["rebase", "-r", "kkkkstruc", "-B", "kkkkbehav"]
        );
        assert_eq!(
            found.suggested_command.as_deref(),
            Some("jj rebase -r kkkkstru -B kkkkbeha")
        );
    }

    #[test]
    fn dependency_test() {
        let base = DependencyAssessment {
            base: "kkkkbaseeee".into(),
            child: "kkkkchildee".into(),
            child_causally_depends_on_base: Some(false),
            base_independently_reviewable: Some(true),
            ..Default::default()
        };
        assert_eq!(
            JjrGraph::evaluate_dependency(&base).outcome,
            DependencyOutcome::Parallelize
        );
        let uncertain = DependencyAssessment {
            causal_probability: Some(0.5),
            ..base.clone()
        };
        let v = JjrGraph::evaluate_dependency(&DependencyAssessment {
            child_causally_depends_on_base: None,
            ..uncertain
        });
        assert_eq!(v.outcome, DependencyOutcome::Confirm);
        assert!(v.reason.contains("causal=0.50"));
    }

    #[test]
    fn json_shapes_match_the_web_ui() {
        let d = GraphDiagnostic::new(
            Severity::Info,
            DiagnosticCode::DeepStack,
            "m".into(),
            vec![],
        );
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["code"], "DEEP_STACK");
        assert!(v.get("suggestedArgs").is_none());
        let t = serde_json::to_value(TrunkFact::unresolved("boom")).unwrap();
        assert_eq!(t, serde_json::json!({ "resolved": false, "error": "boom" }));
    }
}
