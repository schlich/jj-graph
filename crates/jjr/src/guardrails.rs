//! The jjr guardrail pipeline.
//!
//! Every graph mutation, bookmark, push, Git interop command, or workspace
//! creation passes through a composable rule pipeline before touching the
//! repository. Deterministic rules enforce hard invariants; an optional Jev
//! System-One pass adds calibrated soft risk and readiness judgment.
//!
//! Port of `jjr/guardrails.mjs`.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::LazyLock;

use indexmap::IndexMap;
use indexmap::IndexSet;
use regex::Regex;
use serde::Deserialize;
use serde::Serialize;

use crate::commands::describe_mutation;
use crate::graph::JjrChange;
use crate::graph::JjrGraph;
use crate::graph::ROOT_COMMIT;
use crate::jev::ActionRiskAssessment;
use crate::jev::JjrJevAssistant;
use crate::types::ChangeIntent;
use crate::types::VerificationState;
use crate::types::Zone;
use crate::types::short;
use crate::types::verification_state;

/// A revision a mutation rewrites, as jj resolved it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResolvedTarget {
    pub change_id: String,
    pub commit_id: String,
    pub immutable: bool,
    pub divergent: bool,
    /// Contained in `::trunk()`.
    pub in_trunk: bool,
}

/// Bookmarks a mutation points at revisions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookmarkTargets {
    pub names: Vec<String>,
    pub target_changes: Vec<String>,
}

/// A jj command that rewrites revisions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MutateAction {
    pub target_changes: Vec<String>,
    pub command: String,
    /// The jj argv; lets guards see exactly what the command rewrites.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resolved_targets: Vec<ResolvedTarget>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bookmarks: Vec<BookmarkTargets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore_immutable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<bool>,
}

/// Creating or moving bookmarks (export pointers).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookmarkAction {
    pub bookmarks: Vec<String>,
    pub target_changes: Vec<String>,
}

/// Pushing changes to a remote.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PushAction {
    pub target_changes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
}

/// A raw Git command in the repository.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitInteropAction {
    pub raw_git_command: String,
}

/// Why a workspace is wanted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceReason {
    SwitchBranch,
    ParallelBuildOrAgent,
}

/// `jj workspace add`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceAddAction {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<WorkspaceReason>,
}

/// Something the guardrails decide on. Serialized with a `type` tag
/// (`mutate`, `bookmark`, `push`, `git-interop`, `workspace-add`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum GuardrailAction {
    Mutate(MutateAction),
    Bookmark(BookmarkAction),
    Push(PushAction),
    GitInterop(GitInteropAction),
    WorkspaceAdd(WorkspaceAddAction),
}

impl GuardrailAction {
    /// The action's `type` tag: `mutate`, `bookmark`, `push`, `git-interop`
    /// or `workspace-add`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Mutate(_) => "mutate",
            Self::Bookmark(_) => "bookmark",
            Self::Push(_) => "push",
            Self::GitInterop(_) => "git-interop",
            Self::WorkspaceAdd(_) => "workspace-add",
        }
    }

    /// The revisions the action names (`targetChanges`); empty for Git
    /// commands and workspace creation.
    pub fn target_changes(&self) -> &[String] {
        match self {
            Self::Mutate(a) => &a.target_changes,
            Self::Bookmark(a) => &a.target_changes,
            Self::Push(a) => &a.target_changes,
            Self::GitInterop(_) | Self::WorkspaceAdd(_) => &[],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionSeverity {
    Block,
    Warn,
    Pass,
}

/// One rule's verdict on an action.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailDecision {
    pub allowed: bool,
    pub rule_name: String,
    pub severity: DecisionSeverity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrated_probability: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrated_confidence: Option<f64>,
}

/// Every rule's verdict, with the blocking and warning ones picked out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuardrailResult {
    pub allowed: bool,
    pub decisions: Vec<GuardrailDecision>,
    pub blockers: Vec<GuardrailDecision>,
    pub warnings: Vec<GuardrailDecision>,
}

