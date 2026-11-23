//! TypeSafe Jev System-One decisions.
//!
//! A wire-compatible `POST /v1/systemone` client (`choice`, `score` and
//! `noul` questions) with a calibrated offline fallback, and the jjr
//! workflows built on it: single-pass change triage, the Two-Part Dependency
//! Gate, scratchpad and blast-radius risk advisories, dual time-axis recovery
//! routing, and ambiguous `jj absorb` hunk routing. Set `TYPESAFE_API_KEY`
//! for live inference.
//!
//! Port of `jjr/jev.mjs`.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use indexmap::IndexMap;
use indexmap::IndexSet;
use regex::Regex;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::graph::DependencyAssessment;
use crate::graph::DependencyVerdict;
use crate::graph::JjrChange;
use crate::graph::JjrGraph;
use crate::guardrails::GuardrailAction;
use crate::types::ChangeIntent;
use crate::types::IntentInfo;
use crate::types::infer_intent_fallback;
use crate::types::is_test_path;

/// Where an answer came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JevSource {
    LiveJev,
    CalibratedOffline,
}

impl JevSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LiveJev => "live-jev",
            Self::CalibratedOffline => "calibrated-offline",
        }
    }
}

/// Labels for the two outcomes of a `noul` question.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoulCriteria {
    #[serde(rename = "true", default, skip_serializing_if = "Option::is_none")]
    pub when_true: Option<String>,
    #[serde(rename = "false", default, skip_serializing_if = "Option::is_none")]
    pub when_false: Option<String>,
}

/// A System-One question.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    /// Pick one of the criteria's keys.
    Choice {
        instructions: String,
        criteria: IndexMap<String, Option<String>>,
    },
    /// Rate on the ordered scale of criteria.
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
    /// The probability that a statement is true.
    Noul {
        instructions: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        criteria: Option<NoulCriteria>,
    },
}

pub fn choice<K: Into<String>>(
    instructions: impl Into<String>,
    criteria: impl IntoIterator<Item = (K, Option<String>)>,
) -> Question {
    Question::Choice {
        instructions: instructions.into(),
        criteria: criteria.into_iter().map(|(k, v)| (k.into(), v)).collect(),
    }
}

pub fn score<S: Into<String>>(
    instructions: impl Into<String>,
    criteria: impl IntoIterator<Item = S>,
) -> Question {
    Question::Score {
        instructions: instructions.into(),
        criteria: criteria.into_iter().map(Into::into).collect(),
    }
}

pub fn noul(instructions: impl Into<String>, criteria: Option<NoulCriteria>) -> Question {
    Question::Noul {
        instructions: instructions.into(),
        criteria,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChoiceAnswer {
    pub choice: String,
    pub probabilities: IndexMap<String, f64>,
    pub confidence: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScoreAnswer {
    pub score: f64,
    pub legend: String,
    pub probabilities: Vec<f64>,
    pub confidence: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct NoulAnswer {
    pub noul: f64,
}

/// A `POST /v1/systemone` request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SystemOneRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub state: serde_json::Value,
    pub questions: IndexMap<String, Question>,
}

/// A `POST /v1/systemone` response: one answer per question key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SystemOneResponse {
    pub answers: IndexMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<IndexMap<String, f64>>,
}

#[derive(Debug, thiserror::Error)]
pub enum JevError {
    #[error("TypeSafe Jev is not configured (set TYPESAFE_API_KEY).")]
    NotConfigured,
    #[error("TypeSafe Jev request failed: {0}")]
    Http(String),
    #[error("Unexpected TypeSafe Jev response: {0}")]
    Response(String),
}

/// Settings for a [`JevClient`]; `None` falls back to the environment
/// (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_JEV_MODEL`) and then
/// the defaults.
#[derive(Clone, Debug, Default)]
pub struct JevClientOptions {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub timeout: Option<Duration>,
}

const DEFAULT_BASE_URL: &str = "https://api.typesafe.ai";
const DEFAULT_MODEL: &str = "jev-latest";
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(8000);
/// The model offline answers report.
const OFFLINE_MODEL: &str = "offline-heuristic";

/// An environment variable; set-but-empty counts as set, like `??` in JS.
pub(crate) fn env_var(name: &str) -> Option<String> {
    std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
}

/// The first `n` UTF-16 code units of `s`, like JS `s.slice(0, n)`, without
/// splitting a character.
pub(crate) fn js_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// A TypeSafe Jev client.
#[derive(Clone, Debug)]
pub struct JevClient {
    api_key: String,
    base_url: String,
    default_model: String,
    timeout: Duration,
    agent: ureq::Agent,
}

/// The body of a `POST /v1/systemone`, in the key order the JS client sends.
#[derive(Serialize)]
struct WireRequest<'a, S> {
    model: &'a str,
    state: &'a S,
    questions: &'a IndexMap<String, Question>,
}

/// A `POST /v1/systemone` response with its answers read as `A`.
#[derive(Deserialize)]
struct WireResponse<A> {
    answers: A,
    #[serde(default, deserialize_with = "lenient_usage")]
    usage: Option<IndexMap<String, f64>>,
}

/// Token usage, keeping the numeric entries and dropping a malformed record
/// rather than failing the call.
fn lenient_usage<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<IndexMap<String, f64>>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Usage {
        Map(IndexMap<String, serde_json::Value>),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Usage::deserialize(deserializer)? {
        Usage::Map(map) => Some(
            map.into_iter()
                .filter_map(|(k, v)| v.as_f64().map(|n| (k, n)))
                .collect(),
        ),
        Usage::Other(_) => None,
    })
}

