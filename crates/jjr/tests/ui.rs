//! "Portable TUI and GUI adapters consume shared ViewModels consistently"
//! (test/jjr.test.mjs).

use jjr::graph::CommitSnapshot;
use jjr::graph::DependencyAssessment;
use jjr::graph::JjrChange;
use jjr::graph::JjrGraph;
use jjr::guardrails::DecisionSeverity;
use jjr::guardrails::GuardrailDecision;
use jjr::jev::ChangeTriageInput;
use jjr::jev::JjrJevAssistant;
use jjr::patterns::JjrPatterns;
use jjr::patterns::RecoveryScope;
use jjr::patterns::TimeAxis;
use jjr::patterns::TimeTravelParams;
use jjr::patterns::plan_time_travel_recovery;
use jjr::types::ChangeIntent;
use jjr::types::ForgeKind;
use jjr::types::JjrRepoConfig;
use jjr::types::VerificationStatus;
use jjr::types::Zone;
use jjr::ui;

#[allow(clippy::too_many_arguments)]
fn change(
    change_id: &str,
    commit_id: &str,
    parents: &[&str],
    children: &[&str],
    description: &str,
    zone: Zone,
    wc: bool,
    bookmark: &str,
) -> JjrChange {
    JjrChange {
        change_id: change_id.into(),
        prefix: None,
        current_commit: CommitSnapshot {
            commit_id: commit_id.into(),
            change_id: change_id.into(),
            parent_commits: Vec::new(),
            author: "t".into(),
            touched_paths: if zone == Zone::Mutable {
                vec!["a.js".into()]
            } else {
                Vec::new()
            },
            description: description.into(),
            ..Default::default()
        },
        zone,
        parents: parents.iter().map(|p| (*p).to_owned()).collect(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        bookmarks: vec![bookmark.into()],
        remotes: Vec::new(),
        tags: Vec::new(),
        workspaces: Vec::new(),
        is_working_copy: wc,
        is_hidden: false,
        intent: ChangeIntent::Behavioral,
        verification: VerificationStatus {
            formatted: Some(true),
            builds: Some(true),
            tests_pass: Some(true),
            ..Default::default()
        },
        is_divergent: false,
        divergent_commits: None,
    }
}

#[test]
fn portable_tui_and_gui_adapters_consume_shared_view_models_consistently() {
    let graph = JjrGraph::new(
        vec![
            change(
                "kkkkkkkk",
                "11111111",
                &[],
                &["mmmmmmmm"],
                "main",
                Zone::Immutable,
                false,
                "main",
            ),
            change(
                "mmmmmmmm",
                "22222222",
                &["kkkkkkkk"],
                &[],
                "feat: session store",
                Zone::Mutable,
                true,
                "feat/session",
            ),
        ],
        JjrRepoConfig::default(),
        None,
    );

    let vm = ui::build_dag_graph_view_model(&graph, Some("mmmmmmmm"));
    let tui = ui::render_dag_tui(&vm, false);
    let gui_rows = ui::to_gui_dag_rows(&vm);
    assert!(tui.contains("JJR REVISION GRAPH"));
    assert!(
        regex::Regex::new(r"▸\s+@ mmmmmmmm").unwrap().is_match(&tui),
        "{tui}"
    );
    assert_eq!(gui_rows.len(), 2);
    assert!(gui_rows[0].selected);

    let banner = ui::build_guardrail_banner(&[GuardrailDecision {
        allowed: false,
        rule_name: "MegamergeFence".into(),
        severity: DecisionSeverity::Block,
        message: "Blocked".into(),
        remediation: Some("Push arm".into()),
        calibrated_probability: None,
        calibrated_confidence: None,
    }]);
    assert!(ui::render_guardrail_banner_tui(&banner, false).contains("MegamergeFence"));
    assert_eq!(ui::to_gui_alert_props(&banner).tone, ui::Tone::Danger);

    let verdict = JjrGraph::evaluate_dependency(&DependencyAssessment {
        base: "kkkkkkkk".into(),
        child: "mmmmmmmm".into(),
        child_causally_depends_on_base: Some(false),
        base_independently_reviewable: Some(true),
        ..Default::default()
    });
    let dep_vm = ui::build_dependency_gate("kkkkkkkk", "mmmmmmmm", &verdict, None);
    assert!(ui::render_dependency_gate_tui(&dep_vm).contains("PARALLELIZE"));
    assert_eq!(
        ui::to_gui_dependency_card(&dep_vm).outcome.as_str(),
        "parallelize"
    );

    let triage = JjrJevAssistant::offline().triage_change(&ChangeTriageInput {
        change_id: "mmmmmmmm".into(),
        description: "feat: session store".into(),
        touched_paths: vec!["a.js".into()],
        ..Default::default()
    });
    let triage_vm = ui::build_triage_card("mmmmmmmm", &triage);
    assert!(ui::render_triage_tui(&triage_vm).contains("JEV CHANGE TRIAGE"));
    assert_eq!(
        ui::to_gui_triage_props(&triage_vm).intent.label,
        "behavioral"
    );

    let plan = plan_time_travel_recovery(&TimeTravelParams {
        scope: RecoveryScope::SingleChange,
        target_op_id: None,
        target_change_id: Some("mmmmmmmm".into()),
        target_evolog_commit: Some("1234567890abcdef".into()),
        target_evolog_offset: None,
    })
    .unwrap();
    assert_eq!(plan.axis, TimeAxis::Evolog);
    assert!(
        JjrPatterns::publish_command(ForgeKind::Gerrit, "mmmmmmmm").contains("jj gerrit upload")
    );
}