/// A [`GuardrailResult`] with Jev's risk reading, when it was asked.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailResultWithJev {
    #[serde(flatten)]
    pub result: GuardrailResult,
    pub jev_assessment: Option<ActionRiskAssessment>,
}

/// A guardrail rule.
pub type GuardrailRule =
    Arc<dyn Fn(&JjrGraph, &GuardrailAction) -> GuardrailDecision + Send + Sync>;

fn decision(
    allowed: bool,
    rule_name: &str,
    severity: DecisionSeverity,
    message: impl Into<String>,
    remediation: Option<String>,
) -> GuardrailDecision {
    GuardrailDecision {
        allowed,
        rule_name: rule_name.to_owned(),
        severity,
        message: message.into(),
        remediation,
        calibrated_probability: None,
        calibrated_confidence: None,
    }
}

fn pass(rule_name: &str) -> GuardrailDecision {
    pass_with(rule_name, "OK")
}

fn pass_with(rule_name: &str, message: impl Into<String>) -> GuardrailDecision {
    decision(true, rule_name, DecisionSeverity::Pass, message, None)
}

fn block(
    rule_name: &str,
    message: impl Into<String>,
    remediation: impl Into<String>,
) -> GuardrailDecision {
    decision(
        false,
        rule_name,
        DecisionSeverity::Block,
        message,
        Some(remediation.into()),
    )
}

fn warn(
    rule_name: &str,
    message: impl Into<String>,
    remediation: impl Into<String>,
) -> GuardrailDecision {
    decision(
        true,
        rule_name,
        DecisionSeverity::Warn,
        message,
        Some(remediation.into()),
    )
}

/// Short forms of ids, comma separated.
fn join_short<'a>(ids: impl IntoIterator<Item = &'a str>) -> String {
    ids.into_iter().map(short).collect::<Vec<_>>().join(", ")
}

/// Resolve revisions named by an action to loaded changes.
fn target_nodes<'g, 'a>(
    graph: &'g JjrGraph,
    ids: impl IntoIterator<Item = &'a String>,
) -> Vec<&'g JjrChange> {
    let mut out: IndexMap<&'g str, &'g JjrChange> = IndexMap::new();
    for id in ids {
        if let Some(direct) = graph.get_any(id) {
            out.insert(direct.change_id.as_str(), direct);
        } else {
            for n in graph.resolve(id) {
                out.insert(n.change_id.as_str(), n);
            }
        }
    }
    out.into_values().collect()
}

/// The changes a push or bookmark would export, or `None` when the action
/// exports nothing.
fn publish_targets<'g>(
    graph: &'g JjrGraph,
    action: &GuardrailAction,
) -> Option<Vec<&'g JjrChange>> {
    match action {
        GuardrailAction::Push(push) => {
            let mut nodes = target_nodes(graph, &push.target_changes);
            if let Some(bookmark) = push.bookmark.as_deref().filter(|b| !b.is_empty()) {
                nodes.extend(
                    graph
                        .all()
                        .into_iter()
                        .filter(|n| n.bookmarks.iter().any(|b| b == bookmark)),
                );
            }
            Some(nodes)
        }
        GuardrailAction::Bookmark(b) => Some(target_nodes(graph, &b.target_changes)),
        GuardrailAction::Mutate(m) if !m.bookmarks.is_empty() => Some(target_nodes(
            graph,
            m.bookmarks.iter().flat_map(|b| &b.target_changes),
        )),
        _ => None,
    }
}

static WORD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""[^"]*"|'[^']*'|\S+"#).unwrap());

/// Split a command string into words (quotes kept simple; enough for flags and ids).
fn words(command: &str) -> Vec<String> {
    WORD_RE
        .find_iter(command)
        .map(|m| unquote(m.as_str()).to_owned())
        .collect()
}

/// `w.replace(/^(["'])(.*)\1$/, '$2')`: drop one pair of matching outer
/// quotes. Like JS `.`, the quoted text may not span a line terminator.
fn unquote(w: &str) -> &str {
    let mut chars = w.chars();
    match (chars.next(), chars.next_back()) {
        (Some(q @ ('"' | '\'')), Some(last)) if last == q => {
            let inner = &w[1..w.len() - 1];
            if inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                w
            } else {
                inner
            }
        }
        _ => w,
    }
}