impl JevClient {
    pub fn new(options: JevClientOptions) -> Self {
        let api_key = options
            .api_key
            .or_else(|| env_var("TYPESAFE_API_KEY"))
            .unwrap_or_default();
        let base_url = options
            .base_url
            .or_else(|| env_var("TYPESAFE_BASE_URL"))
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let default_model = options
            .default_model
            .or_else(|| env_var("TYPESAFE_JEV_MODEL"))
            .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
        let timeout = options.timeout.unwrap_or(DEFAULT_TIMEOUT);
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // Like Node's fetch, which the JS client uses: no *_PROXY variables.
            .proxy(None)
            .timeout_global(Some(timeout))
            .build();
        Self {
            api_key,
            base_url: base_url.trim_end_matches('/').to_owned(),
            default_model,
            timeout,
            agent: ureq::Agent::new_with_config(config),
        }
    }

    /// A client configured from the environment.
    pub fn from_env() -> Self {
        Self::new(JevClientOptions::default())
    }

    pub fn is_configured(&self) -> bool {
        !self.api_key.is_empty()
    }

    pub fn default_model(&self) -> &str {
        &self.default_model
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    pub fn system_one(&self, request: &SystemOneRequest) -> Result<SystemOneResponse, JevError> {
        let res: WireResponse<IndexMap<String, serde_json::Value>> =
            self.post(request.model.as_deref(), &request.state, &request.questions)?;
        Ok(SystemOneResponse {
            answers: res.answers,
            usage: res.usage,
        })
    }

    /// Execute a System One decision batch, reading the answers as `A`.
    fn post<S: Serialize, A: DeserializeOwned>(
        &self,
        model: Option<&str>,
        state: &S,
        questions: &IndexMap<String, Question>,
    ) -> Result<WireResponse<A>, JevError> {
        if self.api_key.is_empty() {
            return Err(JevError::NotConfigured);
        }
        let body = WireRequest {
            model: model.unwrap_or(&self.default_model),
            state,
            questions,
        };
        let body = serde_json::to_string(&body).map_err(|e| JevError::Response(e.to_string()))?;
        let mut res = self
            .agent
            .post(format!("{}/v1/systemone", self.base_url))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.api_key))
            .send(body)
            .map_err(|e| JevError::Http(e.to_string()))?;
        let status = res.status();
        if !status.is_success() {
            let text = res.body_mut().read_to_string().unwrap_or_default();
            return Err(JevError::Http(format!(
                "HTTP {}: {}",
                status.as_u16(),
                js_prefix(&text, 240)
            )));
        }
        let text = res
            .body_mut()
            .read_to_string()
            .map_err(|e| JevError::Http(e.to_string()))?;
        serde_json::from_str(&text).map_err(|e| JevError::Response(e.to_string()))
    }
}

/// What triage reads about a change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeTriageInput {
    pub change_id: String,
    pub description: String,
    pub touched_paths: Vec<String>,
    pub diff_excerpt: String,
    pub is_empty: bool,
    pub is_working_copy: bool,
    /// 1 when not given, as in the JS `mutableParentCount ?? 1`.
    pub mutable_parent_count: usize,
    pub is_conflicted: bool,
}

