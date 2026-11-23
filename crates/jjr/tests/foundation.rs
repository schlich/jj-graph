//! The foundation: identity types, the jj command model, and the graph.
//!
//! Ports of `test/jjr.test.mjs` ("branded identity-state validators
//! separate ChangeId, CommitId, OpId, and BookmarkName"; "Two-Part
//! Dependency Test handles all verdicts including calibrated uncertainty
//! band") and `test/reference.test.mjs` ("describeMutation classifies what a
//! jj command does to each revision it names"; "JjrGraph.resolve handles @,
//! parent/child operators, bookmarks, workspaces, and id prefixes";
//! "diagnostics cover activation, megamerge hygiene, conflicts, bundled
//! tests, trunk drift, and deep stacks"; "classifyShape maps the mutable
//! zone onto the canonical DAG shapes").

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use jjr::commands::BookmarkTarget;
use jjr::commands::describe_mutation;
use jjr::graph::CommitSnapshot;
use jjr::graph::DependencyAssessment;
use jjr::graph::DependencyOutcome;
use jjr::graph::DiagnosticCode;
use jjr::graph::GraphDiagnostic;
use jjr::graph::ImmutableHeadsFact;
use jjr::graph::JjrChange;
use jjr::graph::JjrGraph;
use jjr::graph::PreflightFacts;
use jjr::graph::PreflightRow;
use jjr::graph::TreeConflict;
use jjr::graph::TrunkFact;
use jjr::types::ChangeIntent;
use jjr::types::DagShape;
use jjr::types::IdKind;
use jjr::types::JjrRepoConfig;
use jjr::types::VerificationStatus;
use jjr::types::Zone;
use jjr::types::as_bookmark;
use jjr::types::as_change_id;
use jjr::types::as_commit_id;
use jjr::types::as_op_id;
use jjr::types::canonical_shape;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
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
    fn commit(self, commit_id: &str) -> Self;
    fn description(self, description: &str) -> Self;
    fn paths(self, paths: &[&str]) -> Self;
    fn empty(self) -> Self;
    fn conflicted(self) -> Self;
    fn immutable(self) -> Self;
    fn intent(self, intent: ChangeIntent) -> Self;
    fn working_copy(self) -> Self;
    fn bookmarks(self, names: &[&str]) -> Self;
    fn workspaces(self, names: &[&str]) -> Self;
}