fn args_of(action: &MutateAction) -> Vec<String> {
    if let Some(args) = &action.args {
        return args.clone();
    }
    let mut w = words(&action.command);
    if w.first().is_some_and(|first| first == "jj") {
        w.remove(0);
    }
    w
}

/// Rule 0, the Pre-flight Guard: `trunk()` and `immutable_heads()` must resolve
/// before the graph is mutated. An in-memory graph without pre-flight facts passes.
pub fn preflight_guard(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "PreflightGuard";
    if !matches!(
        action,
        GuardrailAction::Mutate(_) | GuardrailAction::Push(_) | GuardrailAction::Bookmark(_)
    ) {
        return pass(NAME);
    }
    let Some(p) = &graph.preflight else {
        return pass_with(NAME, "No pre-flight context (in-memory graph).");
    };
    if !p.trunk.resolved || !p.immutable_heads.resolved {
        let error = [&p.trunk.error, &p.immutable_heads.error]
            .into_iter()
            .flatten()
            .find(|e| !e.is_empty())
            .map_or("unknown error", String::as_str);
        return block(
            NAME,
            format!(
                "trunk() or immutable_heads() does not resolve ({error}), so the immutable boundary is unknown."
            ),
            "Fix the revset aliases until `jj log -r 'trunk() | immutable_heads()'` succeeds.",
        );
    }
    let only_root = p
        .immutable_heads
        .heads
        .as_deref()
        .unwrap_or_default()
        .iter()
        .all(|h| h.commit_id == ROOT_COMMIT);
    if p.trunk.is_root() && only_root && !p.remotes.is_empty() {
        return warn(
            NAME,
            "trunk() resolves to root() and nothing else is immutable, so history shared through the remote is unprotected.",
            format!(
                "Track the remote trunk (`jj bookmark track main@{}`) or set revset-aliases.\"trunk()\".",
                p.remotes[0]
            ),
        );
    }
    if !p.trunk.is_root() && p.trunk.immutable != Some(true) {
        return warn(
            NAME,
            "trunk() is not in immutable(); jjr guards ::trunk() as bedrock itself.",
            "jj config set --repo 'revset-aliases.\"immutable_heads()\"' 'builtin_immutable_heads()'",
        );
    }
    let trunk = if p.trunk.is_root() {
        "root()"
    } else {
        short(p.trunk.change_id())
    };
    pass_with(
        NAME,
        format!("trunk() resolves to {trunk} and immutable_heads() resolves."),
    )
}

const BEDROCK_REMEDIATION: &str = "Create a new mutable change atop trunk() with `jj new trunk()` instead of rewriting shared history.";

/// `--ignore-immutable` as a word of a command string.
static IGNORE_IMMUTABLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|\s)--ignore-immutable(\s|=|$)").unwrap());

/// Rule 1, the Immutable Bedrock Guard: never rewrite `immutable()` history, never
/// force it with `--ignore-immutable`, and treat `::trunk()` as bedrock even
/// when `immutable_heads()` leaves it out.
pub fn immutable_bedrock_guard(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "ImmutableBedrockGuard";
    let GuardrailAction::Mutate(m) = action else {
        return pass(NAME);
    };
    let forced = m.ignore_immutable == Some(true)
        || m.args
            .as_ref()
            .is_some_and(|args| args.iter().any(|a| a == "--ignore-immutable"))
        || IGNORE_IMMUTABLE_RE.is_match(&m.command);
    if forced {
        return block(
            NAME,
            "Blocked --ignore-immutable: jjr never force-rewrites immutable() history.",
            BEDROCK_REMEDIATION,
        );
    }
    let mut hits: IndexSet<&str> = IndexSet::new();
    for n in target_nodes(graph, &m.target_changes) {
        if graph.is_bedrock(n) {
            hits.insert(&n.change_id);
        }
    }
    for t in &m.resolved_targets {
        if t.immutable || t.in_trunk {
            hits.insert(&t.change_id);
        }
    }
    if !hits.is_empty() {
        return block(
            NAME,
            format!(
                "Blocked mutation on immutable() revision(s): {}.",
                join_short(hits.iter().copied())
            ),
            BEDROCK_REMEDIATION,
        );
    }
    pass(NAME)
}