impl Default for ChangeTriageInput {
    fn default() -> Self {
        Self {
            change_id: String::new(),
            description: String::new(),
            touched_paths: Vec::new(),
            diff_excerpt: String::new(),
            is_empty: false,
            is_working_copy: false,
            mutable_parent_count: 1,
            is_conflicted: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageAnswers {
    pub intent: ChoiceAnswer,
    pub entangled: NoulAnswer,
    pub publish_readiness: ScoreAnswer,
    pub has_debug_or_secrets: NoulAnswer,
    /// Pair new APIs with a consumer: adds an API nothing in the change calls or tests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_without_consumer: Option<NoulAnswer>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChangeTriageResult {
    pub source: JevSource,
    pub model: String,
    pub answers: TriageAnswers,
    pub usage: Option<IndexMap<String, f64>>,
}

/// One side of a dependency question.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeContext {
    pub change_id: String,
    pub description: String,
    pub touched_paths: Vec<String>,
    pub diff_excerpt: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyAnswers {
    pub child_causally_depends_on_base: NoulAnswer,
    pub base_independently_reviewable: NoulAnswer,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DependencyAssessmentResult {
    pub source: JevSource,
    pub answers: DependencyAnswers,
    pub verdict: DependencyVerdict,
}

/// Jev's risk reading of an action.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRiskAssessment {
    pub source: JevSource,
    pub looks_like_scratchpad: NoulAnswer,
    pub blast_radius: ScoreAnswer,
}

/// What went wrong, for recovery routing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecoveryContext {
    pub symptom: Option<String>,
    pub target_change_id: Option<String>,
    pub sibling_arms_modified_since: Option<bool>,
    pub bookmark_or_topology_corrupted: Option<bool>,
}

/// Which time axis to recover along: `evolog`, `op-restore` or `undo`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecoveryRecommendation {
    pub source: JevSource,
    pub decision: ChoiceAnswer,
}

/// An arm an ambiguous hunk might belong to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CandidateArm {
    pub change_id: String,
    pub description: String,
    pub touched_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HunkRoute {
    pub source: JevSource,
    pub decision: Option<ChoiceAnswer>,
}

// ---------------------------------------------------------------------------
// Wire state, in the key order the JS workflows send.

#[derive(Serialize)]
struct TriageState<'a> {
    change_id: &'a str,
    description: &'a str,
    touched_paths: &'a [String],
    diff_excerpt: &'a str,
    is_empty: bool,
    is_working_copy: bool,
    mutable_parent_count: usize,
    is_conflicted: bool,
}

#[derive(Serialize)]
struct ChangeState<'a> {
    change_id: &'a str,
    description: &'a str,
    touched_paths: &'a [String],
    diff_excerpt: &'a str,
}

impl<'a> ChangeState<'a> {
    fn of(c: &'a ChangeContext) -> Self {
        Self {
            change_id: &c.change_id,
            description: &c.description,
            touched_paths: &c.touched_paths,
            diff_excerpt: js_prefix(&c.diff_excerpt, 4000),
        }
    }
}

#[derive(Serialize)]
struct DependencyState<'a> {
    base_change: ChangeState<'a>,
    child_change: ChangeState<'a>,
}

#[derive(Serialize)]
struct TargetState<'a> {
    change_id: &'a str,
    description: &'a str,
    intent: ChangeIntent,
    children_count: usize,
    is_conflicted: bool,
    is_empty: bool,
}

#[derive(Serialize)]
struct ActionState<'a> {
    action_type: &'a str,
    command: &'a str,
    targets: Vec<TargetState<'a>>,
    diff_excerpt: &'a str,
}

#[derive(Serialize)]
struct RecoveryState<'a> {
    symptom: &'a str,
    target_change_id: Option<&'a str>,
    sibling_arms_modified_since: bool,
    bookmark_or_topology_corrupted: bool,
}

#[derive(Serialize)]
struct HunkState<'a> {
    hunk_diff: &'a str,
}

// Live answers for the workflows without a public answers type.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RiskAnswers {
    looks_like_scratchpad: NoulAnswer,
    blast_radius: ScoreAnswer,
}

#[derive(Deserialize)]
struct RecoveryAnswers {
    axis: ChoiceAnswer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HunkAnswers {
    owner_arm: ChoiceAnswer,
}

// ---------------------------------------------------------------------------
// Questions.

fn described<'a>(pairs: &[(&'a str, &str)]) -> Vec<(&'a str, Option<String>)> {
    pairs
        .iter()
        .map(|(k, v)| (*k, Some((*v).to_owned())))
        .collect()
}

fn outcomes(when_true: &str, when_false: &str) -> Option<NoulCriteria> {
    Some(NoulCriteria {
        when_true: Some(when_true.to_owned()),
        when_false: Some(when_false.to_owned()),
    })
}

fn questions<const N: usize>(entries: [(&str, Question); N]) -> IndexMap<String, Question> {
    entries
        .into_iter()
        .map(|(k, q)| (k.to_owned(), q))
        .collect()
}

