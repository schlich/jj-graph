//! Workflow recipes, forge adapters, the SDLC lifecycle, time-travel
//! recovery and graph-driven suggestions.
//!
//! The first test is a port of "recipes follow the reference and stay
//! dry-runnable where jj allows" (`test/reference.test.mjs`); the others pin
//! the JavaScript behaviour of the functions no JavaScript test covers.

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use jjr::graph::CommitSnapshot;
use jjr::graph::JjrChange;
use jjr::graph::JjrGraph;
use jjr::graph::TreeConflict;
use jjr::patterns::BlastRadius;
use jjr::patterns::JjrPatterns;
use jjr::patterns::JjrRecipe;
use jjr::patterns::PatternStep;
use jjr::patterns::RecoveryScope;
use jjr::patterns::RedTestOptions;
use jjr::patterns::TimeAxis;
use jjr::patterns::TimeTravelParams;
use jjr::patterns::forge_adapters;
use jjr::patterns::plan_time_travel_recovery;
use jjr::patterns::sdlc_lifecycle;
use jjr::patterns::suggest_patterns_for_graph;
use jjr::types::ChangeIntent;
use jjr::types::ForgeKind;
use jjr::types::JjrRepoConfig;
use jjr::types::VerificationStatus;
use jjr::types::Zone;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

/// A step's argv, `None` when the step has none to dry-run.
fn args(step: &PatternStep) -> Option<Vec<&str>> {
    step.args
        .as_ref()
        .map(|a| a.iter().map(String::as_str).collect())
}

/// The jj subcommand of each step.
fn subcommands(recipe: &JjrRecipe) -> Vec<Option<&str>> {
    recipe
        .steps
        .iter()
        .map(|s| s.args.as_ref().and_then(|a| a.first()).map(String::as_str))
        .collect()
}

