//! The light LLM narrator (System Two): prose strictly for naming changes,
//! bookmark slugs, and two-sentence diagnostic summaries, with a
//! deterministic fallback. Configure an OpenAI-compatible endpoint with
//! `JJR_LLM_API_KEY` or `OPENAI_API_KEY`.
//!
//! Port of `jjr/narrator.mjs`.

use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::graph::DependencyAssessment;
use crate::graph::DependencyOutcome;
use crate::graph::JjrChange;
use crate::graph::JjrGraph;
use crate::graph::Severity;
use crate::jev::ChangeTriageInput;
use crate::jev::JjrJevAssistant;
use crate::jev::env_var;
use crate::jev::js_prefix;
use crate::types::ChangeIntent;
use crate::types::short;

#[derive(Debug, thiserror::Error)]
pub enum NarratorError {
    #[error("No LLM is configured (set JJR_LLM_API_KEY or OPENAI_API_KEY).")]
    NotConfigured,
    #[error("LLM request failed: {0}")]
    Http(String),
    #[error("Unexpected LLM response: {0}")]
    Response(String),
}

/// A chat-completion endpoint.
pub trait LlmTransport: Send + Sync {
    fn is_configured(&self) -> bool {
        true
    }

    fn complete(&self, system_prompt: &str, user_prompt: &str) -> Result<String, NarratorError>;
}

/// Settings for an [`OpenAiCompatibleTransport`]; `None` falls back to the
/// environment and then the defaults.
#[derive(Clone, Debug, Default)]
pub struct OpenAiTransportOptions {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4o-mini";

/// An OpenAI-compatible `/chat/completions` endpoint.
#[derive(Clone, Debug)]
pub struct OpenAiCompatibleTransport {
    api_key: String,
    base_url: String,
    model: String,
    agent: ureq::Agent,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    temperature: f64,
    messages: [ChatMessage<'a>; 2],
}

impl OpenAiCompatibleTransport {
    pub fn new(options: OpenAiTransportOptions) -> Self {
        let api_key = options
            .api_key
            .or_else(|| env_var("JJR_LLM_API_KEY"))
            .or_else(|| env_var("OPENAI_API_KEY"))
            .unwrap_or_default();
        let base_url = options
            .base_url
            .or_else(|| env_var("JJR_LLM_BASE_URL"))
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let model = options
            .model
            .or_else(|| env_var("JJR_LLM_MODEL"))
            .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // Like Node's fetch, which the JS transport uses: no *_PROXY
            // variables, and undici's default connect, header and body timeouts.
            .proxy(None)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(300)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .build();
        Self {
            api_key,
            base_url: base_url.trim_end_matches('/').to_owned(),
            model,
            agent: ureq::Agent::new_with_config(config),
        }
    }

    pub fn from_env() -> Self {
        Self::new(OpenAiTransportOptions::default())
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

impl LlmTransport for OpenAiCompatibleTransport {
    fn is_configured(&self) -> bool {
        !self.api_key.is_empty()
    }

    fn complete(&self, system_prompt: &str, user_prompt: &str) -> Result<String, NarratorError> {
        if self.api_key.is_empty() {
            return Err(NarratorError::NotConfigured);
        }
        let body = ChatRequest {
            model: &self.model,
            temperature: 0.2,
            messages: [
                ChatMessage {
                    role: "system",
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user",
                    content: user_prompt,
                },
            ],
        };
        let body =
            serde_json::to_string(&body).map_err(|e| NarratorError::Response(e.to_string()))?;
        let mut res = self
            .agent
            .post(format!("{}/chat/completions", self.base_url))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.api_key))
            .send(body)
            .map_err(|e| NarratorError::Http(e.to_string()))?;
        let status = res.status();
        if !status.is_success() {
            return Err(NarratorError::Http(format!("HTTP {}", status.as_u16())));
        }
        let text = res
            .body_mut()
            .read_to_string()
            .map_err(|e| NarratorError::Http(e.to_string()))?;
        let data: Value =
            serde_json::from_str(&text).map_err(|e| NarratorError::Response(e.to_string()))?;
        // `data.choices?.[0]?.message?.content ?? ''`
        match data
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
        {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(content)) => Ok(content.clone()),
            Some(other) => Err(NarratorError::Response(format!(
                "message content is not text: {other}"
            ))),
        }
    }
}

/// What the narrator names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NamingInput {
    pub change_id: Option<String>,
    pub description: String,
    pub touched_paths: Vec<String>,
    pub diff_excerpt: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NarrationSource {
    Llm,
    Deterministic,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingSuggestion {
    pub conventional_title: String,
    pub bookmark_slug: String,
    pub detected_intent: ChangeIntent,
    pub intent_confidence: f64,
    pub entangled_probability: f64,
    pub rationale: String,
    pub source: NarrationSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphFeedback {
    pub summary: String,
    pub suggestions: Vec<String>,
    pub source: NarrationSource,
}

const NAMING_PROMPT: &str = "You name Jujutsu (jj) changes. Return strict JSON with keys: conventionalTitle (<=72 chars), bookmarkSlug (kebab-case with prefix/), rationale (1 sentence).";
const SUMMARY_PROMPT: &str = "Summarize these Jujutsu revision-graph diagnostics in 2 direct, calm sentences for a developer. No hype.";

static FIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)\bfix\b").unwrap());

/// The conventional-commit prefix of an intent.
fn intent_prefix(intent: &str) -> &'static str {
    match intent {
        "structural" => "refactor",
        "test-harness" => "test",
        "blueprint" => "plan",
        "megamerge" => "local",
        "working-copy" => "wip",
        // behavioral, activation, and anything unknown
        _ => "feat",
    }
}

/// Jev's intent answer as an intent; an answer outside the criteria names
/// the way a behavioral change would be named.
fn intent_of(choice: &str) -> ChangeIntent {
    ChangeIntent::parse(choice).unwrap_or(ChangeIntent::Behavioral)
}

/// JS truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A JSON value as text: strings as they are, anything else as JSON.
fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The primary name of a change: the first touched file's stem, slugged.
fn primary_name(touched_paths: &[String]) -> String {
    let path = touched_paths.first().map_or("core", String::as_str);
    let base = path.rsplit('/').next().unwrap_or_default();
    // `.replace(/\.[^.]+$/, '')`
    let stem = match base.rfind('.') {
        Some(i) if i + 1 < base.len() => &base[..i],
        _ => base,
    };
    // `.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()`
    let mut out = String::with_capacity(stem.len());
    let mut in_run = false;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch.to_ascii_lowercase());
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    if out.is_empty() {
        "change".to_owned()
    } else {
        out
    }
}