fn triage_questions() -> IndexMap<String, Question> {
    questions([
        (
            "intent",
            choice(
                "Classify the primary VCS intent of this Jujutsu change.",
                described(&[
                    (
                        "structural",
                        "Zero-behavior-change refactoring, renaming, extraction, or formatting (Tidy First?)",
                    ),
                    (
                        "behavioral",
                        "New feature, bug fix, or behavior change (with or without bundled tests)",
                    ),
                    (
                        "test-harness",
                        "Only test files, fixtures, or characterization test infrastructure",
                    ),
                    (
                        "activation",
                        "Small wiring change flipping a feature flag, route, or config switch",
                    ),
                    (
                        "blueprint",
                        "Intentional empty change whose description outlines a planned future step",
                    ),
                    (
                        "megamerge",
                        "Local integration merge combining 2+ mutable feature arms",
                    ),
                    (
                        "working-copy",
                        "Unfinished ephemeral @ scratchpad with no clear intent yet",
                    ),
                ]),
            ),
        ),
        (
            "entangled",
            noul(
                "Does this diff mix structural refactoring with behavioral changes that should be split?",
                outcomes(
                    "Contains both structural tidying (renames/moves/extractions) and new behavior or bugfixes",
                    "Focused cleanly on a single concern (either structural or behavioral)",
                ),
            ),
        ),
        (
            "publishReadiness",
            score(
                "How ready is this change to be reviewed and pushed to a shared forge?",
                ["scratchpad", "needs-cleanup", "reviewable", "ready-to-land"],
            ),
        ),
        (
            "hasDebugOrSecrets",
            noul(
                "Does the diff contain stray debug logging, temporary hacks, or hardcoded credentials?",
                outcomes(
                    "Contains console.log/dbg!/print debugging, FIXME/HACK markers, or API keys/tokens",
                    "Clean production or test code without debug artifacts or secrets",
                ),
            ),
        ),
        (
            "apiWithoutConsumer",
            noul(
                "Does this change add a new public API, interface, or abstraction that nothing in the change calls or tests?",
                outcomes(
                    "Adds exported functions, types, or interfaces with zero callers and no test exercising them",
                    "Every new API has at least one concrete caller or exercising test in the same change, or no API is added",
                ),
            ),
        ),
    ])
}

fn dependency_questions() -> IndexMap<String, Question> {
    questions([
        (
            "childCausallyDependsOnBase",
            noul(
                "Does child_change causally depend on base_change to compile, pass tests, or make logical sense?",
                outcomes(
                    "child_change calls symbols, modifies lines, or relies on behavior introduced in base_change",
                    "child_change touches independent modules/concerns and works cleanly directly atop trunk()",
                ),
            ),
        ),
        (
            "baseIndependentlyReviewable",
            noul(
                "Can base_change be reviewed, understood, and merged safely without reading child_change?",
                outcomes(
                    "base_change is self-contained, builds cleanly, and has a coherent purpose on its own",
                    "base_change leaves broken callers, incomplete renames, or dead scaffolding only completed by child_change",
                ),
            ),
        ),
    ])
}

fn risk_questions() -> IndexMap<String, Question> {
    questions([
        (
            "looksLikeScratchpad",
            noul(
                "Does the targeted change look like an unfinished local scratchpad, WIP dump, or unmarked integration megamerge?",
                None,
            ),
        ),
        (
            "blastRadius",
            score(
                "What is the blast radius of this VCS action on the repository graph?",
                ["trivial", "single-change", "stack-wide", "repo-wide"],
            ),
        ),
    ])
}

fn recovery_questions() -> IndexMap<String, Question> {
    questions([(
        "axis",
        choice(
            "Which Jujutsu recovery time axis minimizes collateral loss?",
            described(&[
                (
                    "evolog",
                    "Surgical single-change restore (`jj restore --from <commit> --to <change>`) preserving sibling arms",
                ),
                (
                    "op-restore",
                    "Repository-wide rewind (`jj op restore <op>`) when bookmarks or multi-branch topology broke",
                ),
                (
                    "undo",
                    "Simple `jj undo` when the immediately preceding operation was a mistake",
                ),
            ]),
        ),
    )])
}

// ---------------------------------------------------------------------------
// Calibrated numbers.

/// JS `Math.round`: halves go toward +∞.
fn js_round(x: f64) -> f64 {
    let r = x.round();
    if x - r == 0.5 { r + 1.0 } else { r }
}

/// Clamp and round a calibrated probability.
fn prob(v: f64) -> f64 {
    js_round(v.clamp(0.01, 0.99) * 100.0) / 100.0
}

