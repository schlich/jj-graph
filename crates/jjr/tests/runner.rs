//! Guarded planning, layered publishing, and guarded dry runs.
//!
//! The first test is a port of "planLayeredPublish publishes the green
//! bottom of a stack and keeps the rest local" (`test/reference.test.mjs`).
//! The JavaScript runner's dry runs were exercised end to end through
//! jj-graph's server; here a stand-in host plays the engine.

use std::cell::RefCell;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use jjr::graph::CommitSnapshot;
use jjr::graph::JjrChange;
use jjr::graph::JjrGraph;
use jjr::guardrails::JjrGuardrailPipeline;
use jjr::guardrails::WorkspaceReason;
use jjr::jev::JjrJevAssistant;
use jjr::narrator::JjrNarrator;
use jjr::patterns::JjrPatterns;
use jjr::runner::DryRunHost;
use jjr::runner::FormatterSummary;
use jjr::runner::HostError;
use jjr::runner::JjrRunner;
use jjr::runner::PlannedAction;
use jjr::runner::StackVerification;
use jjr::runner::VerificationCounts;
use jjr::types::ChangeIntent;
use jjr::types::ForgeKind;
use jjr::types::JjrRepoConfig;
use jjr::types::VerificationStatus;
use jjr::types::Zone;
use serde_json::Value;
use serde_json::json;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn green() -> VerificationStatus {
    VerificationStatus {
        formatted: Some(true),
        builds: Some(true),
        tests_pass: Some(true),
        verified: Some(true),
        ..Default::default()
    }
}

static COMMIT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// A mutable, verified, behavioral change, like the JavaScript tests' `change()`.
fn change(change_id: &str, parents: &[&str]) -> JjrChange {
    let seq = COMMIT_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let hex = format!("{seq:a>8x}");
    JjrChange {
        change_id: change_id.to_owned(),
        prefix: None,
        current_commit: CommitSnapshot {
            commit_id: format!("{hex:0<40}"),
            change_id: change_id.to_owned(),
            author: "t".to_owned(),
            files_count: Some(0),
            description: change_id.to_owned(),
            ..CommitSnapshot::default()
        },
        zone: Zone::Mutable,
        parents: strings(parents),
        children: Vec::new(),
        bookmarks: Vec::new(),
        remotes: Vec::new(),
        tags: Vec::new(),
        workspaces: Vec::new(),
        is_working_copy: false,
        is_hidden: false,
        intent: ChangeIntent::Behavioral,
        verification: green(),
        is_divergent: false,
        divergent_commits: None,
    }
}

fn trunk() -> JjrChange {
    let mut c = change("kkkkkkkk", &[]);
    c.zone = Zone::Immutable;
    c.bookmarks = strings(&["main"]);
    c.current_commit.description = "trunk".to_owned();
    c
}

fn graph(changes: Vec<JjrChange>) -> JjrGraph {
    JjrGraph::new(changes, JjrRepoConfig::default(), None)
}

/// A runner that never calls out: no Jev client, no LLM transport.
fn runner() -> JjrRunner {
    JjrRunner::new(
        JjrGuardrailPipeline::new(),
        JjrJevAssistant::offline(),
        JjrNarrator::new(None, JjrJevAssistant::offline()),
    )
}

#[test]
fn plan_layered_publish_publishes_the_green_bottom_of_a_stack_and_keeps_the_rest_local() {
    let mut top = change("oooooooo", &["nnnnnnnn"]);
    top.verification = VerificationStatus::unknown();
    let g = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]),
        change("nnnnnnnn", &["mmmmmmmm"]),
        top,
    ]);
    let runner = runner();
    let plan = runner.plan_layered_publish(&g, "oooooooo", None).unwrap();
    assert_eq!(plan.publish, ["mmmmmmmm", "nnnnnnnn"]);
    assert_eq!(plan.keep_local, ["oooooooo"]);
    assert_eq!(
        plan.commands,
        ["jj git push -c mmmmmmmm", "jj git push -c nnnnnnnn"]
    );
    let gerrit = runner
        .plan_layered_publish(&g, "oooooooo", Some(ForgeKind::Gerrit))
        .unwrap();
    assert_eq!(
        gerrit.commands,
        ["jj gerrit upload -r nnnnnnnn"],
        "a stack-aware forge uploads from the top publishable layer"
    );
    // The JavaScript test read these through the publish-plan view model
    // (jjr/ui, not ported yet): two layers publish now, the third shows blocked.
    assert_eq!(plan.publish.len(), 2);
    assert!(!plan.layers[2].publishable);
    assert!(
        plan.layers[2].reasons[0].starts_with("PublishingGate: "),
        "{:?}",
        plan.layers[2].reasons
    );
    assert_eq!(
        runner
            .plan_bookmark(&g, &strings(&["feat"]), "oooooooo")
            .guard_result
            .warnings[0]
            .rule_name,
        "PublishingGate"
    );
}

