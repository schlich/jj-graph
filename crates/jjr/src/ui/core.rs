//! Render-agnostic view models.
//!
//! Every component computes pure, deterministic state from a `JjrGraph`, a
//! guardrail result, a Jev triage, or a narrator suggestion, so TUI and GUI
//! adapters share them without duplicating version-control logic.
//!
//! Port of `jjr/ui/core.mjs`.

use std::collections::HashMap;
use std::collections::HashSet;

use serde::Serialize;

use crate::graph::DependencyVerdict;
use crate::graph::GraphDiagnostic;
use crate::graph::GraphSummary;
use crate::graph::JjrGraph;
use crate::graph::PreflightFacts;
use crate::graph::Severity;
use crate::guardrails::DecisionSeverity;
use crate::guardrails::GuardrailDecision;
use crate::jev::ChangeTriageResult;
use crate::jev::JevSource;
use crate::narrator::NamingSuggestion;
use crate::patterns::BlastRadius;
use crate::patterns::TimeAxis;
use crate::patterns::TimeTravelPlan;
use crate::runner::LayeredPublishPlan;
use crate::types::ChangeIntent;
use crate::types::ForgeKind;
use crate::types::MergeSameChange;
use crate::types::VerificationState;
use crate::types::Zone;
use crate::types::short;
use crate::types::verification_state;

/// One revision as the DAG view draws it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DagNodeViewModel {
    pub change_id: String,
    pub short_change_id: String,
    pub short_commit_id: String,
    pub title: String,
    pub zone: Zone,
    pub glyph: String,
    pub intent: ChangeIntent,
    pub bookmarks: Vec<String>,
    pub is_conflicted: bool,
    pub is_divergent: bool,
    pub is_megamerge: bool,
    pub is_empty: bool,
    pub verification: VerificationState,
    pub is_verified_green: bool,
    pub depth: usize,
    pub parent_ids: Vec<String>,
}

/// The DAG view: revisions deepest first, with diagnostics and the summary.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DagGraphViewModel {
    pub nodes: Vec<DagNodeViewModel>,
    pub diagnostics: Vec<GraphDiagnostic>,
    pub summary: GraphSummary,
    pub selected_change_id: Option<String>,
}

pub fn build_dag_graph_view_model(
    graph: &JjrGraph,
    selected_change_id: Option<&str>,
) -> DagGraphViewModel {
    fn depth_of(
        graph: &JjrGraph,
        id: &str,
        depths: &mut HashMap<String, usize>,
        visiting: &mut HashSet<String>,
    ) -> usize {
        if let Some(d) = depths.get(id) {
            return *d;
        }
        if !visiting.insert(id.to_owned()) {
            return 0;
        }
        let node = graph.get(id);
        let d = match node {
            Some(n) if n.zone != Zone::Immutable && !n.parents.is_empty() => {
                let parents = n.parents.clone();
                parents
                    .iter()
                    .map(|p| depth_of(graph, p, depths, visiting))
                    .max()
                    .unwrap_or(0)
                    + 1
            }
            _ => 0,
        };
        depths.insert(id.to_owned(), d);
        d
    }

    let all = graph.all();
    let mut depths: HashMap<String, usize> = HashMap::new();
    for c in &all {
        depth_of(graph, &c.change_id, &mut depths, &mut HashSet::new());
    }
    let mut ordered = all.clone();
    // A stable sort, deepest first, like the JS.
    ordered.sort_by_key(|c| std::cmp::Reverse(depths.get(&c.change_id).copied().unwrap_or(0)));
    let nodes = ordered
        .into_iter()
        .map(|c| {
            let glyph = if c.is_working_copy {
                "@"
            } else if c.is_conflicted() {
                "×"
            } else if c.zone == Zone::Immutable {
                "◆"
            } else if c.intent == ChangeIntent::Blueprint {
                "◇"
            } else {
                "○"
            };
            let verification = verification_state(Some(&c.verification));
            DagNodeViewModel {
                change_id: c.change_id.clone(),
                short_change_id: short(&c.change_id).to_owned(),
                short_commit_id: short(&c.current_commit.commit_id).to_owned(),
                title: c.title().to_owned(),
                zone: c.zone,
                glyph: glyph.to_owned(),
                intent: c.intent,
                bookmarks: c.bookmarks.clone(),
                is_conflicted: c.is_conflicted(),
                is_divergent: c.is_divergent,
                is_megamerge: graph.is_megamerge(c),
                is_empty: c.current_commit.is_empty,
                verification,
                is_verified_green: verification == VerificationState::Green,
                depth: depths.get(&c.change_id).copied().unwrap_or(0),
                parent_ids: c.parents.clone(),
            }
        })
        .collect();
    DagGraphViewModel {
        nodes,
        diagnostics: graph.diagnose(),
        summary: graph.summary(),
        selected_change_id: selected_change_id.map(ToOwned::to_owned),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BannerStatus {
    Blocked,
    Warning,
    Clear,
}

/// The guardrails' verdict as a banner: what blocks, else what warns.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GuardrailBanner {
    pub status: BannerStatus,
    pub headline: String,
    pub items: Vec<GuardrailDecision>,
}

pub fn build_guardrail_banner(decisions: &[GuardrailDecision]) -> GuardrailBanner {
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
    if !blockers.is_empty() {
        return GuardrailBanner {
            status: BannerStatus::Blocked,
            headline: format!("Blocked by {} guardrail(s)", blockers.len()),
            items: blockers,
        };
    }
    if !warnings.is_empty() {
        return GuardrailBanner {
            status: BannerStatus::Warning,
            headline: format!("{} guardrail warning(s)", warnings.len()),
            items: warnings,
        };
    }
    GuardrailBanner {
        status: BannerStatus::Clear,
        headline: "All guardrails passed".into(),
        items: Vec::new(),
    }
}

/// The Two-Part Dependency Gate for a pair of changes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGate {
    pub base_label: String,
    pub child_label: String,
    pub verdict: DependencyVerdict,
    pub source: String,
    pub causal_probability: Option<f64>,
    pub reviewability_probability: Option<f64>,
}