fn normalize_dist(raw: &IndexMap<String, f64>) -> ChoiceAnswer {
    let sum = raw.values().fold(0.0, |acc, v| acc + v);
    // `sum || 1`
    let sum = if sum == 0.0 || sum.is_nan() { 1.0 } else { sum };
    let mut probabilities = IndexMap::new();
    let mut best_key = raw.keys().next().cloned().unwrap_or_default();
    let mut best_val = -1.0;
    for (k, v) in raw {
        let p = js_round(v / sum * 1000.0) / 1000.0;
        probabilities.insert(k.clone(), p);
        if p > best_val {
            best_val = p;
            best_key = k.clone();
        }
    }
    ChoiceAnswer {
        choice: best_key,
        probabilities,
        confidence: best_val,
    }
}

/// A four-level score answer peaked at `idx`.
fn score_answer(levels: [&str; 4], mut raw: [f64; 4], idx: usize, peak: f64) -> ScoreAnswer {
    raw[idx] = peak;
    let sum = raw.iter().fold(0.0, |acc, v| acc + v);
    let probabilities: Vec<f64> = raw
        .iter()
        .map(|v| js_round(v / sum * 1000.0) / 1000.0)
        .collect();
    let expected = probabilities
        .iter()
        .enumerate()
        .fold(0.0, |acc, (i, p)| acc + p * i as f64);
    ScoreAnswer {
        score: js_round(expected * 100.0) / 100.0,
        legend: levels[idx].to_owned(),
        confidence: probabilities[idx],
        probabilities,
    }
}

// The offline heuristics' patterns, with JS semantics: ASCII word
// boundaries, ASCII case folding, and `.` stopping at line terminators.

static REFACTOR_SIGNALS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(rename|extract|refactor|cleanup|move|inline)\b").unwrap()
});
static FEATURE_SIGNALS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\b(feat|add|support|endpoint|handler|fix|bug)\b").unwrap());
static TRIAGE_DEBUG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b(console\.log|debugger|dbg!|print\(|TODO:|FIXME:|HACK:|sk-[a-z0-9]{12,}|AKIA[0-9A-Z]{16})\b").unwrap()
});
static WIP_DESCRIPTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\b(wip|tmp|scratch|test)\b").unwrap());
static ADDED_API_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?mR)^\+\s*(?:",
        r"export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)",
        r"|pub\s+(?:async\s+)?(?:fn|struct|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"|def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(",
        r")",
    ))
    .unwrap()
});
static BASE_SYMBOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)\b(rename|interface|schema|type|extract)\b").unwrap());
static BASE_INCOMPLETE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)(wip|part\s*1|todo|broken|without caller|rename helper)(?-u:\b)")
        .unwrap()
});
static CALLER_FIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)(update[^\n\r\u{2028}\u{2029}]*caller|fix[^\n\r\u{2028}\u{2029}]*caller)(?-u:\b)").unwrap()
});
static WIP_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^(wip|tmp|local:|scratch|fixup)").unwrap());
static RISK_DEBUG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\b(console\.log|debugger|TODO:|FIXME:)\b").unwrap());
static OP_RESTORE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?i-u:op)\s+(?i-u:restore|revert)").unwrap());

const INTENT_PRIORS: [(&str, f64); 7] = [
    ("structural", 0.06),
    ("behavioral", 0.08),
    ("test-harness", 0.05),
    ("activation", 0.04),
    ("blueprint", 0.04),
    ("megamerge", 0.03),
    ("working-copy", 0.05),
];
const READINESS_LEVELS: [&str; 4] = ["scratchpad", "needs-cleanup", "reviewable", "ready-to-land"];
const BLAST_RADIUS_LEVELS: [&str; 4] = ["trivial", "single-change", "stack-wide", "repo-wide"];

fn offline_triage(input: &ChangeTriageInput) -> TriageAnswers {
    let desc = input.description.trim();
    let diff = input.diff_excerpt.as_str();
    let inferred = infer_intent_fallback(&IntentInfo {
        description: desc,
        is_empty: input.is_empty,
        is_working_copy: input.is_working_copy,
        mutable_parent_count: input.mutable_parent_count,
        touched_paths: &input.touched_paths,
        megamerge_prefix: None,
    });

    let mut intent_weights: IndexMap<String, f64> = INTENT_PRIORS
        .iter()
        .map(|(k, v)| ((*k).to_owned(), *v))
        .collect();
    intent_weights.insert(inferred.as_str().to_owned(), 0.72);
    let intent = normalize_dist(&intent_weights);

    let text = format!("{desc}\n{diff}");
    let has_refactor_signals = REFACTOR_SIGNALS_RE.is_match(&text);
    let has_feature_signals = FEATURE_SIGNALS_RE.is_match(&text);
    let entangled = prob(if has_refactor_signals && has_feature_signals {
        0.84
    } else if has_refactor_signals || has_feature_signals {
        0.18
    } else {
        0.35
    });

    let has_debug = TRIAGE_DEBUG_RE.is_match(diff);
    let debug = prob(if has_debug { 0.91 } else { 0.06 });

    let level = if input.is_conflicted
        || matches!(
            inferred,
            ChangeIntent::Megamerge | ChangeIntent::WorkingCopy
        )
        || desc.is_empty()
    {
        0
    } else if has_debug || entangled > 0.7 || WIP_DESCRIPTION_RE.is_match(desc) {
        1
    } else if !input.touched_paths.is_empty() && desc.encode_utf16().count() >= 12 {
        3
    } else {
        2
    };

    TriageAnswers {
        intent,
        entangled: NoulAnswer { noul: entangled },
        publish_readiness: score_answer(READINESS_LEVELS, [0.05, 0.08, 0.12, 0.05], level, 0.75),
        has_debug_or_secrets: NoulAnswer { noul: debug },
        api_without_consumer: Some(NoulAnswer {
            noul: offline_api_without_consumer(diff, &input.touched_paths),
        }),
    }
}