#[test]
fn recipes_follow_the_reference_and_stay_dry_runnable_where_jj_allows() {
    let red = JjrPatterns::verify_red_test(
        &strings(&["src/impl.js"]),
        &RedTestOptions {
            change_id: Some("mmmmmmmmmmmm".into()),
            red_snapshot: Some("kkkkkkkk/2".into()),
            test_command: None,
        },
    );
    assert_eq!(
        subcommands(&red),
        [
            None,
            None,
            Some("new"),
            Some("restore"),
            None,
            Some("abandon")
        ],
        "only the probe touches the repository, and it is thrown away"
    );
    assert_eq!(red.steps[0].command, "jj evolog -r mmmmmmmm");
    assert_eq!(
        red.steps[1].command, "jj run --ignore-changes -r kkkkkkkk/2 -- npm test",
        "the recorded red runs again in an isolated checkout"
    );
    assert_eq!(args(&red.steps[2]), Some(vec!["new", "mmmmmmmmmmmm"]));
    assert_eq!(
        args(&red.steps[3]),
        Some(vec!["restore", "--from", "mmmmmmmmmmmm-", "src/impl.js"]),
        "the probe takes the implementation away and keeps the tests"
    );
    assert_eq!(
        red.steps[4].command,
        "jj run --ignore-changes -r @ -- npm test"
    );
    assert!(
        !red.steps
            .iter()
            .any(|s| s.command.contains("split") || s.command.contains("squash")),
        "nothing is split off and folded back"
    );
    let unknown = JjrPatterns::verify_red_test(&[], &RedTestOptions::default());
    assert_eq!(
        unknown.steps[1].command,
        "jj run --ignore-changes -r <change>/<n> -- npm test"
    );
    assert!(
        unknown.steps.iter().all(|s| !s.dry_runnable),
        "without a change and its files there is nothing to preview"
    );

    let conv = JjrPatterns::post_merge_convergence(false);
    assert_eq!(
        args(&conv.steps[1]),
        Some(vec![
            "rebase",
            "-s",
            "roots(trunk()..@)",
            "-o",
            "trunk()",
            "--skip-emptied"
        ])
    );
    assert!(
        !conv.steps.iter().any(|s| s.command.contains("all:")),
        "jj 0.47 rejects the all: prefix"
    );

    assert_eq!(
        args(&JjrPatterns::characterization_tests_below("mmmmmmmm", "parser", None).steps[0]),
        Some(vec![
            "new",
            "--no-edit",
            "-B",
            "mmmmmmmm",
            "-m",
            "test: characterize parser"
        ])
    );
    assert_eq!(
        JjrPatterns::expand_contract("the user id column", Some("int"), Some("uuid"))
            .steps
            .len(),
        3
    );
    assert_eq!(
        args(&JjrPatterns::isolate_activation("nnnnnnnn", "new-billing").steps[0]),
        Some(vec!["new", "nnnnnnnn", "-m", "feat: activate new-billing"])
    );
    let shared = JjrPatterns::extract_shared_primitive(
        &strings(&["aaaa", "bbbb"]),
        "feat: shared parser",
        None,
        &strings(&["src/parse.js"]),
    );
    assert_eq!(
        args(&shared.steps[0]),
        Some(vec![
            "new",
            "--no-edit",
            "-B",
            "aaaa",
            "-B",
            "bbbb",
            "-m",
            "feat: shared parser"
        ])
    );
    assert_eq!(
        args(&shared.steps[1]),
        Some(vec![
            "squash",
            "--from",
            "@",
            "--into",
            "aaaa- & bbbb-",
            "src/parse.js"
        ])
    );
    let resolve = JjrPatterns::resolve_conflict_cleanly("mmmmmmmm");
    let dry_runnable: Vec<Option<Vec<&str>>> = resolve
        .steps
        .iter()
        .filter(|s| s.dry_runnable)
        .map(args)
        .collect();
    assert_eq!(
        dry_runnable,
        [Some(vec!["new", "mmmmmmmm"]), Some(vec!["squash"])]
    );
    assert_eq!(
        JjrPatterns::stack_validation(Some("trunk()..@"), Some("npm test")).steps[1].command,
        "jj run --ignore-changes -r '(trunk()..@) & mutable()' -- npm test"
    );
    assert_eq!(
        args(
            &JjrPatterns::compose_agent_workspaces(&strings(&["agent-a", "agent-b"]), None).steps
                [0]
        ),
        Some(vec![
            "new",
            "agent-a@",
            "agent-b@",
            "-m",
            "local: agents megamerge"
        ])
    );
    assert_eq!(
        subcommands(&JjrPatterns::squash_workflow("feat: x")),
        [Some("describe"), Some("new"), Some("squash")]
    );
    assert_eq!(
        subcommands(&JjrPatterns::edit_workflow(
            "mmmmmmmm",
            Some("refactor: seam")
        )),
        [Some("edit"), Some("new"), Some("next")]
    );
    for adapter in forge_adapters() {
        let command = JjrPatterns::publish_command(adapter.kind, "mmmmmmmmmmmm");
        assert!(command.ends_with("mmmmmmmm"), "{command}");
    }
    assert_eq!(
        sdlc_lifecycle().iter().map(|p| p.phase).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn recipes_quote_free_text_like_json_and_serialize_for_the_web_ui() {
    let squash = JjrPatterns::squash_workflow("feat: say \"hi\"\n\tdone");
    assert_eq!(
        squash.steps[0].command,
        r#"jj describe -m "feat: say \"hi\"\n\tdone""#
    );
    assert_eq!(
        args(&squash.steps[0]),
        Some(vec!["describe", "-m", "feat: say \"hi\"\n\tdone"])
    );
    // Branch by Abstraction quotes its messages literally, as the reference does.
    assert_eq!(
        JjrPatterns::branch_by_abstraction("Storage").steps[0].command,
        "jj new trunk() -m \"refactor: extract Storage interface\""
    );

    let json = serde_json::to_value(JjrPatterns::isolate_activation(
        "nnnnnnnnnnnn",
        "new-billing",
    ))
    .unwrap();
    assert_eq!(json["id"], "isolate-activation");
    assert_eq!(json["steps"][0]["dryRunnable"], true);
    assert_eq!(json["steps"][1]["args"], serde_json::Value::Null);
    assert_eq!(json["steps"][1]["command"], "jj split -r nnnnnnnn");
}

#[test]
fn time_travel_recovery_prefers_one_change_over_the_whole_repository() {
    let base = TimeTravelParams {
        scope: RecoveryScope::SingleChange,
        target_op_id: None,
        target_change_id: Some("mmmmmmmmmmmm".into()),
        target_evolog_commit: None,
        target_evolog_offset: None,
    };
    let plan = |params: TimeTravelParams| plan_time_travel_recovery(&params).unwrap();

    let by_commit = plan(TimeTravelParams {
        target_evolog_commit: Some("1234567890abcdef".into()),
        ..base.clone()
    });
    assert_eq!(
        (by_commit.axis, by_commit.blast_radius),
        (TimeAxis::Evolog, BlastRadius::SingleChange)
    );
    assert_eq!(
        by_commit.args,
        [
            "restore",
            "--from",
            "1234567890abcdef",
            "--to",
            "mmmmmmmmmmmm"
        ]
    );
    assert_eq!(
        by_commit.command,
        "jj restore --from 12345678 --to mmmmmmmm"
    );
    let json = serde_json::to_value(&by_commit).unwrap();
    assert_eq!(
        (json["axis"].as_str(), json["blastRadius"].as_str()),
        (Some("evolog"), Some("single-change"))
    );

    let by_offset = plan(TimeTravelParams {
        target_evolog_offset: Some(2),
        ..base.clone()
    });
    assert_eq!(
        by_offset.args,
        [
            "restore",
            "--from",
            "mmmmmmmmmmmm/2",
            "--to",
            "mmmmmmmmmmmm"
        ]
    );
    assert_eq!(
        by_offset.command,
        "jj restore --from mmmmmmmm/2 --to mmmmmmmm"
    );

    // Without an earlier version of the change, the operation log rewinds everything.
    let op = plan(TimeTravelParams {
        target_evolog_offset: Some(0),
        target_op_id: Some("0123456789abcdef0123".into()),
        ..base.clone()
    });
    assert_eq!(
        (op.axis, op.blast_radius),
        (TimeAxis::OpLog, BlastRadius::RepoWide)
    );
    assert_eq!(op.args, ["op", "restore", "0123456789abcdef0123"]);
    assert_eq!(op.command, "jj op restore 0123456789ab");
    let undo = plan(TimeTravelParams {
        scope: RecoveryScope::Undo,
        ..base
    });
    assert_eq!(
        (undo.args, undo.command),
        (strings(&["undo"]), "jj undo".to_owned())
    );

    assert!(
        JjrPatterns::publish_command(ForgeKind::Gerrit, "mmmmmmmm").starts_with("jj gerrit upload")
    );
}

// ---------------------------------------------------------------------------
// Graph fixtures, like the JavaScript tests' `change()` helper.

static COMMIT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// A mutable, verified, behavioral change.
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
        verification: VerificationStatus {
            formatted: Some(true),
            builds: Some(true),
            tests_pass: Some(true),
            verified: Some(true),
            ..Default::default()
        },
        is_divergent: false,
        divergent_commits: None,
    }
}