static RECOVERY_COMMAND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(jj\s+)?(abandon|converge|op\s+restore|op\s+revert|operation\s+restore|operation\s+revert)(?-u:\b)").unwrap()
});
static METAEDIT_RECOVERY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(jj\s+)?metaedit(?-u:\b)[^\n\r\u{2028}\u{2029}]*--update-change-id").unwrap()
});

fn is_recovery(action: &MutateAction) -> bool {
    if let Some(recovery) = action.recovery {
        return recovery;
    }
    if let Some(args) = &action.args {
        return describe_mutation(args).recovery;
    }
    let cmd = action.command.trim().to_lowercase();
    RECOVERY_COMMAND_RE.is_match(&cmd) || METAEDIT_RECOVERY_RE.is_match(&cmd)
}

/// Rule 2, the Divergence Guard: halt stacking, bookmarking or pushing while
/// `divergent()` is non-empty; recovery commands stay open.
pub fn divergence_guard(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "DivergenceGuard";
    match action {
        GuardrailAction::Mutate(m) if is_recovery(m) => {
            return pass_with(NAME, "Divergence recovery command permitted.");
        }
        GuardrailAction::Mutate(_) | GuardrailAction::Push(_) | GuardrailAction::Bookmark(_) => {}
        GuardrailAction::GitInterop(_) | GuardrailAction::WorkspaceAdd(_) => return pass(NAME),
    }
    let mut ids: IndexSet<&str> = graph
        .divergent()
        .into_iter()
        .map(|d| d.change_id.as_str())
        .collect();
    if let Some(p) = &graph.preflight {
        ids.extend(p.divergent.iter().map(String::as_str));
    }
    if !ids.is_empty() {
        return block(
            NAME,
            format!(
                "Divergent ChangeId(s) detected ({}). Two or more visible commits share one ChangeId.",
                join_short(ids.iter().copied())
            ),
            "Inspect with `jj log -r \"divergent()\"` and resolve via `jj converge` or `jj abandon <commit-id>` before continuing.",
        );
    }
    pass(NAME)
}

/// Rule 3, the Megamerge Fence: hard-block pushing (or bookmarking for export) any
/// revset that includes a local octopus composition merge.
pub fn megamerge_fence(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "MegamergeFence";
    let Some(targets) = publish_targets(graph, action) else {
        return pass(NAME);
    };
    let mut megamerges: IndexSet<&str> = IndexSet::new();
    for target in targets {
        for anc in graph.mutable_ancestors_of(&target.change_id) {
            if graph.is_megamerge(anc) {
                megamerges.insert(&anc.change_id);
            }
        }
    }
    if !megamerges.is_empty() {
        let what = if matches!(action, GuardrailAction::Push(_)) {
            "push range"
        } else {
            "bookmark target"
        };
        return block(
            NAME,
            format!(
                "Megamerge Fence triggered: {what} includes local composition merge(s) [{}].",
                join_short(megamerges.iter().copied())
            ),
            "Push the underlying feature arms independently (`jj git push -c <arm-change-id>`), never the local megamerge.",
        );
    }
    pass(NAME)
}

/// A verification flag the way JS prints it in a template literal.
fn flag(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "true",
        Some(false) => "false",
        None => "null",
    }
}