impl Fixture for JjrChange {
    fn commit(mut self, commit_id: &str) -> Self {
        self.current_commit.commit_id = commit_id.to_owned();
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

    fn immutable(mut self) -> Self {
        self.zone = Zone::Immutable;
        self
    }

    fn intent(mut self, intent: ChangeIntent) -> Self {
        self.intent = intent;
        self
    }

    fn working_copy(mut self) -> Self {
        self.is_working_copy = true;
        self
    }

    fn bookmarks(mut self, names: &[&str]) -> Self {
        self.bookmarks = strings(names);
        self
    }

    fn workspaces(mut self, names: &[&str]) -> Self {
        self.workspaces = strings(names);
        self
    }
}

/// `trunk()`: immutable and bookmarked `main`.
fn trunk_at(change_id: &str, parents: &[&str]) -> JjrChange {
    change(change_id, parents)
        .immutable()
        .bookmarks(&["main"])
        .description("trunk")
}

fn trunk() -> JjrChange {
    trunk_at("kkkkkkkk", &[])
}

fn graph(changes: Vec<JjrChange>) -> JjrGraph {
    JjrGraph::new(changes, JjrRepoConfig::default(), None)
}

/// A pre-flight that resolved `trunk()` to the immutable `kkkkkkkk`.
fn preflight() -> PreflightFacts {
    let trunk = PreflightRow {
        change_id: "kkkkkkkk".to_owned(),
        commit_id: "f".repeat(40),
        immutable: true,
    };
    PreflightFacts {
        trunk: TrunkFact::resolved(trunk.clone()),
        immutable_heads: ImmutableHeadsFact::resolved(vec![trunk]),
        remotes: strings(&["origin"]),
        ..PreflightFacts::default()
    }
}

// ---------------------------------------------------------------------------

#[test]
fn branded_identity_state_validators_separate_change_id_commit_id_op_id_and_bookmark_name() {
    assert_eq!(as_change_id("KMPQRSTU").unwrap(), "kmpqrstu");
    assert_eq!(as_commit_id("017147EF9A2C").unwrap(), "017147ef9a2c");
    assert_eq!(as_op_id("abcdef0123456789").unwrap(), "abcdef0123456789");
    assert_eq!(as_bookmark("feat/auth").unwrap(), "feat/auth");

    let err = as_change_id("017147ef9a2c").unwrap_err();
    assert_eq!(err.expected_kind, IdKind::ChangeId);
    assert!(err.to_string().contains("CommitId"), "{err}");
    let err = as_commit_id("kmpqrstu").unwrap_err();
    assert_eq!(err.expected_kind, IdKind::CommitId);
    assert!(err.to_string().contains("ChangeId"), "{err}");
    assert_eq!(
        as_bookmark("bad name").unwrap_err().expected_kind,
        IdKind::BookmarkName
    );
}

#[test]
fn two_part_dependency_test_handles_all_verdicts_including_the_calibrated_uncertainty_band() {
    let assess = |causal: f64, reviewable: f64| {
        JjrGraph::evaluate_dependency(&DependencyAssessment {
            base: "kkkkkkkk".to_owned(),
            child: "mmmmmmmm".to_owned(),
            causal_probability: Some(causal),
            reviewability_probability: Some(reviewable),
            ..DependencyAssessment::default()
        })
    };

    let par = assess(0.12, 0.88);
    assert_eq!(par.outcome, DependencyOutcome::Parallelize);
    assert_eq!(
        par.suggested_args.unwrap(),
        ["parallelize", "kkkkkkkk", "mmmmmmmm"]
    );

    let col = assess(0.91, 0.15);
    assert_eq!(col.outcome, DependencyOutcome::Collapse);
    assert_eq!(
        col.suggested_args.unwrap(),
        ["squash", "--from", "mmmmmmmm", "--into", "kkkkkkkk"]
    );

    assert_eq!(assess(0.89, 0.85).outcome, DependencyOutcome::Stack);

    let amb = assess(0.52, 0.85);
    assert_eq!(amb.outcome, DependencyOutcome::Confirm);
    assert_eq!(amb.suggested_args, None);
}

#[test]
fn describe_mutation_classifies_what_a_jj_command_does_to_each_revision_it_names() {
    let r = |args: &[&str]| describe_mutation(args).rewrites;
    assert!(
        r(&["new", "main"]).is_empty(),
        "jj new only reads its parents"
    );
    assert_eq!(describe_mutation(&["new", "main"]).parents, ["main"]);
    assert_eq!(
        r(&["new", "-B", "x"]),
        ["x"],
        "insert-before rewrites the target"
    );
    assert_eq!(
        r(&["new", "-A", "x"]),
        ["x+"],
        "insert-after rewrites the target's children"
    );
    assert_eq!(r(&["squash"]), ["@", "@-"]);
    assert_eq!(r(&["squash", "-r", "x"]), ["x", "x-"]);
    assert_eq!(r(&["squash", "--from", "x"]), ["x", "@"]);
    assert_eq!(r(&["squash", "--into", "y"]), ["y", "@"]);
    assert_eq!(r(&["rebase", "-r", "x", "-B", "y"]), ["x", "y"]);
    assert_eq!(
        r(&["rebase", "-d", "main"]),
        ["@"],
        "rebase defaults to -b @"
    );
    assert_eq!(r(&["restore", "--from", "x/1", "--to", "x"]), ["x"]);
    assert_eq!(r(&["restore", "file.txt"]), ["@"]);
    assert!(
        r(&["duplicate", "x"]).is_empty(),
        "duplicate only reads its sources"
    );
    assert!(r(&["revert", "-r", "x", "-o", "@"]).is_empty());
    assert_eq!(r(&["absorb", "--from", "m"]), ["m"]);
    assert_eq!(r(&["describe", "-m", "msg"]), ["@"]);
    assert_eq!(
        describe_mutation(&["split", "--parallel", "impl.js"]).filesets,
        ["impl.js"]
    );
    // bookmark set's -B means --allow-backwards, not insert-before.
    let bookmark = describe_mutation(&["bookmark", "set", "feat", "-B", "-r", "x"]);
    assert!(bookmark.rewrites.is_empty());
    assert_eq!(
        bookmark.bookmarks,
        [BookmarkTarget {
            names: strings(&["feat"]),
            target: "x".to_owned()
        }]
    );
    assert_eq!(
        describe_mutation(&["b", "create", "feat"]).bookmarks,
        [BookmarkTarget {
            names: strings(&["feat"]),
            target: "@".to_owned()
        }]
    );
    assert!(describe_mutation(&["abandon", "x"]).recovery);
    assert!(describe_mutation(&["metaedit", "--update-change-id", "x"]).recovery);
    assert!(describe_mutation(&["op", "restore", "abc"]).recovery);
    assert!(!describe_mutation(&["rebase", "-s", "x", "-o", "y"]).recovery);
    assert!(describe_mutation(&["--ignore-immutable", "describe", "x"]).ignore_immutable);
    assert!(!describe_mutation(&["git", "push"]).known);
}

#[test]
fn resolve_handles_at_parent_child_operators_bookmarks_workspaces_and_id_prefixes() {
    let g = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]).commit(&format!("abcdef1234{}", "0".repeat(30))),
        change("nnnnnnnn", &["mmmmmmmm"])
            .working_copy()
            .bookmarks(&["feat/x"])
            .workspaces(&["agent-a"]),
    ]);
    let ids = |rev: &str| {
        g.resolve(rev)
            .into_iter()
            .map(|c| c.change_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids("@"), ["nnnnnnnn"]);
    assert_eq!(ids("@-"), ["mmmmmmmm"]);
    assert_eq!(ids("@--"), ["kkkkkkkk"]);
    assert_eq!(ids("main+"), ["mmmmmmmm"]);
    assert_eq!(ids("(mm)+"), ["nnnnnnnn"]);
    assert_eq!(ids("feat/x-"), ["mmmmmmmm"]);
    assert_eq!(ids("agent-a@"), ["nnnnnnnn"]);
    assert_eq!(ids("abcdef"), ["mmmmmmmm"]);
    assert!(ids("trunk()").is_empty(), "functions are left to jj");
}