#[test]
fn layered_publish_finds_the_head_by_commit_id_or_revset_and_reports_a_missing_one() {
    let g = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]),
        change("nnnnnnnn", &["mmmmmmmm"]),
    ]);
    let runner = runner();
    let by_commit = g.get("nnnnnnnn").unwrap().current_commit.commit_id.clone();
    assert_eq!(
        runner
            .plan_layered_publish(&g, &by_commit, None)
            .unwrap()
            .head,
        "nnnnnnnn"
    );
    let by_revset = runner
        .plan_layered_publish(&g, "nnnnnnnn-", Some(ForgeKind::GithubStack))
        .unwrap();
    assert_eq!(
        (by_revset.head.as_str(), by_revset.commands.as_slice()),
        ("mmmmmmmm", &["jj-stack submit mmmmmmmm".to_owned()][..])
    );
    assert_eq!(
        by_revset.adapter.name,
        "GitHub native stacks (jj-stack / gh stack)"
    );
    let missing = runner
        .plan_layered_publish(&g, "zzzzzzzz", None)
        .unwrap_err();
    assert_eq!(
        missing.to_string(),
        "Change zzzzzzzz not found in the loaded graph."
    );
}

#[test]
fn planners_name_the_command_and_carry_the_guardrails_verdict() {
    let g = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]),
        change("nnnnnnnn", &["mmmmmmmm"]),
    ]);
    let runner = runner();
    let first_blocker =
        |p: &PlannedAction| p.guard_result.blockers.first().map(|d| d.rule_name.clone());

    let rewrite = runner.plan_mutation(&g, &strings(&["kkkkkkkk"]), "jj describe kkkkkkkk", None);
    assert!(rewrite.blocked);
    assert_eq!(
        first_blocker(&rewrite).as_deref(),
        Some("ImmutableBedrockGuard")
    );
    // With the argv, the guardrails also see what the command rewrites: `squash -r n` rewrites n-.
    let squash = runner.plan_mutation(
        &g,
        &[],
        "jj squash -r mmmmmmmm",
        Some(&strings(&["squash", "-r", "mmmmmmmm"])),
    );
    assert_eq!(
        (squash.command.as_str(), first_blocker(&squash).as_deref()),
        ("jj squash -r mmmmmmmm", Some("ImmutableBedrockGuard"))
    );
    let addressed = runner.plan_mutation(
        &g,
        &[],
        "jj describe",
        Some(&strings(&[
            "describe",
            &g.get("mmmmmmmm").unwrap().current_commit.commit_id[..8],
            "-m",
            "x",
        ])),
    );
    assert!(!addressed.blocked);
    assert_eq!(
        addressed.guard_result.warnings[0].rule_name,
        "ChangeIdAddressingGuard"
    );

    assert_eq!(
        runner
            .plan_bookmark(&g, &strings(&["a", "b"]), "mmmmmmmmmmmm")
            .command,
        "jj bookmark set a b -r mmmmmmmm"
    );
    let push = runner.plan_push(&g, &strings(&["mmmmmmmm", "nnnnnnnn"]), None);
    assert_eq!(
        (push.command.as_str(), push.blocked),
        ("jj git push -c mmmmmmmm nnnnnnnn", false)
    );
    assert_eq!(
        runner.plan_push(&g, &[], Some("main")).command,
        "jj git push --bookmark main"
    );

    let fetch = runner.plan_git_interop(&g, "git fetch");
    assert_eq!(
        (fetch.command.as_str(), first_blocker(&fetch).as_deref()),
        ("git fetch", Some("ColocatedGitGuard"))
    );
    assert!(!runner.plan_git_interop(&g, "git status").blocked);

    let switch = runner.plan_workspace_add(&g, Some(WorkspaceReason::SwitchBranch));
    assert_eq!(
        (switch.command.as_str(), first_blocker(&switch).as_deref()),
        ("jj workspace add", Some("WorkspaceDisciplineGuard"))
    );
    assert!(
        !runner
            .plan_workspace_add(&g, Some(WorkspaceReason::ParallelBuildOrAgent))
            .blocked
    );
    assert_eq!(
        runner.plan_workspace_add(&g, None).guard_result.warnings[0].rule_name,
        "WorkspaceDisciplineGuard"
    );
}

// ---------------------------------------------------------------------------
// Dry runs against a stand-in for jj-graph's engine.

/// Serves a fixed graph and records the dry runs it is asked for.
struct FakeHost {
    changes: Vec<JjrChange>,
    runs: RefCell<Vec<(Vec<String>, String)>>,
}

impl FakeHost {
    /// trunk() with a mutable working copy on top.
    fn new() -> Self {
        let mut wc = change("mmmmmmmm", &["kkkkkkkk"]);
        wc.is_working_copy = true;
        Self {
            changes: vec![trunk(), wc],
            runs: RefCell::new(Vec::new()),
        }
    }

