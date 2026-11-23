//! Identity and state vocabulary for jjr.
//!
//! Jujutsu separates a change's logical identity from its snapshots:
//! - a change id is 16 bytes of reverse hex (`k`-`z`) and survives rewrites;
//! - a commit id is a hex SHA naming one immutable snapshot;
//! - an operation id is hex and names a state of the whole repository;
//! - a bookmark name is a non-empty label without whitespace.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde::Serialize;

static REVERSE_HEX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[k-z]{8,32}$").unwrap());
static HEX_SHA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{8,40}$").unwrap());
static OP_ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{8,128}$").unwrap());

/// The kind of identifier a [`JjrTypeError`] expected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdKind {
    ChangeId,
    CommitId,
    OpId,
    BookmarkName,
}

/// A string that is not the identifier it was passed as.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct JjrTypeError {
    pub message: String,
    pub expected_kind: IdKind,
    pub received: String,
}

/// Validate a change id (reverse hex, `k`-`z`, 8 to 32 characters).
pub fn as_change_id(raw: &str) -> Result<String, JjrTypeError> {
    let normalized = raw.trim().to_lowercase();
    if REVERSE_HEX_RE.is_match(&normalized) {
        return Ok(normalized);
    }
    let hint = if HEX_SHA_RE.is_match(&normalized) {
        " That looks like a hex CommitId (0-9a-f); never pass an ephemeral CommitId where a stable ChangeId is required."
    } else {
        ""
    };
    Err(JjrTypeError {
        message: format!(
            "Invalid ChangeId \"{raw}\". Expected jj reverse-hex (characters k-z, 8-32 chars).{hint}"
        ),
        expected_kind: IdKind::ChangeId,
        received: raw.to_owned(),
    })
}

/// Validate a commit id (hex, 8 to 40 characters).
pub fn as_commit_id(raw: &str) -> Result<String, JjrTypeError> {
    let normalized = raw.trim().to_lowercase();
    if HEX_SHA_RE.is_match(&normalized) {
        return Ok(normalized);
    }
    let hint = if REVERSE_HEX_RE.is_match(&normalized) {
        " That looks like a reverse-hex ChangeId (k-z); resolve it to a concrete snapshot CommitId first."
    } else {
        ""
    };
    Err(JjrTypeError {
        message: format!(
            "Invalid CommitId \"{raw}\". Expected hex SHA (0-9a-f, 8-40 chars).{hint}"
        ),
        expected_kind: IdKind::CommitId,
        received: raw.to_owned(),
    })
}

/// Validate an operation id (hex, 8 to 128 characters).
pub fn as_op_id(raw: &str) -> Result<String, JjrTypeError> {
    let normalized = raw.trim().to_lowercase();
    if OP_ID_RE.is_match(&normalized) {
        return Ok(normalized);
    }
    Err(JjrTypeError {
        message: format!("Invalid OpId \"{raw}\". Expected hex operation ID (8-128 hex chars)."),
        expected_kind: IdKind::OpId,
        received: raw.to_owned(),
    })
}

/// Validate a bookmark name: non-empty, no whitespace.
pub fn as_bookmark(raw: &str) -> Result<String, JjrTypeError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return Err(JjrTypeError {
            message: format!(
                "Invalid BookmarkName \"{raw}\". Bookmarks must be non-empty and contain no whitespace."
            ),
            expected_kind: IdKind::BookmarkName,
            received: raw.to_owned(),
        });
    }
    Ok(trimmed.to_owned())
}

pub fn is_change_id(raw: &str) -> bool {
    REVERSE_HEX_RE.is_match(&raw.trim().to_lowercase())
}

pub fn is_commit_id(raw: &str) -> bool {
    HEX_SHA_RE.is_match(&raw.trim().to_lowercase())
}

pub fn is_op_id(raw: &str) -> bool {
    OP_ID_RE.is_match(&raw.trim().to_lowercase())
}

/// The first `len` characters of an id.
pub fn format_short_id(id: &str, len: usize) -> String {
    id.chars().take(len).collect()
}

/// The first 8 characters of an id, the way jjr prints ids in messages.
pub fn short(id: &str) -> &str {
    match id.char_indices().nth(8) {
        Some((i, _)) => &id[..i],
        None => id,
    }
}