/// Rule 4, the Publishing Gate: every revision in the publishable range must be
/// conflict-free, non-empty (unless a merge or blueprint), formatted,
/// building and passing tests.
pub fn publishing_gate(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "PublishingGate";
    let Some(targets) = publish_targets(graph, action) else {
        return pass(NAME);
    };
    let strict = matches!(action, GuardrailAction::Push(_));
    let mut failures: Vec<String> = Vec::new();
    let mut unverified: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for target in targets {
        for rev in graph.mutable_ancestors_of(&target.change_id) {
            // The fence reports megamerges.
            if seen.contains(rev.change_id.as_str()) || graph.is_megamerge(rev) {
                continue;
            }
            seen.insert(&rev.change_id);
            let s = short(&rev.change_id);
            let placeholder = rev.current_commit.is_empty
                && (rev.intent == ChangeIntent::Blueprint || rev.parents.len() >= 2);
            if rev.current_commit.conflict.is_conflicted {
                failures.push(format!("{s}: unresolved algebraic conflict"));
            }
            if rev.current_commit.is_empty && !placeholder {
                failures.push(format!("{s}: empty commit"));
            }
            let v = &rev.verification;
            match verification_state(Some(v)) {
                VerificationState::Red => failures.push(format!(
                    "{s}: failed verification (format={}, build={}, tests={})",
                    flag(v.formatted),
                    flag(v.builds),
                    flag(v.tests_pass)
                )),
                VerificationState::Unknown if !placeholder => unverified.push(s),
                _ => {}
            }
        }
    }
    let what = if strict { "push" } else { "bookmark" };
    if !failures.is_empty() {
        return block(
            NAME,
            format!(
                "Publishing Gate rejected {what}:\n- {}",
                failures.join("\n- ")
            ),
            "Resolve conflicts, run `jj fix`, and verify builds and tests across the stack before publishing.",
        );
    }
    if !unverified.is_empty() {
        return decision(
            !strict,
            NAME,
            if strict { DecisionSeverity::Block } else { DecisionSeverity::Warn },
            format!(
                "Not verified yet: {}. Formatting, build and test results are unknown for these snapshots.",
                unverified.join(", ")
            ),
            Some(
                "Verify the stack: `jj fix` plus `jj run --ignore-changes -r <range> -- <test command>` (jj-graph: POST /api/jjr/verify)."
                    .to_owned(),
            ),
        );
    }
    pass_with(
        NAME,
        "All publishable revisions are green and conflict-free.",
    )
}

/// Git subcommands that only read.
const READ_ONLY_GIT: &[&str] = &[
    "status",
    "log",
    "show",
    "diff",
    "blame",
    "annotate",
    "grep",
    "ls-files",
    "ls-tree",
    "ls-remote",
    "rev-parse",
    "rev-list",
    "cat-file",
    "describe",
    "shortlog",
    "show-ref",
    "show-branch",
    "for-each-ref",
    "name-rev",
    "merge-base",
    "check-ignore",
    "check-attr",
    "check-ref-format",
    "count-objects",
    "fsck",
    "verify-commit",
    "verify-tag",
    "var",
    "help",
    "version",
    "whatchanged",
    "range-diff",
    "cherry",
    "diff-tree",
    "diff-index",
    "diff-files",
    "difftool",
    "archive",
    "patch-id",
    "request-pull",
    "show-index",
    "verify-pack",
    "get-tar-commit-id",
];

/// The jj way to do what a mutating git subcommand does.
fn git_hint(sub: &str) -> Option<&'static str> {
    Some(match sub {
        "checkout" => {
            "Use `jj new <rev>` or `jj edit <rev>`; `git checkout` of a conflicted jj commit materializes .jjconflict-* trees."
        }
        "switch" => {
            "Use `jj new <rev>` or `jj edit <rev>`; `git switch` to a conflicted jj commit materializes .jjconflict-* trees."
        }
        "restore" => "Use `jj restore`.",
        "commit" => "Use `jj commit` or `jj describe`; jj snapshots the working copy itself.",
        "add" => "jj has no staging area; it snapshots the working copy automatically.",
        "rm" => "Delete the file; jj snapshots the working copy automatically.",
        "mv" => "Move the file; jj snapshots the working copy automatically.",
        "stash" => "Use `jj new @-` to set work aside; the old change stays in the graph.",
        "reset" => "Use `jj restore`, `jj abandon`, or `jj op restore`.",
        "rebase" => {
            "Use `jj rebase`; `git rebase` strips change-id headers and leaves divergent changes."
        }
        "cherry-pick" => "Use `jj duplicate`.",
        "merge" => "Use `jj new <a> <b>`.",
        "revert" => "Use `jj revert`.",
        "pull" => "Use `jj git fetch`, then rebase with jj.",
        "fetch" => {
            "Use `jj git fetch`; fetching behind jj's back leaves conflicted bookmarks (??). Turn off background IDE fetches too."
        }
        "push" => {
            "Use `jj git push`, which applies force-with-lease semantics behind the Publishing Gate."
        }
        "tag" => "jj cannot create annotated tags; use `jj tag set` for lightweight ones.",
        "branch" => "Use `jj bookmark`.",
        "submodule" => "jj does not support Git submodules.",
        "lfs" => "jj does not support Git LFS.",
        "gc" => "Use `jj util gc`.",
        "clean" => "Use `jj restore` to drop changes; jj tracks untracked files itself.",
        "am" | "apply" => "Apply patches in a jj change so jj stays the only writer.",
        "worktree" => "Use `jj workspace add`, and only for parallel agents or builds.",
        _ => return None,
    })
}

