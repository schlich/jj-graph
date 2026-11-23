//! Portable TUI adapter: renders the view models as terminal text, with
//! optional ANSI color, and exposes a standard keybinding map.
//!
//! Port of `jjr/ui/tui.mjs`.

use super::core::BannerStatus;
use super::core::DagGraphViewModel;
use super::core::DependencyGate;
use super::core::GuardrailBanner;
use super::core::NamingAssistant;
use super::core::PreflightPanel;
use super::core::PublishPlanView;
use super::core::TimeTravelScrubber;
use super::core::TriageCard;
use crate::graph::DependencyOutcome;
use crate::graph::Severity;
use crate::patterns::BlastRadius;
use crate::patterns::TimeAxis;
use crate::types::Zone;

/// The standard keys a TUI binds, by action.
pub const TUI_KEYBINDINGS: &[(&str, &str)] = &[
    ("navigateUp", "k / ↑"),
    ("navigateDown", "j / ↓"),
    ("toggleTimeAxis", "t"),
    ("runDependencyGate", "d"),
    ("runJevTriage", "v"),
    ("suggestName", "n"),
    ("squashDown", "s"),
    ("parallelize", "p"),
    ("applyDryRun", "a"),
    ("undoOp", "u"),
];

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const BLUE: &str = "\x1b[34m";
const MAGENTA: &str = "\x1b[35m";
const CYAN: &str = "\x1b[36m";

fn paint(use_color: bool, code: &str, text: &str) -> String {
    if use_color {
        format!("{code}{text}{RESET}")
    } else {
        text.to_owned()
    }
}

pub fn render_dag_tui(vm: &DagGraphViewModel, use_color: bool) -> String {
    let c = |code: &str, text: &str| paint(use_color, code, text);
    let mut lines = vec![c(
        BOLD,
        "┌─ JJR REVISION GRAPH ────────────────────────────────────────┐",
    )];
    for node in &vm.nodes {
        let indent = "  ".repeat(node.depth.min(4));
        let glyph_color = match node.glyph.as_str() {
            "@" => GREEN,
            "×" => RED,
            _ if node.zone == Zone::Immutable => DIM,
            _ => CYAN,
        };
        let zone_tag = if node.zone == Zone::Immutable {
            c(DIM, " [immutable]")
        } else {
            String::new()
        };
        let bm_tag = if node.bookmarks.is_empty() {
            String::new()
        } else {
            c(BLUE, &format!(" ({})", node.bookmarks.join(", ")))
        };
        let status_tag = if node.is_divergent {
            c(RED, " [divergent]")
        } else if node.is_megamerge {
            c(YELLOW, " [local:megamerge]")
        } else if node.is_conflicted {
            c(RED, " [conflict]")
        } else if node.is_verified_green && node.zone == Zone::Mutable {
            c(GREEN, " ✓")
        } else {
            String::new()
        };
        let pointer = if vm.selected_change_id.as_deref() == Some(node.change_id.as_str()) {
            c(YELLOW, "▸ ")
        } else {
            "  ".to_owned()
        };
        lines.push(format!(
            "{pointer}{indent}{} {} {} {}{bm_tag}{status_tag}{zone_tag}",
            c(glyph_color, &node.glyph),
            c(MAGENTA, &node.short_change_id),
            c(DIM, &node.short_commit_id),
            node.title
        ));
    }
    lines.push(c(
        BOLD,
        "└──────────────────────────────────────────────────────────────┘",
    ));
    lines.join("\n")
}

pub fn render_guardrail_banner_tui(vm: &GuardrailBanner, use_color: bool) -> String {
    let c = |code: &str, text: &str| paint(use_color, code, text);
    if vm.status == BannerStatus::Clear {
        return c(GREEN, &format!("✓ [GUARDRAILS] {}", vm.headline));
    }
    let icon = if vm.status == BannerStatus::Blocked {
        c(RED, "✖")
    } else {
        c(YELLOW, "▲")
    };
    let body: Vec<String> = vm
        .items
        .iter()
        .map(|item| {
            let fix = item
                .remediation
                .as_ref()
                .map(|r| format!("\n    Fix: {r}"))
                .unwrap_or_default();
            format!("  • [{}] {}{fix}", item.rule_name, item.message)
        })
        .collect();
    format!("{icon} [GUARDRAILS] {}\n{}", vm.headline, body.join("\n"))
}

pub fn render_dependency_gate_tui(vm: &DependencyGate) -> String {
    let mut lines = vec![
        "┌─ TWO-PART DEPENDENCY GATE ─────────────────────────┐".to_owned(),
        format!("│ Base:    {}", vm.base_label),
        format!("│ Child:   {}", vm.child_label),
        format!("│ Verdict: {}", vm.verdict.outcome.as_str().to_uppercase()),
    ];
    if let (Some(causal), Some(reviewable)) = (vm.causal_probability, vm.reviewability_probability)
    {
        lines.push(format!(
            "│ Jev p:   causal={causal:.2}, reviewable={reviewable:.2} ({})",
            vm.source
        ));
    }
    lines.push(format!("│ Reason:  {}", vm.verdict.reason));
    lines.push(match &vm.verdict.suggested_command {
        Some(command) => format!("│ Command: {command}"),
        None => format!(
            "│ Status:  {}",
            if vm.verdict.outcome == DependencyOutcome::Confirm {
                "Awaiting confirmation"
            } else {
                "Valid causal stack"
            }
        ),
    });
    lines.push("└────────────────────────────────────────────────────┘".to_owned());
    lines.join("\n")
}