    fn runs(&self) -> Vec<(Vec<String>, String)> {
        self.runs.borrow().clone()
    }
}

impl DryRunHost for FakeHost {
    fn live_graph(&self, revset: &str) -> Result<(JjrGraph, Value), HostError> {
        Ok((graph(self.changes.clone()), json!({ "revset": revset })))
    }

    fn dry_run(&self, args: &[String], revset: &str) -> Result<(Value, Value), HostError> {
        self.runs
            .borrow_mut()
            .push((args.to_vec(), revset.to_owned()));
        Ok((json!({ "changed": true }), json!({ "op": "dry" })))
    }

    fn verify(&self, range: Option<&str>, revset: &str) -> Result<StackVerification, HostError> {
        Ok(StackVerification {
            op: "tip".to_owned(),
            range: range.unwrap_or("trunk()..@").to_owned(),
            command: None,
            formatter: FormatterSummary::default(),
            results: Vec::new(),
            skipped: 0,
            summary: VerificationCounts::default(),
            hint: Some(revset.to_owned()),
        })
    }
}

#[test]
fn dry_runs_pass_the_guardrails_before_the_host_runs_anything() {
    let host = FakeHost::new();
    let runner = runner();

    // Rewriting trunk() is blocked against the live graph; the host never runs it.
    let blocked = runner
        .dry_run(
            &host,
            &strings(&["describe", "kkkkkkkk", "-m", "nope"]),
            None,
            false,
        )
        .unwrap();
    assert!(blocked.blocked);
    assert_eq!(blocked.result, None);
    assert_eq!(
        blocked.guard_result["blockers"][0]["ruleName"],
        "ImmutableBedrockGuard"
    );
    assert_eq!(
        blocked.state,
        json!({ "revset": "all()" }),
        "the live state, read from the default revset"
    );
    assert!(host.runs().is_empty());

    // Mutable work runs on the host, against the revset asked for.
    let args = strings(&["describe", "mmmmmmmm", "-m", "feat: x"]);
    let ran = runner
        .dry_run(&host, &args, Some("mutable()"), false)
        .unwrap();
    assert!(!ran.blocked);
    assert_eq!(ran.guard_result["allowed"], true);
    assert_eq!(
        (ran.result, ran.state),
        (Some(json!({ "changed": true })), json!({ "op": "dry" }))
    );
    assert_eq!(host.runs(), [(args, "mutable()".to_owned())]);

    let verified = runner
        .verify_stack(&host, Some("trunk()..@-"), None)
        .unwrap();
    assert_eq!(
        (verified.range.as_str(), verified.hint.as_deref()),
        ("trunk()..@-", Some("all()"))
    );
}

#[test]
fn previews_skip_steps_jj_cannot_dry_run_and_stop_at_the_first_blocked_one() {
    let host = FakeHost::new();
    let runner = runner();

    let outcomes = runner
        .preview_pattern(
            &host,
            &JjrPatterns::resolve_conflict_cleanly("mmmmmmmm"),
            None,
            false,
        )
        .unwrap();
    let shape: Vec<(bool, Option<bool>)> = outcomes
        .iter()
        .map(|o| (o.skipped, o.outcome.as_ref().map(|r| r.blocked)))
        .collect();
    assert_eq!(
        shape,
        [
            (false, Some(false)),
            (true, None),
            (true, None),
            (false, Some(true))
        ]
    );
    // The stand-in's graph never moves, so `jj squash` would fold @ into trunk().
    assert_eq!(
        outcomes[3].outcome.as_ref().unwrap().guard_result["blockers"][0]["ruleName"],
        "ImmutableBedrockGuard"
    );
    assert_eq!(
        host.runs(),
        [(strings(&["new", "mmmmmmmm"]), "all()".to_owned())]
    );
    // Skipped steps carry why and the command to run by hand; previewed ones the dry-run outcome, inline.
    let json = serde_json::to_value(&outcomes).unwrap();
    assert_eq!(
        json[1],
        json!({
            "title": "Resolve the conflict markers",
            "skipped": true,
            "reason": "Interactive or external step",
            "command": "jj resolve   # or edit the markers in your editor",
        })
    );
    assert_eq!(
        (&json[0]["blocked"], &json[0]["result"]),
        (&json!(false), &json!({ "changed": true }))
    );

    // Editing trunk() is blocked, so the rest of the workflow is not previewed.
    let edit = runner
        .preview_pattern(
            &host,
            &JjrPatterns::edit_workflow("kkkkkkkk", Some("refactor: seam")),
            None,
            false,
        )
        .unwrap();
    assert_eq!(edit.len(), 1);
    assert!(edit[0].outcome.as_ref().unwrap().blocked);
    assert_eq!(host.runs().len(), 1);
}