/// Whether a git invocation only reads.
pub fn is_read_only_git_command(raw_git_command: &str) -> bool {
    git_read_only(&parse_git(raw_git_command))
}

/// A git command line: the subcommand and the words after it.
struct ParsedGit {
    sub: String,
    rest: Vec<String>,
}

/// Global git options that take a value.
const GIT_VALUE_OPTIONS: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
];

fn parse_git(raw: &str) -> ParsedGit {
    let mut w = words(raw);
    if w.first().is_some_and(|first| first == "git") {
        w.remove(0);
    }
    // Skip global options such as `-C dir`, `-c k=v`, `--no-pager`.
    let mut i = 0;
    while i < w.len() && w[i].starts_with('-') {
        if GIT_VALUE_OPTIONS.contains(&w[i].as_str()) {
            i += 1;
        }
        i += 1;
    }
    ParsedGit {
        sub: w.get(i).cloned().unwrap_or_default(),
        rest: w.get(i + 1..).map(<[String]>::to_vec).unwrap_or_default(),
    }
}

static BRANCH_WRITE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(-[dDmMcCfu]$|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--edit-description|--track|--no-track)").unwrap()
});
static BRANCH_LIST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at|-v|--verbose)").unwrap()
});
static TAG_WRITE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(-[adsfmFue]$|--annotate|--delete|--sign|--force|--message|--file|--local-user|--edit)",
    )
    .unwrap()
});
static TAG_LIST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(-l|--list|-n[0-9]*|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)").unwrap()
});
static CONFIG_READ_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(--get|--get-all|--get-regexp|--list|-l)(=|$)").unwrap());
static CONFIG_WRITE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(--unset|--add|--replace-all|--rename-section|--remove-section|-e$|--edit)")
        .unwrap()
});

fn git_read_only(parsed: &ParsedGit) -> bool {
    let sub = parsed.sub.as_str();
    if sub.is_empty() || READ_ONLY_GIT.contains(&sub) {
        return true;
    }
    let positional: Vec<&str> = parsed
        .rest
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(String::as_str)
        .collect();
    let flags: Vec<&str> = parsed
        .rest
        .iter()
        .filter(|a| a.starts_with('-'))
        .map(String::as_str)
        .collect();
    let any = |re: &Regex| flags.iter().any(|f| re.is_match(f));
    let first = positional.first().copied();
    match sub {
        "branch" => !any(&BRANCH_WRITE_RE) && (positional.is_empty() || any(&BRANCH_LIST_RE)),
        "tag" => !any(&TAG_WRITE_RE) && (positional.is_empty() || any(&TAG_LIST_RE)),
        "remote" => positional.is_empty() || matches!(first, Some("show" | "get-url")),
        "stash" | "notes" => matches!(first, Some("list" | "show")),
        "worktree" => first == Some("list"),
        "reflog" => positional.is_empty() || first == Some("show"),
        "config" => {
            matches!(first, Some("get" | "list"))
                || (any(&CONFIG_READ_RE) && !any(&CONFIG_WRITE_RE))
        }
        "submodule" => positional.is_empty() || matches!(first, Some("status" | "summary")),
        "lfs" => matches!(first, Some("ls-files" | "status" | "env" | "version")),
        _ => false,
    }
}