/// Pair New APIs with a Consumer: exported symbols the diff adds but never
/// uses elsewhere in the same diff, with no test file touched.
fn offline_api_without_consumer(diff: &str, touched_paths: &[String]) -> f64 {
    let added: Vec<&str> = ADDED_API_RE
        .captures_iter(diff)
        .filter_map(|c| {
            c.get(1)
                .or_else(|| c.get(2))
                .or_else(|| c.get(3))
                .map(|m| m.as_str())
        })
        .collect();
    if added.is_empty() {
        return prob(0.05);
    }
    let tests_touched = touched_paths.iter().any(|p| is_test_path(p));
    let exercised = added.iter().any(|name| {
        Regex::new(&format!(r"(?-u:\b){}(?-u:\b)", regex::escape(name)))
            .is_ok_and(|re| re.find_iter(diff).count() >= 2)
    });
    prob(if exercised || tests_touched {
        0.16
    } else {
        0.82
    })
}

/// The directory of a path (`p.split('/').slice(0, -1).join('/')`).
fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

fn offline_dependency(base: &ChangeContext, child: &ChangeContext) -> DependencyAnswers {
    let base_paths: IndexSet<&str> = base.touched_paths.iter().map(String::as_str).collect();
    let child_paths: IndexSet<&str> = child.touched_paths.iter().map(String::as_str).collect();
    let overlap = child_paths.iter().any(|p| base_paths.contains(p));

    let base_text = format!("{} {}", base.description, base.diff_excerpt).to_lowercase();
    let child_text = format!("{} {}", child.description, child.diff_excerpt).to_lowercase();

    // Shared identifier tokens or overlapping files.
    let base_dirs: HashSet<&str> = base_paths.iter().map(|p| dir_of(p)).collect();
    let shared_dir = child_paths
        .iter()
        .any(|p| base_dirs.contains(dir_of(p)) && p.contains('/'));

    let mentions_base_symbol = overlap || (BASE_SYMBOL_RE.is_match(&base_text) && shared_dir);
    let base_looks_incomplete =
        BASE_INCOMPLETE_RE.is_match(&base_text) || (overlap && CALLER_FIX_RE.is_match(&child_text));

    let causal = prob(if overlap {
        0.89
    } else if mentions_base_symbol {
        0.81
    } else if shared_dir {
        0.52
    } else {
        0.11
    });
    let reviewable = prob(if base_looks_incomplete { 0.14 } else { 0.88 });
    DependencyAnswers {
        child_causally_depends_on_base: NoulAnswer { noul: causal },
        base_independently_reviewable: NoulAnswer { noul: reviewable },
    }
}

fn offline_action_risk(
    target_nodes: &[&JjrChange],
    action: &GuardrailAction,
    diff_excerpt: &str,
) -> (NoulAnswer, ScoreAnswer) {
    let any_wip = target_nodes.iter().any(|n| {
        let d = n.current_commit.description.trim();
        d.is_empty() || WIP_PREFIX_RE.is_match(d) || n.intent == ChangeIntent::WorkingCopy
    });
    let has_debug = RISK_DEBUG_RE.is_match(diff_excerpt);
    let scratchpad = prob(if any_wip {
        0.86
    } else if has_debug {
        0.54
    } else {
        0.08
    });

    let total_children: usize = target_nodes.iter().map(|n| n.children.len()).sum();
    let restores =
        matches!(action, GuardrailAction::Mutate(m) if OP_RESTORE_RE.is_match(&m.command));
    let idx = if restores {
        3
    } else if total_children >= 2 || matches!(action, GuardrailAction::Push(_)) {
        2
    } else if target_nodes.len() <= 1 && total_children == 0 {
        0
    } else {
        1
    };
    (
        NoulAnswer { noul: scratchpad },
        score_answer(BLAST_RADIUS_LEVELS, [0.06, 0.08, 0.08, 0.04], idx, 0.78),
    )
}