/// What a change is for, which decides how it may be ordered and published.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeIntent {
    /// Tidy First? pure refactor (rename, extract, guard clause).
    Structural,
    /// Feature or bugfix with bundled tests.
    Behavioral,
    /// Characterization tests or test-infrastructure change.
    TestHarness,
    /// Small top-level flag, route, or config flip.
    Activation,
    /// Intentional empty stub pre-describing a planned stack.
    Blueprint,
    /// Local-only octopus composition (never push).
    Megamerge,
    /// Ephemeral `@` scratchpad.
    WorkingCopy,
}

impl ChangeIntent {
    pub const ALL: [Self; 7] = [
        Self::Structural,
        Self::Behavioral,
        Self::TestHarness,
        Self::Activation,
        Self::Blueprint,
        Self::Megamerge,
        Self::WorkingCopy,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Structural => "structural",
            Self::Behavioral => "behavioral",
            Self::TestHarness => "test-harness",
            Self::Activation => "activation",
            Self::Blueprint => "blueprint",
            Self::Megamerge => "megamerge",
            Self::WorkingCopy => "working-copy",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

impl std::fmt::Display for ChangeIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Every intent, in the order jjr documents them.
pub const CHANGE_INTENT_KINDS: [ChangeIntent; 7] = ChangeIntent::ALL;

/// Whether a revision may still be rewritten.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Immutable,
    Mutable,
}

/// The review tool a stack is published to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForgeKind {
    Gerrit,
    GithubBookmarks,
    GithubStack,
    GithubSpr,
}

impl ForgeKind {
    pub const ALL: [Self; 4] = [
        Self::Gerrit,
        Self::GithubBookmarks,
        Self::GithubStack,
        Self::GithubSpr,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gerrit => "gerrit",
            Self::GithubBookmarks => "github-bookmarks",
            Self::GithubStack => "github-stack",
            Self::GithubSpr => "github-spr",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

impl std::fmt::Display for ForgeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// jj's `merge.same-change` setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeSameChange {
    Accept,
    Keep,
}

impl MergeSameChange {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "accept" => Some(Self::Accept),
            "keep" => Some(Self::Keep),
            _ => None,
        }
    }
}

/// Repository settings jjr reasons with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JjrRepoConfig {
    pub trunk_revset: String,
    /// Mirrors jj's `builtin_immutable_heads()`.
    pub immutable_heads_revset: String,
    pub colocated: bool,
    pub merge_same_change: MergeSameChange,
    pub megamerge_prefix: String,
    pub forge: ForgeKind,
    /// Longest linear chain of mutable changes before `DEEP_STACK` is reported.
    pub max_stack_depth: usize,
}

impl Default for JjrRepoConfig {
    fn default() -> Self {
        Self {
            trunk_revset: "trunk()".into(),
            immutable_heads_revset:
                "trunk() | tags() | untracked_remote_bookmarks() | untracked_remote_tags()".into(),
            colocated: true,
            merge_same_change: MergeSameChange::Keep,
            megamerge_prefix: "local:".into(),
            forge: ForgeKind::GithubBookmarks,
            max_stack_depth: 6,
        }
    }
}

/// The canonical DAG shapes of the reference, as `JjrGraph::classify_shape`
/// reports them for the mutable zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DagShape {
    Resting,
    Single,
    Stack,
    Parallel,
    Megamerge,
    Branching,
}

impl DagShape {
    pub const ALL: [Self; 6] = [
        Self::Resting,
        Self::Single,
        Self::Stack,
        Self::Parallel,
        Self::Megamerge,
        Self::Branching,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Resting => "resting",
            Self::Single => "single",
            Self::Stack => "stack",
            Self::Parallel => "parallel",
            Self::Megamerge => "megamerge",
            Self::Branching => "branching",
        }
    }
}

impl std::fmt::Display for DagShape {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A canonical shape: when it applies, what it looks like, the jj commands
/// that build it, and how it is published.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CanonicalShape {
    pub scenario: &'static str,
    pub dag: &'static str,
    pub primitives: &'static [&'static str],
    pub publishing: &'static str,
}