trait Fixture {
    fn intent(self, intent: ChangeIntent) -> Self;
    fn description(self, description: &str) -> Self;
    fn paths(self, paths: &[&str]) -> Self;
    fn empty(self) -> Self;
    fn conflicted(self) -> Self;
    fn working_copy(self) -> Self;
}

impl Fixture for JjrChange {
    fn intent(mut self, intent: ChangeIntent) -> Self {
        self.intent = intent;
        self
    }

    fn description(mut self, description: &str) -> Self {
        self.current_commit.description = description.to_owned();
        self
    }

    fn paths(mut self, paths: &[&str]) -> Self {
        self.current_commit.touched_paths = strings(paths);
        self.current_commit.files_count = Some(paths.len());
        self
    }

    fn empty(mut self) -> Self {
        self.current_commit.is_empty = true;
        self
    }

    fn conflicted(mut self) -> Self {
        self.current_commit.conflict = TreeConflict {
            is_conflicted: true,
            conflicted_paths: Vec::new(),
        };
        self
    }

    fn working_copy(mut self) -> Self {
        self.is_working_copy = true;
        self
    }
}

fn trunk() -> JjrChange {
    let mut c = change("kkkkkkkk", &[]).description("trunk");
    c.zone = Zone::Immutable;
    c.bookmarks = strings(&["main"]);
    c
}

/// The empty, undescribed working copy.
fn scratchpad(parent: &str) -> JjrChange {
    change("wwwwwwww", &[parent])
        .working_copy()
        .empty()
        .description("")
        .intent(ChangeIntent::WorkingCopy)
}

fn graph(changes: Vec<JjrChange>) -> JjrGraph {
    JjrGraph::new(changes, JjrRepoConfig::default(), None)
}