/// 5. Colocated Single-Writer Guard: in colocated repositories git is read-only.
pub fn colocated_git_guard(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "ColocatedGitGuard";
    let GuardrailAction::GitInterop(git) = action else {
        return pass(NAME);
    };
    if !graph.config.colocated {
        return pass_with(NAME, "Repository is not colocated.");
    }
    let parsed = parse_git(&git.raw_git_command);
    if git_read_only(&parsed) {
        return pass_with(NAME, format!("Read-only `git {}` permitted.", parsed.sub));
    }
    block(
        NAME,
        format!(
            "Blocked mutating Git command \"{}\" in colocated .jj/.git repository: jj is the only writer, git is read-only.",
            git.raw_git_command
        ),
        git_hint(&parsed.sub).unwrap_or(
            "Do it with jj; reserve git for read-only inspection (log, show, diff, status, blame).",
        ),
    )
}

/// Rule 6, the Workspace Discipline Guard: workspaces are for parallel agents, test
/// suites and builds, never for switching branches.
pub fn workspace_discipline_guard(
    _graph: &JjrGraph,
    action: &GuardrailAction,
) -> GuardrailDecision {
    const NAME: &str = "WorkspaceDisciplineGuard";
    let GuardrailAction::WorkspaceAdd(ws) = action else {
        return pass(NAME);
    };
    match ws.reason {
        Some(WorkspaceReason::SwitchBranch) => block(
            NAME,
            "Blocked unnecessary `jj workspace add` for branch switching.",
            "Use anonymous branches (`jj new trunk()`) and local megamerges in one workspace; reserve workspaces for parallel builds or parallel agents.",
        ),
        None => warn(
            NAME,
            "Creating a workspace without a stated reason.",
            "Add a workspace only when parallel agents, concurrent test suites, or simultaneous builds need their own file tree.",
        ),
        Some(WorkspaceReason::ParallelBuildOrAgent) => pass(NAME),
    }
}

static COMMIT_ID_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-fA-F]{4,40}$").unwrap());

/// 7. Change-ID Addressing Guard: reference mutable work by change id.
pub fn change_id_addressing_guard(graph: &JjrGraph, action: &GuardrailAction) -> GuardrailDecision {
    const NAME: &str = "ChangeIdAddressingGuard";
    let GuardrailAction::Mutate(m) = action else {
        return pass(NAME);
    };
    let mut stale: Vec<String> = Vec::new();
    for token in describe_mutation(&args_of(m)).revision_args {
        if !COMMIT_ID_TOKEN_RE.is_match(&token) {
            continue;
        }
        let Some(node) = graph.resolve(&token).into_iter().next() else {
            continue;
        };
        if node.zone != Zone::Mutable || node.is_divergent || node.is_hidden {
            continue;
        }
        if !node
            .current_commit
            .commit_id
            .starts_with(&token.to_lowercase())
        {
            continue;
        }
        stale.push(format!("{} → {}", short(&token), short(&node.change_id)));
    }
    if !stale.is_empty() {
        return warn(
            NAME,
            format!(
                "Mutable work addressed by commit id ({}). Commit ids rotate on every rewrite.",
                stale.join(", ")
            ),
            "Address mutable work by the change id after each arrow; it survives rewrites, retries and later steps.",
        );
    }
    pass(NAME)
}

/// The eight default rules, in order.
pub fn default_guardrails() -> Vec<GuardrailRule> {
    vec![
        Arc::new(preflight_guard),
        Arc::new(immutable_bedrock_guard),
        Arc::new(divergence_guard),
        Arc::new(megamerge_fence),
        Arc::new(publishing_gate),
        Arc::new(colocated_git_guard),
        Arc::new(workspace_discipline_guard),
        Arc::new(change_id_addressing_guard),
    ]
}

/// Pick the blocking and warning decisions out of `decisions`.
fn summarize(decisions: Vec<GuardrailDecision>) -> GuardrailResult {
    let blockers: Vec<GuardrailDecision> = decisions
        .iter()
        .filter(|d| !d.allowed && d.severity == DecisionSeverity::Block)
        .cloned()
        .collect();
    let warnings: Vec<GuardrailDecision> = decisions
        .iter()
        .filter(|d| d.severity == DecisionSeverity::Warn)
        .cloned()
        .collect();
    GuardrailResult {
        allowed: blockers.is_empty(),
        decisions,
        blockers,
        warnings,
    }
}