/// The reference's description of a DAG shape.
pub fn canonical_shape(shape: DagShape) -> &'static CanonicalShape {
    static RESTING: CanonicalShape = CanonicalShape {
        scenario: "All work landed",
        dag: "A single empty @ directly atop trunk()",
        primitives: &[
            "jj git fetch",
            "jj rebase -s 'roots(trunk()..@)' -o trunk()",
        ],
        publishing: "Nothing to publish.",
    };
    static SINGLE: CanonicalShape = CanonicalShape {
        scenario: "Isolated fix or cohesive feature",
        dag: "Single change rooted at trunk()",
        primitives: &["jj new trunk()"],
        publishing: "Attach one bookmark or run `jj git push -c @-` when ready.",
    };
    static STACK: CanonicalShape = CanonicalShape {
        scenario: "Multi-layer feature with real dependencies",
        dag: "Shallow linear stack (trunk() <- A <- B <- C), ordered bottom-up by stability and merge order",
        primitives: &["jj new", "jj new -B / -A", "jj rebase -r X -B Y"],
        publishing: "Publish bottom layer(s) once independently reviewable; keep draft top layers local.",
    };
    static PARALLEL: CanonicalShape = CanonicalShape {
        scenario: "Unrelated concurrent tasks / context switch",
        dag: "Parallel sibling arms off trunk()",
        primitives: &["jj new trunk()", "jj parallelize", "jj split --parallel"],
        publishing: "Independent bookmarks / PRs that can land in any order.",
    };
    static MEGAMERGE: CanonicalShape = CanonicalShape {
        scenario: "Simultaneous multi-branch development and full-app testing",
        dag: "Parallel arms joined by a local-only octopus megamerge + empty @",
        primitives: &[
            "jj new a b c -m \"local: dev megamerge\"",
            "jj absorb",
            "jj squash --into",
        ],
        publishing: "Never push the megamerge; push only the underlying feature arms.",
    };
    static BRANCHING: CanonicalShape = CanonicalShape {
        scenario: "Not canonical: a stack that forks",
        dag: "One root whose descendants fork into several heads",
        primitives: &["jj parallelize", "jj rebase -s X -o trunk()"],
        publishing: "Run the Two-Part Dependency Test on each fork; independent heads belong off trunk().",
    };
    match shape {
        DagShape::Resting => &RESTING,
        DagShape::Single => &SINGLE,
        DagShape::Stack => &STACK,
        DagShape::Parallel => &PARALLEL,
        DagShape::Megamerge => &MEGAMERGE,
        DagShape::Branching => &BRANCHING,
    }
}

/// What is known about one snapshot's formatting, build and tests. `None`
/// means not checked for this snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VerificationStatus {
    pub formatted: Option<bool>,
    pub builds: Option<bool>,
    pub tests_pass: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unformatted_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

impl VerificationStatus {
    /// Nothing is known about the snapshot.
    pub fn unknown() -> Self {
        Self {
            verified: Some(false),
            ..Self::default()
        }
    }
}

/// Whether a verification record proves a revision green, red, or nothing yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationState {
    Green,
    Red,
    Unknown,
}

impl VerificationState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Green => "green",
            Self::Red => "red",
            Self::Unknown => "unknown",
        }
    }
}

/// Green when formatted, building and passing tests; red when any of them
/// failed; unknown otherwise.
pub fn verification_state(v: Option<&VerificationStatus>) -> VerificationState {
    let Some(v) = v else {
        return VerificationState::Unknown;
    };
    let checks = [v.formatted, v.builds, v.tests_pass];
    if checks.contains(&Some(false)) {
        return VerificationState::Red;
    }
    if v.verified != Some(false) && checks.iter().all(|c| *c == Some(true)) {
        return VerificationState::Green;
    }
    VerificationState::Unknown
}

static TEST_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^|/)(tests?|__tests__|specs?|testdata|fixtures)/|[._-](test|spec)s?\.[^/]+$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb|exs?)$").unwrap()
});
static CODE_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\.(m?[jt]sx?|cjs|cts|py|rb|go|rs|java|kts?|scala|swift|c|cc|cpp|cxx|h|hh|hpp|cs|php|exs?|erl|hs|ml|clj|lua|dart|zig|nim|vue|svelte)$").unwrap()
});

/// Whether a repository path holds tests or test fixtures.
pub fn is_test_path(path: &str) -> bool {
    TEST_PATH_RE.is_match(path)
}

/// Whether a repository path holds program code (as opposed to docs or config).
pub fn is_code_path(path: &str) -> bool {
    CODE_PATH_RE.is_match(path)
}

/// What the offline intent heuristic looks at.
#[derive(Clone, Copy, Debug, Default)]
pub struct IntentInfo<'a> {
    pub description: &'a str,
    pub is_empty: bool,
    pub is_working_copy: bool,
    pub mutable_parent_count: usize,
    pub touched_paths: &'a [String],
    /// Defaults to `local:` when `None`.
    pub megamerge_prefix: Option<&'a str>,
}

static STRUCTURAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(refactor|style|tidy|chore)(\(|:|!|\s)").unwrap());
static TEST_DESC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(test|tests)(\(|:|!|\s)").unwrap());
static ACTIVATION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(enable|activate|flip|wire|rollout)\b").unwrap());
static ACTIVATION_WORD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(feature[_ -]?flag|activation)\b").unwrap());

/// Deterministic fallback for a change's intent, from its description,
/// emptiness, parent count and touched paths, for when Jev is offline.
pub fn infer_intent_fallback(info: &IntentInfo<'_>) -> ChangeIntent {
    let desc = info.description.trim();
    let lower = desc.to_lowercase();
    let prefix = info.megamerge_prefix.unwrap_or("local:").to_lowercase();

    if lower.starts_with(&prefix) || lower.contains("megamerge") || info.mutable_parent_count >= 2 {
        return ChangeIntent::Megamerge;
    }
    if info.is_working_copy && info.is_empty && desc.is_empty() {
        return ChangeIntent::WorkingCopy;
    }
    if info.is_empty && !desc.is_empty() && !info.is_working_copy {
        return ChangeIntent::Blueprint;
    }
    if !info.touched_paths.is_empty() && info.touched_paths.iter().all(|p| is_test_path(p)) {
        return ChangeIntent::TestHarness;
    }
    if STRUCTURAL_RE.is_match(desc) {
        return ChangeIntent::Structural;
    }
    if TEST_DESC_RE.is_match(desc) {
        return ChangeIntent::TestHarness;
    }
    if ACTIVATION_RE.is_match(desc) || ACTIVATION_WORD_RE.is_match(&lower) {
        return ChangeIntent::Activation;
    }
    if info.is_working_copy && desc.is_empty() {
        return ChangeIntent::WorkingCopy;
    }
    ChangeIntent::Behavioral
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_validated_and_normalized() {
        assert_eq!(as_change_id(" KXSYTNVQ ").unwrap(), "kxsytnvq");
        let err = as_change_id("84d55c64").unwrap_err();
        assert_eq!(err.expected_kind, IdKind::ChangeId);
        assert!(err.message.contains("looks like a hex CommitId"));
        assert!(
            as_commit_id("kxsytnvq")
                .unwrap_err()
                .message
                .contains("reverse-hex ChangeId")
        );
        assert!(as_op_id("0123abcd").is_ok());
        assert!(as_bookmark("has space").is_err());
        assert_eq!(short("kxsytnvqrtwozzzz"), "kxsytnvq");
        assert_eq!(short("abc"), "abc");
    }

    #[test]
    fn verification_states() {
        assert_eq!(verification_state(None), VerificationState::Unknown);
        let green = VerificationStatus {
            formatted: Some(true),
            builds: Some(true),
            tests_pass: Some(true),
            verified: Some(true),
            ..Default::default()
        };
        assert_eq!(verification_state(Some(&green)), VerificationState::Green);
        let red = VerificationStatus {
            tests_pass: Some(false),
            ..green.clone()
        };
        assert_eq!(verification_state(Some(&red)), VerificationState::Red);
        assert_eq!(
            verification_state(Some(&VerificationStatus::unknown())),
            VerificationState::Unknown
        );
    }

    #[test]
    fn intents() {
        let paths = vec!["src/a_test.go".to_owned()];
        let info = |d: &'static str| IntentInfo {
            description: d,
            ..Default::default()
        };
        assert_eq!(
            infer_intent_fallback(&info("refactor: extract helper")),
            ChangeIntent::Structural
        );
        assert_eq!(
            infer_intent_fallback(&info("local: dev megamerge")),
            ChangeIntent::Megamerge
        );
        assert_eq!(
            infer_intent_fallback(&info("Enable the new parser")),
            ChangeIntent::Activation
        );
        assert_eq!(
            infer_intent_fallback(&IntentInfo {
                touched_paths: &paths,
                ..info("fix")
            }),
            ChangeIntent::TestHarness
        );
        assert_eq!(
            infer_intent_fallback(&IntentInfo {
                is_empty: true,
                ..info("plan the stack")
            }),
            ChangeIntent::Blueprint
        );
        assert_eq!(
            infer_intent_fallback(&IntentInfo {
                is_empty: true,
                is_working_copy: true,
                ..info("")
            }),
            ChangeIntent::WorkingCopy
        );
        assert!(is_code_path("src/lib.rs") && !is_code_path("README.md"));
        assert!(is_test_path("tests/graph.rs") && is_test_path("web/app.spec.ts"));
    }
}