/// `source` defaults to `deterministic`.
pub fn build_dependency_gate(
    base_label: &str,
    child_label: &str,
    verdict: &DependencyVerdict,
    source: Option<&str>,
) -> DependencyGate {
    DependencyGate {
        base_label: base_label.to_owned(),
        child_label: child_label.to_owned(),
        verdict: verdict.clone(),
        source: source.unwrap_or("deterministic").to_owned(),
        causal_probability: verdict.causal_probability,
        reviewability_probability: verdict.reviewability_probability,
    }
}

/// One change's Jev triage, flattened for display.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageCard {
    pub change_id: String,
    pub short_change_id: String,
    pub source: JevSource,
    pub model: String,
    pub intent: String,
    pub intent_confidence: f64,
    pub entangled_probability: f64,
    pub publish_readiness: String,
    pub publish_score: f64,
    pub publish_confidence: f64,
    pub has_debug_or_secrets_probability: f64,
    pub api_without_consumer_probability: Option<f64>,
}

pub fn build_triage_card(change_id: &str, triage: &ChangeTriageResult) -> TriageCard {
    let a = &triage.answers;
    TriageCard {
        change_id: change_id.to_owned(),
        short_change_id: short(change_id).to_owned(),
        source: triage.source,
        model: triage.model.clone(),
        intent: a.intent.choice.clone(),
        intent_confidence: a.intent.confidence,
        entangled_probability: a.entangled.noul,
        publish_readiness: a.publish_readiness.legend.clone(),
        publish_score: a.publish_readiness.score,
        publish_confidence: a.publish_readiness.confidence,
        has_debug_or_secrets_probability: a.has_debug_or_secrets.noul,
        api_without_consumer_probability: a.api_without_consumer.map(|n| n.noul),
    }
}

/// Where `trunk()` resolves, for the pre-flight panel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrunkLabel {
    pub label: String,
    pub is_root: bool,
    pub immutable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreflightIssue {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub command: Option<String>,
}

/// Pre-flight panel: where `trunk()` and the immutable boundary resolve, and
/// which repository conditions need attention.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightPanel {
    /// `unknown`, `blocked`, `attention` or `clean`.
    pub status: String,
    pub trunk: Option<TrunkLabel>,
    pub immutable_heads: Vec<String>,
    pub colocated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_same_change: Option<MergeSameChange>,
    pub issues: Vec<PreflightIssue>,
}