pub fn render_triage_tui(vm: &TriageCard) -> String {
    let mut lines = vec![
        format!(
            "┌─ JEV CHANGE TRIAGE ({}) ───────────────────┐",
            vm.short_change_id
        ),
        format!("│ Source:     {} ({})", vm.source.as_str(), vm.model),
        format!(
            "│ Intent:     {} (confidence {:.2})",
            vm.intent, vm.intent_confidence
        ),
        format!(
            "│ Entangled:  p={:.2}{}",
            vm.entangled_probability,
            if vm.entangled_probability >= 0.72 {
                " [split recommended]"
            } else {
                ""
            }
        ),
        format!(
            "│ Readiness:  {} (score {:.2}, conf {:.2})",
            vm.publish_readiness, vm.publish_score, vm.publish_confidence
        ),
        format!("│ Debug/Keys: p={:.2}", vm.has_debug_or_secrets_probability),
    ];
    if let Some(p) = vm.api_without_consumer_probability {
        lines.push(format!(
            "│ API/Caller: p={p:.2}{}",
            if p >= 0.72 {
                " [pair with a consumer]"
            } else {
                ""
            }
        ));
    }
    lines.push("└────────────────────────────────────────────────────┘".to_owned());
    lines.join("\n")
}

pub fn render_preflight_tui(vm: &PreflightPanel) -> String {
    let trunk = match &vm.trunk {
        Some(t) => format!(
            "{}{}",
            t.label,
            if t.immutable || t.is_root {
                ""
            } else {
                " (NOT immutable)"
            }
        ),
        None => "unresolved".to_owned(),
    };
    let heads = if vm.immutable_heads.is_empty() {
        "(none)".to_owned()
    } else {
        vm.immutable_heads.join(", ")
    };
    let colocated = match vm.colocated {
        None => "unknown",
        Some(true) => "yes",
        Some(false) => "no",
    };
    let mut lines = vec![
        format!(
            "┌─ PRE-FLIGHT ({}) ─────────────────────────────┐",
            vm.status
        ),
        format!("│ trunk():           {trunk}"),
        format!("│ immutable_heads(): {heads}"),
        format!("│ colocated:         {colocated}"),
    ];
    for i in &vm.issues {
        let icon = match i.severity {
            Severity::Error => '✖',
            Severity::Warning => '▲',
            Severity::Info => '·',
        };
        lines.push(format!("│ {icon} {}: {}", i.code, i.message));
    }
    lines.push("└────────────────────────────────────────────────────┘".to_owned());
    lines.join("\n")
}

pub fn render_publish_plan_tui(vm: &PublishPlanView) -> String {
    let mut lines = vec![format!(
        "┌─ LAYERED PUBLISH PLAN ({}) ─────────────┐",
        vm.forge_name
    )];
    for r in &vm.rows {
        let blocked = if r.publishable {
            String::new()
        } else {
            format!(
                "\n│     {}",
                r.reasons.first().map_or("blocked", String::as_str)
            )
        };
        lines.push(format!(
            "│ {} {} {}{blocked}",
            if r.publishable { '✓' } else { '✖' },
            r.change_id,
            r.title
        ));
    }
    lines.push(format!(
        "│ Publish now: {} · keep local: {}",
        vm.publish_count, vm.keep_local_count
    ));
    for c in &vm.commands {
        lines.push(format!("│ $ {c}"));
    }
    lines.push("└────────────────────────────────────────────────────┘".to_owned());
    lines.join("\n")
}

pub fn render_naming_assistant_tui(vm: &NamingAssistant) -> String {
    let s = &vm.suggestion;
    [
        format!(
            "✦ Naming Suggestion ({}, conf {:.2})",
            s.detected_intent, s.intent_confidence
        ),
        format!("  Title:    {}", s.conventional_title),
        format!(
            "  Bookmark: {}",
            if s.bookmark_slug.is_empty() {
                "(none — local only)"
            } else {
                &s.bookmark_slug
            }
        ),
        format!("  Why:      {}", s.rationale),
    ]
    .join("\n")
}

pub fn render_time_travel_tui(vm: &TimeTravelScrubber) -> String {
    let axis = match vm.axis {
        TimeAxis::Evolog => "evolog",
        TimeAxis::OpLog => "op-log",
    };
    let scope = match vm.blast_radius {
        BlastRadius::SingleChange => "single-change",
        BlastRadius::RepoWide => "repo-wide",
    };
    [
        format!("┌─ TIME-TRAVEL RECOVERY ({axis}) ────────────────────┐"),
        format!("│ Scope:   {scope}"),
        format!("│ Command: {}", vm.preview_command),
        format!("│ Why:     {}", vm.explanation),
        "└────────────────────────────────────────────────────┘".to_owned(),
    ]
    .join("\n")
}