/// The jjr workflows on top of Jev. Without a configured client every
/// answer comes from the calibrated offline heuristics.
#[derive(Clone, Debug)]
pub struct JjrJevAssistant {
    client: Option<JevClient>,
}

impl Default for JjrJevAssistant {
    fn default() -> Self {
        Self::from_env()
    }
}

impl JjrJevAssistant {
    pub fn new(client: Option<JevClient>) -> Self {
        Self { client }
    }

    /// An assistant with a client configured from the environment.
    pub fn from_env() -> Self {
        Self::new(Some(JevClient::from_env()))
    }

    /// An assistant that never calls out.
    pub fn offline() -> Self {
        Self::new(None)
    }

    pub fn client(&self) -> Option<&JevClient> {
        self.client.as_ref()
    }

    /// `live-jev` with a configured client, `calibrated-offline` otherwise.
    pub fn mode(&self) -> JevSource {
        if self.client.as_ref().is_some_and(JevClient::is_configured) {
            JevSource::LiveJev
        } else {
            JevSource::CalibratedOffline
        }
    }

    /// The client to ask, when one is configured.
    fn live(&self) -> Option<&JevClient> {
        self.client.as_ref().filter(|c| c.is_configured())
    }

    /// Single-pass change triage, five questions in one System One call:
    /// intent (`choice`), entanglement (`noul`), publish readiness (`score`),
    /// debug output or secrets (`noul`), and a new API without a consumer (`noul`).
    pub fn triage_change(&self, input: &ChangeTriageInput) -> ChangeTriageResult {
        let state = TriageState {
            change_id: &input.change_id,
            description: &input.description,
            touched_paths: &input.touched_paths,
            diff_excerpt: js_prefix(&input.diff_excerpt, 6000),
            is_empty: input.is_empty,
            is_working_copy: input.is_working_copy,
            mutable_parent_count: input.mutable_parent_count,
            is_conflicted: input.is_conflicted,
        };
        if let Some(client) = self.live()
            && let Ok(res) = client.post::<_, TriageAnswers>(None, &state, &triage_questions())
        {
            return ChangeTriageResult {
                source: JevSource::LiveJev,
                model: client.default_model.clone(),
                answers: res.answers,
                usage: res.usage,
            };
        }
        // Fall through to the calibrated offline heuristic so the VCS flow never stalls.
        ChangeTriageResult {
            source: JevSource::CalibratedOffline,
            model: OFFLINE_MODEL.to_owned(),
            answers: offline_triage(input),
            usage: None,
        }
    }

    /// The Two-Part Dependency Test via Jev: causal necessity and independent
    /// reviewability (`noul` x 2), fed into [`JjrGraph::evaluate_dependency`].
    pub fn assess_dependency(
        &self,
        base: &ChangeContext,
        child: &ChangeContext,
    ) -> DependencyAssessmentResult {
        let state = DependencyState {
            base_change: ChangeState::of(base),
            child_change: ChangeState::of(child),
        };
        let live = self.live().and_then(|c| {
            c.post::<_, DependencyAnswers>(None, &state, &dependency_questions())
                .ok()
        });
        let (source, answers) = match live {
            Some(res) => (JevSource::LiveJev, res.answers),
            None => (
                JevSource::CalibratedOffline,
                offline_dependency(base, child),
            ),
        };
        let verdict = JjrGraph::evaluate_dependency(&DependencyAssessment {
            base: base.change_id.clone(),
            child: child.change_id.clone(),
            causal_probability: Some(answers.child_causally_depends_on_base.noul),
            reviewability_probability: Some(answers.base_independently_reviewable.noul),
            ..DependencyAssessment::default()
        });
        DependencyAssessmentResult {
            source,
            answers,
            verdict,
        }
    }