#[test]
fn diagnostics_cover_activation_megamerge_hygiene_conflicts_bundled_tests_trunk_drift_and_deep_stacks()
 {
    let codes = |g: &JjrGraph| g.diagnose().into_iter().map(|d| d.code).collect::<Vec<_>>();
    let find = |g: &JjrGraph, code: DiagnosticCode| -> GraphDiagnostic {
        g.diagnose()
            .into_iter()
            .find(|d| d.code == code)
            .unwrap_or_else(|| panic!("no {code} diagnostic"))
    };
    let args = |d: GraphDiagnostic| d.suggested_args.unwrap_or_default();

    // Activation must be a tiny top-level switch.
    let act = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"])
            .intent(ChangeIntent::Activation)
            .description("enable new billing")
            .paths(&["a.js", "b.js", "c.js", "d.js"]),
        change("nnnnnnnn", &["mmmmmmmm"]).paths(&["billing.js", "billing.test.js"]),
    ]);
    assert_eq!(
        args(find(&act, DiagnosticCode::ActivationNotOnTop)),
        ["rebase", "-r", "mmmmmmmm", "-A", "nnnnnnnn"]
    );
    assert!(codes(&act).contains(&DiagnosticCode::ActivationNotIsolated));

    // A megamerge stays an empty composition node with an empty @ above it.
    let mega = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]),
        change("nnnnnnnn", &["kkkkkkkk"]),
        change("pppppppp", &["mmmmmmmm", "nnnnnnnn"])
            .description("local: dev megamerge")
            .working_copy()
            .intent(ChangeIntent::Megamerge)
            .paths(&["a.js"]),
    ]);
    assert_eq!(
        args(find(&mega, DiagnosticCode::MegamergeNotEmpty)),
        ["absorb", "--from", "pppppppp"]
    );
    assert_eq!(
        args(find(&mega, DiagnosticCode::MegamergeAsWorkingCopy)),
        ["new", "pppppppp"]
    );
    assert_eq!(mega.classify_shape(), DagShape::Megamerge);

    // Conflicts: resolve in a child, then fold the resolution down.
    let conflicted = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]).conflicted(),
    ]);
    assert_eq!(
        args(find(&conflicted, DiagnosticCode::ConflictedChange)),
        ["new", "mmmmmmmm"]
    );
    let resolved = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"]).conflicted(),
        change("nnnnnnnn", &["mmmmmmmm"]),
    ]);
    assert_eq!(
        args(find(&resolved, DiagnosticCode::ConflictedChange)),
        ["squash", "--from", "nnnnnnnn", "--into", "mmmmmmmm"]
    );

    // Bundled tests, bookmark tips, and roots that missed trunk().
    let g = JjrGraph::new(
        vec![
            change("jjjjjjjj", &[]).immutable().description("old trunk"),
            trunk_at("kkkkkkkk", &["jjjjjjjj"]),
            change("mmmmmmmm", &["jjjjjjjj"]).paths(&["src/pay.ts"]),
            change("nnnnnnnn", &["kkkkkkkk"])
                .paths(&["src/pay.ts", "src/pay.test.ts"])
                .working_copy()
                .bookmarks(&["feat/pay"]),
        ],
        JjrRepoConfig::default(),
        Some(preflight()),
    );
    assert_eq!(
        find(&g, DiagnosticCode::BehaviorWithoutTests).affected_changes,
        ["mmmmmmmm"]
    );
    assert_eq!(
        args(find(&g, DiagnosticCode::RootBehindTrunk)),
        ["rebase", "-s", "mmmmmmmm", "-o", "trunk()"]
    );
    assert_eq!(
        args(find(&g, DiagnosticCode::EditingBookmarkTip)),
        ["new", "nnnnnnnn"]
    );

    // A deep linear stack is usually a horizontal slicing.
    let ids = [
        "llllllll", "mmmmmmmm", "nnnnnnnn", "oooooooo", "pppppppp", "qqqqqqqq", "rrrrrrrr",
    ];
    let mut changes = vec![trunk()];
    for (i, id) in ids.iter().enumerate() {
        changes.push(change(id, &[if i == 0 { "kkkkkkkk" } else { ids[i - 1] }]));
    }
    let deep = graph(changes);
    assert_eq!(
        find(&deep, DiagnosticCode::DeepStack)
            .affected_changes
            .len(),
        7
    );
    let roomy = JjrGraph::new(
        deep.all().into_iter().cloned().collect(),
        JjrRepoConfig {
            max_stack_depth: 8,
            ..JjrRepoConfig::default()
        },
        None,
    );
    assert!(!codes(&roomy).contains(&DiagnosticCode::DeepStack));
}