/// The narrator. Without a configured transport, every answer is deterministic.
#[derive(Clone)]
pub struct JjrNarrator {
    transport: Option<Arc<dyn LlmTransport>>,
    jev: JjrJevAssistant,
}

impl std::fmt::Debug for JjrNarrator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JjrNarrator")
            .field(
                "llm",
                &self.transport.as_ref().is_some_and(|t| t.is_configured()),
            )
            .finish()
    }
}

impl JjrNarrator {
    pub fn new(transport: Option<Arc<dyn LlmTransport>>, jev: JjrJevAssistant) -> Self {
        Self { transport, jev }
    }

    /// A narrator using an OpenAI-compatible endpoint from the environment
    /// when one is configured.
    pub fn from_env(jev: JjrJevAssistant) -> Self {
        let transport = OpenAiCompatibleTransport::from_env();
        let transport: Option<Arc<dyn LlmTransport>> = if transport.is_configured() {
            Some(Arc::new(transport))
        } else {
            None
        };
        Self::new(transport, jev)
    }

    pub fn jev(&self) -> &JjrJevAssistant {
        &self.jev
    }

    /// The transport to ask, when one is configured.
    fn llm(&self) -> Option<&dyn LlmTransport> {
        self.transport.as_deref().filter(|t| t.is_configured())
    }

    /// Suggest a conventional change description and bookmark slug: Jev
    /// classifies intent and entanglement (System One), then the LLM or the
    /// deterministic fallback writes the title and slug (System Two).
    pub fn suggest_change_name(&self, input: &NamingInput) -> NamingSuggestion {
        let touched_paths = &input.touched_paths;
        let diff_excerpt = input.diff_excerpt.as_str();
        let triage = self.jev.triage_change(&ChangeTriageInput {
            change_id: input
                .change_id
                .clone()
                .unwrap_or_else(|| "kkkkkkkk".to_owned()),
            description: input.description.clone(),
            touched_paths: touched_paths.clone(),
            diff_excerpt: diff_excerpt.to_owned(),
            ..ChangeTriageInput::default()
        });

        let detected = triage.answers.intent.choice.as_str();
        let intent_confidence = triage.answers.intent.confidence;
        let entangled = triage.answers.entangled.noul;

        if let Some(llm) = self.llm()
            && let Ok(raw) = llm.complete(
                NAMING_PROMPT,
                &format!(
                    "Jev intent: {detected} (confidence {intent_confidence:.2}), entangled={entangled:.2}\nTouched paths:\n{}\n\nDiff excerpt:\n{}",
                    touched_paths.join("\n"),
                    js_prefix(diff_excerpt, 1800)
                ),
            )
            && let Some(named) = parse_naming(&raw)
        {
            return NamingSuggestion {
                conventional_title: named.title,
                bookmark_slug: named.slug,
                detected_intent: intent_of(detected),
                intent_confidence,
                entangled_probability: entangled,
                rationale: named.rationale.unwrap_or_else(|| format!("Classified as {detected} by Jev.")),
                source: NarrationSource::Llm,
            };
        }

        deterministic_name(
            touched_paths,
            diff_excerpt,
            detected,
            intent_confidence,
            entangled,
        )
    }