pub fn build_preflight_panel(
    preflight: Option<&PreflightFacts>,
    diagnostics: &[GraphDiagnostic],
) -> PreflightPanel {
    let Some(p) = preflight else {
        return PreflightPanel {
            status: "unknown".into(),
            trunk: None,
            immutable_heads: Vec::new(),
            colocated: None,
            merge_same_change: None,
            issues: Vec::new(),
        };
    };
    let trunk = p.trunk.resolved.then(|| TrunkLabel {
        label: if p.trunk.is_root() {
            "root()".to_owned()
        } else {
            short(p.trunk.change_id()).to_owned()
        },
        is_root: p.trunk.is_root(),
        immutable: p.trunk.immutable == Some(true),
    });
    let issues: Vec<&GraphDiagnostic> = diagnostics
        .iter()
        .filter(|d| {
            let code = d.code.as_str();
            code.starts_with("PREFLIGHT_")
                || code.starts_with("GIT_COMPAT")
                || code.starts_with("GC_RECOMMENDED")
        })
        .collect();
    let status = if issues.iter().any(|d| d.severity == Severity::Error) {
        "blocked"
    } else if issues.iter().any(|d| d.severity == Severity::Warning) {
        "attention"
    } else {
        "clean"
    };
    PreflightPanel {
        status: status.into(),
        trunk,
        immutable_heads: p
            .immutable_heads
            .heads
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|h| short(&h.change_id).to_owned())
            .collect(),
        colocated: p.colocated,
        merge_same_change: p.merge_same_change,
        issues: issues
            .into_iter()
            .map(|d| PreflightIssue {
                severity: d.severity,
                code: d.code.as_str().to_owned(),
                message: d.message.clone(),
                command: d.suggested_command.clone(),
            })
            .collect(),
    }
}

/// One layer of a layered publish plan, for display.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRow {
    pub change_id: String,
    pub title: String,
    pub publishable: bool,
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub command: Option<String>,
}

/// Layered publish plan: which layers of a stack can be published now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPlanView {
    pub forge: ForgeKind,
    pub forge_name: String,
    pub caveats: Vec<String>,
    pub rows: Vec<PublishRow>,
    pub commands: Vec<String>,
    pub publish_count: usize,
    pub keep_local_count: usize,
}

pub fn build_publish_plan(plan: &LayeredPublishPlan) -> PublishPlanView {
    PublishPlanView {
        forge: plan.forge,
        forge_name: if plan.adapter.name.is_empty() {
            plan.forge.as_str().to_owned()
        } else {
            plan.adapter.name.clone()
        },
        caveats: plan.adapter.caveats.clone(),
        rows: plan
            .layers
            .iter()
            .map(|l| PublishRow {
                change_id: short(&l.change_id).to_owned(),
                title: l.title.clone(),
                publishable: l.publishable,
                reasons: l.reasons.clone(),
                warnings: l.warnings.clone(),
                command: l.command.clone(),
            })
            .collect(),
        commands: plan.commands.clone(),
        publish_count: plan.publish.len(),
        keep_local_count: plan.keep_local.len(),
    }
}

/// A scrubber over the evolution log or the operation log, with the
/// recovery command for the active entry.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeTravelScrubber {
    pub axis: TimeAxis,
    pub entries: Vec<serde_json::Value>,
    pub active_index: usize,
    pub preview_command: String,
    pub explanation: String,
    pub blast_radius: BlastRadius,
}

pub fn build_time_travel_scrubber(
    axis: TimeAxis,
    entries: &[serde_json::Value],
    active_index: usize,
    plan: &TimeTravelPlan,
) -> TimeTravelScrubber {
    TimeTravelScrubber {
        axis,
        entries: entries.to_vec(),
        active_index,
        preview_command: plan.command.clone(),
        explanation: plan.explanation.clone(),
        blast_radius: plan.blast_radius,
    }
}

/// A naming suggestion and whether it was accepted.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NamingAssistant {
    pub suggestion: NamingSuggestion,
    pub accepted: bool,
}

pub fn build_naming_assistant(suggestion: &NamingSuggestion, accepted: bool) -> NamingAssistant {
    NamingAssistant {
        suggestion: suggestion.clone(),
        accepted,
    }
}