    /// Behind-the-scenes guardrail risk: unmarked scratchpads or megamerges
    /// (`noul`) and the blast radius (`score`) that decides whether to dry-run first.
    pub fn evaluate_action_risk(
        &self,
        graph: &JjrGraph,
        action: &GuardrailAction,
        diff_excerpt: &str,
    ) -> ActionRiskAssessment {
        let target_nodes: Vec<&JjrChange> = action
            .target_changes()
            .iter()
            .filter_map(|id| graph.get_any(id))
            .collect();
        let command = match action {
            GuardrailAction::Mutate(m) => m.command.as_str(),
            GuardrailAction::GitInterop(g) => g.raw_git_command.as_str(),
            _ => "",
        };
        let state = ActionState {
            action_type: action.kind(),
            command,
            targets: target_nodes
                .iter()
                .map(|n| TargetState {
                    change_id: &n.change_id,
                    description: &n.current_commit.description,
                    intent: n.intent,
                    children_count: n.children.len(),
                    is_conflicted: n.current_commit.conflict.is_conflicted,
                    is_empty: n.current_commit.is_empty,
                })
                .collect(),
            diff_excerpt: js_prefix(diff_excerpt, 3000),
        };
        if let Some(client) = self.live()
            && let Ok(res) = client.post::<_, RiskAnswers>(None, &state, &risk_questions())
        {
            return ActionRiskAssessment {
                source: JevSource::LiveJev,
                looks_like_scratchpad: res.answers.looks_like_scratchpad,
                blast_radius: res.answers.blast_radius,
            };
        }
        let (looks_like_scratchpad, blast_radius) =
            offline_action_risk(&target_nodes, action, diff_excerpt);
        ActionRiskAssessment {
            source: JevSource::CalibratedOffline,
            looks_like_scratchpad,
            blast_radius,
        }
    }

    /// Dual time-axis recovery (`choice`): surgical single-change `evolog`
    /// restore, repository-wide `op restore`, or `jj undo`.
    pub fn recommend_recovery(&self, context: &RecoveryContext) -> RecoveryRecommendation {
        let target = context.target_change_id.as_deref();
        let sibling_arms = context.sibling_arms_modified_since.unwrap_or(false);
        let corrupted = context.bookmark_or_topology_corrupted.unwrap_or(false);
        let state = RecoveryState {
            symptom: context.symptom.as_deref().unwrap_or(""),
            target_change_id: target,
            sibling_arms_modified_since: sibling_arms,
            bookmark_or_topology_corrupted: corrupted,
        };
        if let Some(client) = self.live()
            && let Ok(res) = client.post::<_, RecoveryAnswers>(None, &state, &recovery_questions())
        {
            return RecoveryRecommendation {
                source: JevSource::LiveJev,
                decision: res.answers.axis,
            };
        }
        let has_target = target.is_some_and(|t| !t.is_empty());
        let weights: IndexMap<String, f64> = [
            (
                "evolog",
                if has_target && sibling_arms {
                    0.88
                } else if has_target {
                    0.62
                } else {
                    0.12
                },
            ),
            ("op-restore", if corrupted { 0.86 } else { 0.2 }),
            (
                "undo",
                if !sibling_arms && !corrupted {
                    0.78
                } else {
                    0.14
                },
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        RecoveryRecommendation {
            source: JevSource::CalibratedOffline,
            decision: normalize_dist(&weights),
        }
    }

    /// Absorb and split hunk routing (`choice`): when a working-copy fixup
    /// atop a megamerge could belong to several arms, rank the candidates.
    pub fn route_hunk(&self, hunk_diff: &str, candidate_arms: &[CandidateArm]) -> HunkRoute {
        if candidate_arms.is_empty() {
            return HunkRoute {
                source: JevSource::CalibratedOffline,
                decision: None,
            };
        }
        let mut criteria: IndexMap<String, Option<String>> = IndexMap::new();
        for arm in candidate_arms {
            let files = arm
                .touched_paths
                .iter()
                .take(6)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            let title = arm.description.split('\n').next().unwrap_or_default();
            let title = if title.is_empty() {
                "(undescribed)"
            } else {
                title
            };
            let files = if files.is_empty() {
                String::new()
            } else {
                format!(" [files: {files}]")
            };
            criteria.insert(arm.change_id.clone(), Some(format!("{title}{files}")));
        }
        let asked = questions([(
            "ownerArm",
            choice(
                "Which parallel feature arm should absorb this diff hunk?",
                criteria,
            ),
        )]);

        if let Some(client) = self.live()
            && let Ok(res) = client.post::<_, HunkAnswers>(
                None,
                &HunkState {
                    hunk_diff: js_prefix(hunk_diff, 4000),
                },
                &asked,
            )
        {
            return HunkRoute {
                source: JevSource::LiveJev,
                decision: Some(res.answers.owner_arm),
            };
        }

        let lower_hunk = hunk_diff.to_lowercase();
        let mut weights: IndexMap<String, f64> = IndexMap::new();
        for arm in candidate_arms {
            let mut w = 0.15;
            let text =
                format!("{} {}", arm.description, arm.touched_paths.join(" ")).to_lowercase();
            let tokens: IndexSet<&str> = text
                .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
                .filter(|t| t.len() >= 3)
                .collect();
            for tok in tokens {
                if lower_hunk.contains(tok) {
                    w += 0.25;
                }
            }
            weights.insert(arm.change_id.clone(), w);
        }
        HunkRoute {
            source: JevSource::CalibratedOffline,
            decision: Some(normalize_dist(&weights)),
        }
    }
}