    /// Summarize graph diagnostics into plain, actionable feedback.
    pub fn explain_graph_feedback(&self, graph: &JjrGraph) -> GraphFeedback {
        let diagnostics = graph.diagnose();
        if diagnostics.is_empty() {
            return GraphFeedback {
                summary: "Your revision graph is clean: every mutable change is non-divergent and properly ordered.".to_owned(),
                suggestions: Vec::new(),
                source: NarrationSource::Deterministic,
            };
        }

        let suggestions: Vec<String> = diagnostics
            .iter()
            .map(|d| match d.suggested_command.as_deref() {
                Some(command) if !command.is_empty() => {
                    format!("{} -> Try: `{command}`", d.message)
                }
                _ => d.message.clone(),
            })
            .collect();

        if let Some(llm) = self.llm()
            && let Ok(summary) = llm.complete(SUMMARY_PROMPT, &suggestions.join("\n"))
            && !summary.trim().is_empty()
        {
            return GraphFeedback {
                summary: summary.trim().to_owned(),
                suggestions,
                source: NarrationSource::Llm,
            };
        }

        let errors = diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .count();
        let warnings = diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Warning)
            .count();
        let summary = if errors > 0 {
            format!(
                "Found {errors} blocking graph issue(s) and {warnings} warning(s) in mutable(). Resolve errors before stacking or pushing."
            )
        } else {
            format!(
                "Found {} hygiene suggestion(s) in mutable() that can tidy your stack before review.",
                diagnostics.len()
            )
        };
        GraphFeedback {
            summary,
            suggestions,
            source: NarrationSource::Deterministic,
        }
    }

    /// Turn a Two-Part Dependency Test verdict into a concise explanation.
    pub fn critique_dependency(
        &self,
        base: &JjrChange,
        child: &JjrChange,
        assessment: &DependencyAssessment,
    ) -> String {
        let verdict = JjrGraph::evaluate_dependency(assessment);
        let base_short = short(&base.change_id);
        let child_short = short(&child.change_id);
        match verdict.outcome {
            DependencyOutcome::Stack => format!(
                "Keep {child_short} stacked on {base_short}: {}",
                verdict.reason
            ),
            DependencyOutcome::Confirm => {
                format!(
                    "Confirm relationship between {base_short} and {child_short}: {}",
                    verdict.reason
                )
            }
            DependencyOutcome::Parallelize | DependencyOutcome::Collapse => {
                format!(
                    "{} Suggested: `{}`.",
                    verdict.reason,
                    verdict.suggested_command.as_deref().unwrap_or("null")
                )
            }
        }
    }
}

/// What the LLM named a change.
struct LlmNaming {
    title: String,
    slug: String,
    rationale: Option<String>,
}

/// The JSON object in an LLM reply, when it names both a title and a slug.
fn parse_naming(raw: &str) -> Option<LlmNaming> {
    // `raw.match(/\{[\s\S]*\}/)`: from the first `{` to the last `}`.
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(start), Some(end)) if end > start => &raw[start..=end],
        _ => raw,
    };
    let parsed: Value = serde_json::from_str(json).ok()?;
    let title = parsed.get("conventionalTitle").filter(|v| truthy(v))?;
    let slug = parsed.get("bookmarkSlug").filter(|v| truthy(v))?;
    let rationale = parsed
        .get("rationale")
        .filter(|v| !v.is_null())
        .map(text_of);
    Some(LlmNaming {
        title: text_of(title),
        slug: text_of(slug),
        rationale,
    })
}

fn deterministic_name(
    touched_paths: &[String],
    diff_excerpt: &str,
    detected: &str,
    intent_confidence: f64,
    entangled: f64,
) -> NamingSuggestion {
    let prefix = intent_prefix(detected);
    let primary = primary_name(touched_paths);
    let verb = match detected {
        "structural" => "refactor",
        "test-harness" => "add tests for",
        "activation" => "enable",
        _ if FIX_RE.is_match(diff_excerpt) => "fix",
        _ => "update",
    };
    let (conventional_title, bookmark_slug) = if detected == "megamerge" {
        (format!("local: dev megamerge ({primary})"), String::new())
    } else {
        (
            format!("{prefix}({primary}): {verb} {primary}"),
            format!("{prefix}/{primary}"),
        )
    };
    let split_note = if entangled >= 0.72 {
        " Jev also flagged structural/behavioral entanglement — consider splitting first."
    } else {
        ""
    };
    NamingSuggestion {
        conventional_title,
        bookmark_slug,
        detected_intent: intent_of(detected),
        intent_confidence,
        entangled_probability: entangled,
        rationale: format!(
            "Jev classified this change as \"{detected}\" (confidence {intent_confidence:.2}) across {} file(s).{split_note}",
            touched_paths.len()
        ),
        source: NarrationSource::Deterministic,
    }
}
