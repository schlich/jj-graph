//! Portable GUI adapter: turns the view models into semantic state tokens
//! (never branch-lane colors) that any GUI toolkit can bind directly.
//!
//! Port of `jjr/ui/gui.mjs`.

use serde::Serialize;

use super::core::BannerStatus;
use super::core::DagGraphViewModel;
use super::core::DependencyGate;
use super::core::GuardrailBanner;
use super::core::PreflightIssue;
use super::core::PreflightPanel;
use super::core::PublishPlanView;
use super::core::TimeTravelScrubber;
use super::core::TriageCard;
use crate::graph::DependencyOutcome;
use crate::graph::Severity;
use crate::patterns::BlastRadius;
use crate::patterns::TimeAxis;
use crate::types::ChangeIntent;
use crate::types::Zone;

/// A semantic tone: what a state means, not a color.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Muted,
    Dry,
    Danger,
    Past,
    Accent,
    Neutral,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Badge {
    pub label: String,
    pub tone: Tone,
}

/// One row of a GUI revision list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiDagRow {
    pub key: String,
    pub glyph: String,
    pub change_id: String,
    pub commit_id: String,
    pub title: String,
    pub intent: ChangeIntent,
    pub zone: Zone,
    pub indent_level: usize,
    pub badges: Vec<Badge>,
    pub selected: bool,
}