#[test]
fn classify_shape_maps_the_mutable_zone_onto_the_canonical_dag_shapes() {
    let scratch = |parent: &str| {
        change("wwwwwwww", &[parent])
            .working_copy()
            .empty()
            .description("")
    };
    let summary = |changes: Vec<JjrChange>| {
        let mut all = vec![trunk()];
        all.extend(changes);
        graph(all).summary()
    };
    assert_eq!(summary(vec![scratch("kkkkkkkk")]).shape, DagShape::Resting);
    assert!(summary(vec![scratch("kkkkkkkk")]).resting);
    assert_eq!(
        summary(vec![change("mmmmmmmm", &["kkkkkkkk"]), scratch("mmmmmmmm")]).shape,
        DagShape::Single
    );
    assert_eq!(
        summary(vec![
            change("mmmmmmmm", &["kkkkkkkk"]),
            change("nnnnnnnn", &["mmmmmmmm"])
        ])
        .shape,
        DagShape::Stack
    );
    assert_eq!(
        summary(vec![
            change("mmmmmmmm", &["kkkkkkkk"]),
            change("nnnnnnnn", &["kkkkkkkk"])
        ])
        .shape,
        DagShape::Parallel
    );
    assert_eq!(
        summary(vec![
            change("mmmmmmmm", &["kkkkkkkk"]),
            change("nnnnnnnn", &["mmmmmmmm"]),
            change("oooooooo", &["mmmmmmmm"])
        ])
        .shape,
        DagShape::Branching
    );
    for shape in DagShape::ALL {
        assert!(!canonical_shape(shape).publishing.is_empty(), "{shape}");
    }
}