/// A composable guardrail pipeline.
#[derive(Clone)]
pub struct JjrGuardrailPipeline {
    rules: Vec<GuardrailRule>,
}

impl std::fmt::Debug for JjrGuardrailPipeline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JjrGuardrailPipeline")
            .field("rules", &self.rules.len())
            .finish()
    }
}

impl Default for JjrGuardrailPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl JjrGuardrailPipeline {
    /// A pipeline of the default rules.
    pub fn new() -> Self {
        Self::with_rules(default_guardrails())
    }

    pub fn with_rules(rules: Vec<GuardrailRule>) -> Self {
        Self { rules }
    }

    /// Append a rule.
    pub fn use_rule(&mut self, rule: GuardrailRule) -> &mut Self {
        self.rules.push(rule);
        self
    }

    pub fn rules(&self) -> &[GuardrailRule] {
        &self.rules
    }

    /// The deterministic check.
    pub fn evaluate(&self, graph: &JjrGraph, action: &GuardrailAction) -> GuardrailResult {
        summarize(self.rules.iter().map(|rule| rule(graph, action)).collect())
    }

    /// The deterministic rules, plus Jev's calibrated scratchpad and
    /// blast-radius reading when `jev` is given and the rules allow the action.
    pub fn evaluate_with_jev(
        &self,
        graph: &JjrGraph,
        action: &GuardrailAction,
        jev: Option<&JjrJevAssistant>,
        diff_excerpt: &str,
    ) -> GuardrailResultWithJev {
        let base = self.evaluate(graph, action);
        let Some(jev) = jev.filter(|_| base.allowed) else {
            return GuardrailResultWithJev {
                result: base,
                jev_assessment: None,
            };
        };
        let assessment = jev.evaluate_action_risk(graph, action, diff_excerpt);
        let is_push = matches!(action, GuardrailAction::Push(_));
        let scratchpad = assessment.looks_like_scratchpad.noul;
        let mut decisions = base.decisions;

        if scratchpad >= 0.78 && is_push {
            decisions.push(GuardrailDecision {
                allowed: false,
                rule_name: "JevScratchpadGate".to_owned(),
                severity: DecisionSeverity::Block,
                message: format!(
                    "Jev flagged this push target as an unfinished local scratchpad or unmarked megamerge (p={scratchpad:.2})."
                ),
                remediation: Some("Review the diff, describe the change cleanly, or push only the underlying feature arm.".to_owned()),
                calibrated_probability: Some(scratchpad),
                calibrated_confidence: None,
            });
        } else if scratchpad >= 0.45 && is_push {
            decisions.push(GuardrailDecision {
                allowed: true,
                rule_name: "JevScratchpadGate".to_owned(),
                severity: DecisionSeverity::Warn,
                message: format!(
                    "Jev noticed scratchpad signals in this change (p={scratchpad:.2}). Double-check before publishing."
                ),
                remediation: None,
                calibrated_probability: Some(scratchpad),
                calibrated_confidence: None,
            });
        }

        let blast = &assessment.blast_radius;
        if blast.score >= 2.2 {
            decisions.push(GuardrailDecision {
                allowed: true,
                rule_name: "JevBlastRadiusAdvisor".to_owned(),
                severity: DecisionSeverity::Warn,
                message: format!(
                    "Jev scored this action's blast radius as \"{}\" (score={:.2}, confidence={:.2}). Preview in dry-run mode first.",
                    blast.legend, blast.score, blast.confidence
                ),
                remediation: Some("Preview with `jj --no-integrate-operation` (or jjr dry-run) before integrating.".to_owned()),
                calibrated_probability: None,
                calibrated_confidence: Some(blast.confidence),
            });
        }

        GuardrailResultWithJev {
            result: summarize(decisions),
            jev_assessment: Some(assessment),
        }
    }
}