pub fn to_gui_dag_rows(vm: &DagGraphViewModel) -> Vec<GuiDagRow> {
    vm.nodes
        .iter()
        .map(|node| {
            let mut badges = Vec::new();
            let mut badge = |label: &str, tone| {
                badges.push(Badge {
                    label: label.to_owned(),
                    tone,
                })
            };
            if node.zone == Zone::Immutable {
                badge("immutable()", Tone::Muted);
            }
            if node.is_megamerge {
                badge("local megamerge", Tone::Dry);
            }
            if node.is_divergent {
                badge("divergent()", Tone::Danger);
            }
            if node.is_conflicted {
                badge("conflict", Tone::Danger);
            }
            if node.is_empty && node.intent == ChangeIntent::Blueprint {
                badge("blueprint", Tone::Past);
            }
            if node.is_verified_green && node.zone == Zone::Mutable {
                badge("green", Tone::Accent);
            }
            for bm in &node.bookmarks {
                badge(bm, Tone::Neutral);
            }
            GuiDagRow {
                key: node.change_id.clone(),
                glyph: node.glyph.clone(),
                change_id: node.short_change_id.clone(),
                commit_id: node.short_commit_id.clone(),
                title: node.title.clone(),
                intent: node.intent,
                zone: node.zone,
                indent_level: node.depth,
                badges,
                selected: vm.selected_change_id.as_deref() == Some(node.change_id.as_str()),
            }
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiAlertItem {
    pub rule: String,
    pub message: String,
    pub remediation_command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GuiAlertProps {
    pub tone: Tone,
    pub title: String,
    pub items: Vec<GuiAlertItem>,
}

pub fn to_gui_alert_props(vm: &GuardrailBanner) -> GuiAlertProps {
    GuiAlertProps {
        tone: match vm.status {
            BannerStatus::Blocked => Tone::Danger,
            BannerStatus::Warning => Tone::Dry,
            BannerStatus::Clear => Tone::Accent,
        },
        title: vm.headline.clone(),
        items: vm
            .items
            .iter()
            .map(|i| GuiAlertItem {
                rule: i.rule_name.clone(),
                message: i.message.clone(),
                remediation_command: i.remediation.clone(),
            })
            .collect(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiDependencyCard {
    pub base: String,
    pub child: String,
    pub outcome: DependencyOutcome,
    pub tone: Tone,
    pub causal_probability: Option<f64>,
    pub reviewability_probability: Option<f64>,
    pub reason: String,
    pub suggested_command: Option<String>,
    pub suggested_args: Option<Vec<String>>,
}

pub fn to_gui_dependency_card(vm: &DependencyGate) -> GuiDependencyCard {
    GuiDependencyCard {
        base: vm.base_label.clone(),
        child: vm.child_label.clone(),
        outcome: vm.verdict.outcome,
        tone: match vm.verdict.outcome {
            DependencyOutcome::Stack => Tone::Accent,
            DependencyOutcome::Confirm => Tone::Past,
            _ => Tone::Dry,
        },
        causal_probability: vm.causal_probability,
        reviewability_probability: vm.reviewability_probability,
        reason: vm.verdict.reason.clone(),
        suggested_command: vm.verdict.suggested_command.clone(),
        suggested_args: vm.verdict.suggested_args.clone(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LabelConfidence {
    pub label: String,
    pub confidence: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToneProbability {
    pub probability: f64,
    pub tone: Tone,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Readiness {
    pub label: String,
    pub score: f64,
    pub confidence: f64,
    pub tone: Tone,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiTriageProps {
    pub change_id: String,
    pub source: String,
    pub intent: LabelConfidence,
    pub entangled: ToneProbability,
    pub readiness: Readiness,
    pub debug_risk: ToneProbability,
    pub api_without_consumer: Option<ToneProbability>,
}

pub fn to_gui_triage_props(vm: &TriageCard) -> GuiTriageProps {
    GuiTriageProps {
        change_id: vm.short_change_id.clone(),
        source: vm.source.as_str().to_owned(),
        intent: LabelConfidence {
            label: vm.intent.clone(),
            confidence: vm.intent_confidence,
        },
        entangled: ToneProbability {
            probability: vm.entangled_probability,
            tone: if vm.entangled_probability >= 0.72 {
                Tone::Dry
            } else {
                Tone::Accent
            },
        },
        readiness: Readiness {
            label: vm.publish_readiness.clone(),
            score: vm.publish_score,
            confidence: vm.publish_confidence,
            tone: if vm.publish_score >= 2.0 {
                Tone::Accent
            } else if vm.publish_score >= 1.0 {
                Tone::Dry
            } else {
                Tone::Danger
            },
        },
        debug_risk: ToneProbability {
            probability: vm.has_debug_or_secrets_probability,
            tone: if vm.has_debug_or_secrets_probability >= 0.65 {
                Tone::Danger
            } else {
                Tone::Muted
            },
        },
        api_without_consumer: vm
            .api_without_consumer_probability
            .map(|p| ToneProbability {
                probability: p,
                tone: if p >= 0.72 { Tone::Dry } else { Tone::Muted },
            }),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GuiPreflightIssue {
    #[serde(flatten)]
    pub issue: PreflightIssue,
    pub tone: Tone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiPreflightProps {
    pub tone: Tone,
    pub trunk: String,
    pub trunk_protected: bool,
    pub immutable_heads: Vec<String>,
    pub colocated: Option<bool>,
    pub issues: Vec<GuiPreflightIssue>,
}

pub fn to_gui_preflight_props(vm: &PreflightPanel) -> GuiPreflightProps {
    GuiPreflightProps {
        tone: match vm.status.as_str() {
            "blocked" => Tone::Danger,
            "attention" => Tone::Dry,
            _ => Tone::Accent,
        },
        trunk: vm
            .trunk
            .as_ref()
            .map_or_else(|| "unresolved".to_owned(), |t| t.label.clone()),
        trunk_protected: vm.trunk.as_ref().is_some_and(|t| t.immutable || t.is_root),
        immutable_heads: vm.immutable_heads.clone(),
        colocated: vm.colocated,
        issues: vm
            .issues
            .iter()
            .map(|i| GuiPreflightIssue {
                issue: i.clone(),
                tone: match i.severity {
                    Severity::Error => Tone::Danger,
                    Severity::Warning => Tone::Dry,
                    Severity::Info => Tone::Muted,
                },
            })
            .collect(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GuiPublishRow {
    pub key: String,
    pub label: String,
    pub tone: Tone,
    pub detail: Option<String>,
}

pub fn to_gui_publish_plan_rows(vm: &PublishPlanView) -> Vec<GuiPublishRow> {
    vm.rows
        .iter()
        .map(|r| GuiPublishRow {
            key: r.change_id.clone(),
            label: format!("{} {}", r.change_id, r.title),
            tone: if r.publishable {
                Tone::Accent
            } else {
                Tone::Danger
            },
            detail: if r.publishable {
                r.command.clone()
            } else {
                Some(
                    r.reasons
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "blocked".to_owned()),
                )
            },
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuiTimeTravelProps {
    pub axis: TimeAxis,
    pub blast_radius: BlastRadius,
    pub tone: Tone,
    pub preview_command: String,
    pub explanation: String,
}

pub fn to_gui_time_travel_props(vm: &TimeTravelScrubber) -> GuiTimeTravelProps {
    GuiTimeTravelProps {
        axis: vm.axis,
        blast_radius: vm.blast_radius,
        tone: if vm.axis == TimeAxis::Evolog {
            Tone::Accent
        } else {
            Tone::Past
        },
        preview_command: vm.preview_command.clone(),
        explanation: vm.explanation.clone(),
    }
}