/// Each suggested recipe's id with the argv of its first dry-runnable step.
fn suggestions(g: &JjrGraph) -> Vec<(String, Vec<String>)> {
    suggest_patterns_for_graph(g)
        .into_iter()
        .map(|r| {
            let first = r
                .steps
                .iter()
                .find_map(|s| s.args.clone())
                .unwrap_or_default();
            (r.id, first)
        })
        .collect()
}

fn expect(pairs: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    pairs
        .iter()
        .map(|(id, args)| ((*id).to_owned(), strings(args)))
        .collect()
}

#[test]
fn suggested_recipes_follow_the_graph() {
    // A conflict, six parallel roots, a behavioral working copy and an unguarded refactor.
    let busy = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]).conflicted(),
        change("nnnnnnnn", &["mmmmmmmm"]).conflicted(),
        change("oooooooo", &["kkkkkkkk"]).intent(ChangeIntent::Structural),
        change("pppppppp", &["kkkkkkkk"]).working_copy(),
        change("qqqqqqqq", &["kkkkkkkk"]).intent(ChangeIntent::TestHarness),
        change("rrrrrrrr", &["qqqqqqqq"]).intent(ChangeIntent::Structural),
        change("ssssssss", &["kkkkkkkk"]),
        change("tttttttt", &["kkkkkkkk"]),
    ]);
    assert_eq!(
        suggestions(&busy),
        expect(&[
            // Where the conflict starts, not the child that inherits it.
            ("resolve-conflict", &["new", "mmmmmmmm"]),
            // At most four arms.
            (
                "local-megamerge",
                &[
                    "new",
                    "mmmmmmmm",
                    "oooooooo",
                    "pppppppp",
                    "qqqqqqqq",
                    "-m",
                    "local: dev megamerge"
                ]
            ),
            (
                "tidy-first",
                &[
                    "new",
                    "-B",
                    "pppppppp",
                    "-m",
                    "refactor: prep seam before feature"
                ]
            ),
            (
                "characterization-tests",
                &[
                    "new",
                    "--no-edit",
                    "-B",
                    "oooooooo",
                    "-m",
                    "test: characterize current behavior"
                ]
            ),
            (
                "stack-validation",
                &["fix", "-s", "roots((trunk()..@) & mutable())"]
            ),
            (
                "post-merge-convergence",
                &[
                    "rebase",
                    "-s",
                    "roots(mutable())",
                    "-o",
                    "trunk()",
                    "--skip-emptied"
                ]
            ),
        ])
    );

    // A megamerge carrying its own edits: route them out, never compose another.
    let mega = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]),
        change("nnnnnnnn", &["kkkkkkkk"]),
        change("pppppppp", &["mmmmmmmm", "nnnnnnnn"])
            .description("local: dev megamerge")
            .intent(ChangeIntent::Megamerge)
            .working_copy()
            .paths(&["a.js"]),
    ]);
    let mega_suggestions = suggestions(&mega);
    assert_eq!(
        mega_suggestions[0],
        (
            "absorb-fixups".to_owned(),
            strings(&["absorb", "--from", "pppppppp"])
        )
    );
    assert!(
        !mega_suggestions
            .iter()
            .any(|(id, _)| id == "local-megamerge")
    );

    // A refactor already resting on tests needs no characterization tests.
    let guarded = graph(vec![
        trunk(),
        change("qqqqqqqq", &["kkkkkkkk"]).intent(ChangeIntent::TestHarness),
        change("rrrrrrrr", &["qqqqqqqq"]).intent(ChangeIntent::Structural),
    ]);
    assert_eq!(
        suggestions(&guarded),
        expect(&[
            (
                "stack-validation",
                &["fix", "-s", "roots((trunk()..@) & mutable())"]
            ),
            (
                "post-merge-convergence",
                &[
                    "rebase",
                    "-s",
                    "roots(trunk()..@)",
                    "-o",
                    "trunk()",
                    "--skip-emptied"
                ]
            ),
        ])
    );

    // At rest only convergence applies; with nothing mutable, nothing does.
    assert_eq!(
        suggestions(&graph(vec![trunk(), scratchpad("kkkkkkkk")])),
        expect(&[(
            "post-merge-convergence",
            &[
                "rebase",
                "-s",
                "roots(trunk()..@)",
                "-o",
                "trunk()",
                "--skip-emptied"
            ]
        )])
    );
    assert!(suggestions(&graph(vec![trunk()])).is_empty());
}
