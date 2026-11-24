//! The deterministic jjr eval scenarios (evals/scenarios.json), one test
//! each: real throwaway repositories with injected faults, exercised through
//! the engine, the guardrails, Jev's offline mode, the recipes and the runner.
//!
//! Port of evals/harness.mjs. Run them with `cargo test -p jj-graph --test evals`.

mod common;

use std::cell::RefCell;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use jj_graph::app::App;
use jj_graph::app::AppHost;
use jj_graph::app::AppOptions;
use jjr::graph::FromNodesOptions;
use jjr::graph::GraphNode;
use jjr::graph::JjrGraph;
use jjr::guardrails::GitInteropAction;
use jjr::guardrails::GuardrailAction;
use jjr::guardrails::JjrGuardrailPipeline;
use jjr::guardrails::MutateAction;
use jjr::jev::CandidateArm;
use jjr::jev::ChangeContext;
use jjr::jev::JjrJevAssistant;
use jjr::jev::RecoveryContext;
use jjr::narrator::JjrNarrator;
use jjr::patterns::JjrPatterns;
use jjr::patterns::RecoveryScope;
use jjr::patterns::RedTestOptions;
use jjr::patterns::TimeAxis;
use jjr::patterns::TimeTravelParams;
use jjr::patterns::plan_time_travel_recovery;
use jjr::runner::JjrRunner;
use jjr::types::JjrRepoConfig;
use serde_json::Value;
use serde_json::json;

use common::get;
use common::post;
use common::s;
use common::strings;

/// A throwaway colocated repository with an immutable `main` holding the
/// seed files. Without a remote, trunk() is root() and immutable_heads() is
/// `main`. With one, `main` is pushed to a bare `origin`, so trunk() is
/// main@origin exactly as after `jj git clone`.
struct EvalRepo {
    root: PathBuf,
    dir: PathBuf,
}

impl Drop for EvalRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn run(program: &str, args: &[&str], dir: &Path) -> String {
    let out = Command::new(program)
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("run {program}: {e}"));
    assert!(
        out.status.success(),
        "{program} {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

impl EvalRepo {
    fn new(seed: &[(&str, &str)], remote: bool) -> Self {
        let root = common::temp_dir("jjr-eval");
        let dir = if remote {
            root.join("local")
        } else {
            root.clone()
        };
        if remote {
            run(
                "git",
                &[
                    "init",
                    "--bare",
                    "--initial-branch=main",
                    root.join("origin.git").to_str().unwrap(),
                ],
                &root,
            );
            std::fs::create_dir_all(&dir).unwrap();
        }
        let repo = Self { root, dir };
        repo.jj(&["git", "init", "--colocate"]);
        repo.jj(&["config", "set", "--repo", "user.name", "jjr Eval"]);
        repo.jj(&["config", "set", "--repo", "user.email", "eval@jjr.local"]);
        for (file, text) in seed {
            repo.write(file, text);
        }
        repo.jj(&["commit", "-m", "seed trunk"]);
        repo.jj(&["bookmark", "create", "main", "-r", "@-"]);
        if remote {
            let origin = repo.root.join("origin.git");
            repo.jj(&["git", "remote", "add", "origin", origin.to_str().unwrap()]);
            repo.jj(&["git", "push", "--bookmark", "main"]);
        } else {
            repo.jj(&[
                "config",
                "set",
                "--repo",
                "revset-aliases.\"immutable_heads()\"",
                "main",
            ]);
        }
        repo
    }

    fn plain() -> Self {
        Self::new(&[("README.md", "# seed\n")], false)
    }

    fn jj(&self, args: &[&str]) -> String {
        let mut full = vec!["--color", "never", "--no-pager"];
        full.extend_from_slice(args);
        run("jj", &full, &self.dir)
    }

    /// A jj command that may fail: whether it succeeded, and what it printed.
    fn try_jj(&self, args: &[&str]) -> (bool, String) {
        let out = Command::new("jj")
            .args(["--color", "never", "--no-pager"])
            .args(args)
            .current_dir(&self.dir)
            .output()
            .unwrap_or_else(|e| panic!("run jj: {e}"));
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        (out.status.success(), text)
    }

    fn id(&self, rev: &str, field: &str) -> String {
        self.jj(&["log", "--no-graph", "-r", rev, "-T", field])
            .trim()
            .to_owned()
    }

    fn change(&self, rev: &str) -> String {
        self.id(rev, "change_id")
    }

    fn write(&self, file: &str, text: &str) {
        let path = self.dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn app(&self, verify_command: Option<&str>) -> App {
        let jev = JjrJevAssistant::offline();
        App::new(
            &self.dir,
            AppOptions {
                verify_command: verify_command.map(ToOwned::to_owned),
                jev: Some(jev.clone()),
                narrator: Some(JjrNarrator::new(None, jev)),
                ..Default::default()
            },
        )
    }
}

fn runner() -> JjrRunner {
    let jev = JjrJevAssistant::offline();
    JjrRunner::new(
        JjrGuardrailPipeline::new(),
        jev.clone(),
        JjrNarrator::new(None, jev),
    )
}

fn state(app: &RefCell<App>) -> Value {
    common::get_state(&mut app.borrow_mut(), "all()")
}

fn dry(app: &RefCell<App>, args: &[&str]) -> Result<Value, String> {
    post(&mut app.borrow_mut(), "/api/dry", json!({ "args": args }))
}

fn by_desc<'a>(state: &'a Value, prefix: &str) -> &'a Value {
    common::node(state, prefix)
}

fn by_change<'a>(state: &'a Value, change: &str) -> &'a Value {
    state["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["change"] == change)
        .unwrap_or_else(|| panic!("no change {change}"))
}

fn codes(state: &Value) -> Vec<String> {
    state["jjr"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| s(&d["code"]).to_owned())
        .collect()
}

fn graph_of(state: &Value) -> JjrGraph {
    let nodes: Vec<GraphNode> = serde_json::from_value(state["nodes"].clone()).unwrap();
    JjrGraph::from_nodes(&nodes, FromNodesOptions::default())
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

#[test]
fn topo_01_flatten_an_accidental_linear_chain_with_the_dependency_test_and_parallelize() {
    let repo = EvalRepo::plain();
    repo.write("auth.js", "export const logAuth = () => true;\n");
    repo.jj(&["commit", "-m", "feat: add auth logging"]);
    repo.write("theme.css", ":root { --dark: 1; }\n");
    repo.jj(&["commit", "-m", "feat: add dark mode css"]);

    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    let auth = s(&by_desc(&s0, "feat: add auth logging")["change"]).to_owned();
    let css = s(&by_desc(&s0, "feat: add dark mode css")["change"]).to_owned();

    let dep = post(
        &mut app.borrow_mut(),
        "/api/jjr/dependency",
        json!({ "base": auth, "child": css }),
    )
    .unwrap();
    assert_eq!(dep["verdict"]["outcome"], "parallelize");
    let args = strings(&dep["verdict"]["suggestedArgs"]);
    assert!(!args.is_empty());

    let dry = runner()
        .dry_run(&AppHost(&app), &args, None, false)
        .unwrap();
    assert!(!dry.blocked);
    let graph = graph_of(&dry.state);
    assert_eq!(
        graph.get(&auth).unwrap().parents,
        graph.get(&css).unwrap().parents,
        "both arms share the same trunk parent"
    );
}

#[test]
fn topo_02_collapse_a_mutually_entangled_helper_rename_and_its_sole_caller() {
    let res = JjrJevAssistant::offline().assess_dependency(
        &ChangeContext {
            change_id: "kkkkkkkk".into(),
            description: "wip: rename helper without caller update".into(),
            touched_paths: vec!["src/util.js".into()],
            diff_excerpt: "-function oldHelper()\n+function newHelper()".into(),
        },
        &ChangeContext {
            change_id: "mmmmmmmm".into(),
            description: "update caller for newHelper".into(),
            touched_paths: vec!["src/util.js".into()],
            diff_excerpt: "-oldHelper()\n+newHelper()".into(),
        },
    );
    assert_eq!(res.verdict.outcome.as_str(), "collapse");
    assert!(
        res.verdict
            .suggested_command
            .as_deref()
            .unwrap()
            .contains("jj squash")
    );
}

#[test]
fn guard_01_megamerge_fence_hard_blocks_pushing_a_local_octopus_megamerge() {
    let repo = EvalRepo::plain();
    repo.write("arm1.js", "export const a = 1;\n");
    repo.jj(&["commit", "-m", "feat: arm 1"]);
    repo.jj(&["new", "main", "-m", "feat: arm 2"]);
    repo.write("arm2.js", "export const b = 2;\n");
    repo.jj(&["commit", "-m", "feat: arm 2"]);
    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    let arm1 = s(&by_desc(&s0, "feat: arm 1")["change"]).to_owned();
    let arm2 = s(&by_desc(&s0, "feat: arm 2")["change"]).to_owned();
    repo.jj(&["new", &arm1, &arm2, "-m", "local: dev megamerge"]);

    let s1 = state(&app);
    let mega = s(&by_desc(&s1, "local: dev megamerge")["change"]).to_owned();
    let guard = post(
        &mut app.borrow_mut(),
        "/api/jjr/guard",
        json!({ "action": { "type": "push", "targetChanges": [mega] }, "useJev": true }),
    )
    .unwrap();
    assert_eq!(guard["allowed"], false);
    assert!(
        guard["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["ruleName"] == "MegamergeFence")
    );
}

#[test]
fn guard_02_immutable_bedrock_guard_blocks_mutating_an_immutable_revision_in_a_dry_run() {
    let repo = EvalRepo::plain();
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "revset-aliases.\"immutable_heads()\"",
        "main",
    ]);
    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    let base = by_desc(&s0, "seed trunk");
    assert_eq!(base["immutable"], true);
    let err = dry(
        &app,
        &["describe", s(&base["change"]), "-m", "illegal rewrite"],
    )
    .unwrap_err();
    assert!(err.contains("ImmutableBedrockGuard"), "{err}");
}

#[test]
fn guard_03_colocated_git_guard_blocks_git_checkout_in_a_colocated_repository() {
    let graph = JjrGraph::new(
        Vec::new(),
        JjrRepoConfig {
            colocated: true,
            ..Default::default()
        },
        None,
    );
    let pipeline = JjrGuardrailPipeline::new();
    let git = |cmd: &str| {
        pipeline.evaluate(
            &graph,
            &GuardrailAction::GitInterop(GitInteropAction {
                raw_git_command: cmd.into(),
            }),
        )
    };
    let res = git("git checkout main");
    assert!(!res.allowed);
    assert_eq!(res.blockers[0].rule_name, "ColocatedGitGuard");
    // git is read-only: inspection passes, every other write is refused.
    assert!(git("git log --oneline").allowed);
    for cmd in [
        "git fetch",
        "git tag -a v1 -m v1",
        "git stash",
        "git submodule update",
    ] {
        assert!(!git(cmd).allowed, "{cmd}");
    }
}

#[test]
fn guard_04_divergence_guard_halts_stacking_and_keeps_recovery_open() {
    let repo = EvalRepo::plain();
    repo.write("a.js", "export const a = 1;\n");
    repo.jj(&["describe", "-m", "feat: arm a"]);
    let a = repo.change("@");
    repo.jj(&["new", "main"]);
    // Rewrite the change twice from the same operation: two visible commits, one change id.
    let before = repo
        .jj(&[
            "op",
            "log",
            "--no-graph",
            "-n",
            "1",
            "-T",
            "id",
            "--ignore-working-copy",
        ])
        .trim()
        .to_owned();
    repo.jj(&["describe", &a, "-m", "feat: arm a (one)"]);
    repo.jj(&[
        "--at-op",
        &before,
        "describe",
        &a,
        "-m",
        "feat: arm a (two)",
    ]);

    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    let divergent: Vec<Value> = s0["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["divergent"] == true)
        .cloned()
        .collect();
    assert_eq!(
        divergent.len(),
        2,
        "two visible commits share one change id"
    );
    assert!(codes(&s0).contains(&"DIVERGENT_CHANGE".to_owned()));

    // Stacking new work is halted, even though `jj new` rewrites nothing.
    let err = dry(&app, &["new", s(&divergent[0]["id"]), "-m", "more work"]).unwrap_err();
    assert!(err.contains("DivergenceGuard"), "{err}");

    // Recovery stays open: converge passes the guard, abandon restores 1:1 cardinality.
    let graph = graph_of(&s0);
    let converge = GuardrailAction::Mutate(MutateAction {
        args: Some(owned(&["converge", "--no-interactive"])),
        ..Default::default()
    });
    assert!(
        JjrGuardrailPipeline::new()
            .evaluate(&graph, &converge)
            .allowed
    );
    let drop = divergent
        .iter()
        .find(|n| s(&n["description"]).starts_with("feat: arm a (two)"))
        .unwrap();
    let r = dry(&app, &["abandon", s(&drop["id"])]).unwrap();
    assert_eq!(r["result"]["changed"], true);
    assert_eq!(
        r["state"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["divergent"] == true)
            .count(),
        0,
        "finalDivergentCount === 0"
    );
    by_desc(&r["state"], "feat: arm a (one)");
}

#[test]
fn guard_05_never_force_rewrite_immutable_history() {
    let repo = EvalRepo::plain();
    repo.write("fix.js", "export const fix = 1;\n");
    repo.jj(&["describe", "-m", "fix: patch"]);
    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    let base = s(&by_desc(&s0, "seed trunk")["change"]).to_owned();
    let err = dry(
        &app,
        &["describe", "--ignore-immutable", &base, "-m", "rewrite"],
    )
    .unwrap_err();
    assert!(err.contains("--ignore-immutable"), "{err}");
    // `--into` is a destination jj rewrites, not a read-only parent.
    let err = dry(&app, &["squash", "--into", &base]).unwrap_err();
    assert!(err.contains("ImmutableBedrockGuard"), "{err}");
    // A guarded runner refuses the flag before it reaches jj.
    let args = owned(&["--ignore-immutable", "abandon", &base]);
    let planned = runner().plan_mutation(&graph_of(&s0), &[], "jj abandon", Some(&args));
    assert!(planned.blocked);
    assert_eq!(
        planned.guard_result.blockers[0].rule_name,
        "ImmutableBedrockGuard"
    );
}

#[test]
fn sdlc_01_tidy_first_detects_structural_above_behavioral_and_dry_runs_the_slip_below() {
    let repo = EvalRepo::plain();
    repo.write("feat.js", "export const feature = 1;\n");
    repo.jj(&["commit", "-m", "feat: add billing feature"]);
    repo.write("clean.js", "export const clean = 1;\n");
    repo.jj(&["commit", "-m", "refactor: extract billing helper"]);

    let app = RefCell::new(repo.app(None));
    let diag = get(
        &mut app.borrow_mut(),
        "/api/jjr/diagnose",
        &[("revset", "all()")],
    )
    .unwrap();
    let issue = diag["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["code"] == "UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL")
        .expect("should flag structural commit above behavioral commit")
        .clone();

    let fixed = runner()
        .dry_run(
            &AppHost(&app),
            &strings(&issue["suggestedArgs"]),
            None,
            false,
        )
        .unwrap();
    assert!(!fixed.blocked);
    let after = graph_of(&fixed.state).diagnose();
    assert!(
        !after
            .iter()
            .any(|d| d.code.as_str() == "UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL"),
        "ordering warning resolved in dry-run preview"
    );
}

#[test]
fn sdlc_02_tdd_red_test_reruns_the_recorded_red_and_probes_without_rewriting() {
    let repo = EvalRepo::plain();
    repo.jj(&["describe", "-m", "feat: answer with its test"]);
    // Red first: the test alone, which the next jj command snapshots as a
    // commit of the change. Then green.
    repo.write("test/answer.sh", "grep -q \"answer = 42\" answer.js\n");
    repo.jj(&["util", "snapshot"]);
    repo.write("answer.js", "export const answer = 42;\n");
    repo.jj(&["util", "snapshot"]);
    let change = repo.change("@");
    let green = repo.id("@", "commit_id");
    let red_snapshot = format!("{change}/1");
    let recipe = JjrPatterns::verify_red_test(
        &owned(&["answer.js"]),
        &RedTestOptions {
            change_id: Some(change.clone()),
            red_snapshot: Some(red_snapshot.clone()),
            test_command: Some("sh test/answer.sh".into()),
        },
    );
    let (rerun, open, take, run_tests, discard) = (
        &recipe.steps[1],
        &recipe.steps[2],
        &recipe.steps[3],
        &recipe.steps[4],
        &recipe.steps[5],
    );
    assert!(
        !rerun.dry_runnable && !run_tests.dry_runnable,
        "running tests is not a repository operation"
    );

    // The red recorded in the evolog fails again, and nothing is rewritten.
    let (passed, output) = repo.try_jj(&[
        "run",
        "--ignore-changes",
        "-r",
        &red_snapshot,
        "--",
        "sh",
        "test/answer.sh",
    ]);
    assert!(!passed, "the recorded red is still red: {output}");
    assert_eq!(
        repo.id("@", "commit_id"),
        green,
        "re-running the red rewrote nothing"
    );

    // The probe keeps the tests and takes the implementation away.
    let app = RefCell::new(repo.app(Some("sh test/answer.sh")));
    let r = runner();
    for step in [open, take] {
        let previewed = r
            .dry_run(&AppHost(&app), step.args.as_ref().unwrap(), None, false)
            .unwrap();
        assert!(!previewed.blocked, "{} is allowed", step.command);
    }
    let probe = post(
        &mut app.borrow_mut(),
        "/api/jjr/verify",
        json!({ "range": "@" }),
    )
    .unwrap();
    assert_eq!(probe["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        probe["results"][0]["state"], "red",
        "the tests fail without the implementation"
    );

    let done = r
        .dry_run(&AppHost(&app), discard.args.as_ref().unwrap(), None, false)
        .unwrap();
    let work: Vec<&Value> = done.state["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| {
            n["immutable"] != true
                && !(n["empty"] == true && s(&n["description"]).trim().is_empty())
        })
        .collect();
    assert_eq!(work.len(), 1, "finalMutableCount === 1: the probe is gone");
    assert_eq!(s(&work[0]["change"]), change, "the change id survived");
    assert_eq!(s(&work[0]["id"]), green, "the change was never rewritten");

    // Green: the change itself passes.
    let verified = post(
        &mut app.borrow_mut(),
        "/api/jjr/verify",
        json!({ "range": change }),
    )
    .unwrap();
    assert_eq!(
        verified["results"][0]["state"], "green",
        "allCommitsPassTests === true ({})",
        verified["results"][0]["output"]
    );
}

#[test]
fn sdlc_03_branch_by_abstraction_previews_five_clean_steps() {
    let repo = EvalRepo::plain();
    let app = RefCell::new(repo.app(None));
    let mut recipe = JjrPatterns::branch_by_abstraction("payments");
    // Replace trunk() with main for a throwaway repository without a remote.
    for step in &mut recipe.steps {
        if let Some(args) = &mut step.args {
            for a in args.iter_mut() {
                if a == "trunk()" {
                    *a = "main".into();
                }
            }
        }
    }
    let outcomes = runner()
        .preview_pattern(&AppHost(&app), &recipe, None, false)
        .unwrap();
    assert_eq!(outcomes.len(), 5);
    assert!(
        outcomes
            .iter()
            .all(|o| !o.skipped && !o.outcome.as_ref().is_some_and(|d| d.blocked)),
        "{outcomes:#?}"
    );
}

#[test]
fn sdlc_04_megamerge_fixups_route_to_their_arms_and_jev_ranks_ambiguous_hunks() {
    let repo = EvalRepo::plain();
    repo.write("auth.js", "export const session = \"cookie\";\n");
    repo.jj(&["describe", "-m", "feat: auth sessions"]);
    let auth = repo.change("@");
    repo.jj(&["new", "main", "-m", "feat: billing invoices"]);
    repo.write("billing.js", "export const invoice = \"pdf\";\n");
    let billing = repo.change("@");
    repo.jj(&["new", &auth, &billing, "-m", "local: dev megamerge"]);
    // Integration testing reveals a fix, made in the megamerge itself.
    repo.write("auth.js", "export const session = \"signed-cookie\";\n");
    let mega = repo.change("@");

    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    assert_eq!(s0["jjr"]["summary"]["shape"], "megamerge");
    let polluted = s0["jjr"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["code"] == "MEGAMERGE_NOT_EMPTY")
        .expect("the megamerge carries edits that can never be pushed")
        .clone();
    assert!(codes(&s0).contains(&"MEGAMERGE_AS_WORKING_COPY".to_owned()));

    let routed = runner()
        .dry_run(
            &AppHost(&app),
            &strings(&polluted["suggestedArgs"]),
            None,
            false,
        )
        .unwrap();
    assert!(!routed.blocked);
    assert_eq!(
        by_change(&routed.state, &mega)["empty"],
        true,
        "megamergeUnpolluted === true"
    );
    let auth_commit = s(&by_change(&routed.state, &auth)["id"]).to_owned();
    let shown = get(
        &mut app.borrow_mut(),
        "/api/show",
        &[("rev", &auth_commit), ("mode", "diff")],
    )
    .unwrap();
    assert!(
        s(&shown["text"]).contains("signed-cookie"),
        "the fix landed in the auth arm"
    );

    // A hunk absorb cannot attribute (a new file) is ranked by Jev's router instead.
    let ranked = JjrJevAssistant::offline().route_hunk(
        "diff --git a/billing/pdf-fonts.js\n+export const invoiceFont = \"mono\";",
        &[
            CandidateArm {
                change_id: auth.clone(),
                description: "feat: auth sessions".into(),
                touched_paths: vec!["auth.js".into()],
            },
            CandidateArm {
                change_id: billing.clone(),
                description: "feat: billing invoices".into(),
                touched_paths: vec!["billing.js".into()],
            },
        ],
    );
    assert_eq!(ranked.decision.unwrap().choice, billing);
}

#[test]
fn time_01_jev_recommends_surgical_evolog_recovery_when_sibling_arms_changed() {
    let rec = JjrJevAssistant::offline().recommend_recovery(&RecoveryContext {
        symptom: Some("Change A broke after bad refactor".into()),
        target_change_id: Some("kkkkkkkk".into()),
        sibling_arms_modified_since: Some(true),
        bookmark_or_topology_corrupted: Some(false),
    });
    assert_eq!(rec.decision.choice, "evolog");
    let plan = plan_time_travel_recovery(&TimeTravelParams {
        scope: RecoveryScope::SingleChange,
        target_op_id: None,
        target_change_id: Some("kkkkkkkk".into()),
        target_evolog_commit: Some("a1b2c3d4e5f60718".into()),
        target_evolog_offset: None,
    })
    .unwrap();
    assert_eq!(plan.axis, TimeAxis::Evolog);
    assert_eq!(plan.command, "jj restore --from a1b2c3d4 --to kkkkkkkk");
    // An earlier version can also be named by offset.
    let by_offset = plan_time_travel_recovery(&TimeTravelParams {
        scope: RecoveryScope::SingleChange,
        target_op_id: None,
        target_change_id: Some("kkkkkkkk".into()),
        target_evolog_commit: None,
        target_evolog_offset: Some(1),
    })
    .unwrap();
    assert_eq!(
        by_offset.command,
        "jj restore --from kkkkkkkk/1 --to kkkkkkkk"
    );
}

#[test]
fn conv_01_post_merge_convergence_fetches_a_landed_arm_and_rebases_the_rest_onto_trunk() {
    let repo = EvalRepo::new(&[("README.md", "# seed\n")], true);
    repo.write("one.js", "export const one = 1;\n");
    repo.jj(&["describe", "-m", "feat: arm 1"]);
    let arm1 = repo.id("@", "commit_id");
    repo.jj(&["new", "main", "-m", "feat: arm 2"]);
    repo.write("two.js", "export const two = 2;\n");
    let arm2 = repo.change("@");
    repo.jj(&["new"]);
    // Arm 1 lands upstream (a fast-forward of origin's main), then we fetch.
    let origin = repo.root.join("origin.git");
    let local_git = repo.dir.join(".git");
    run(
        "git",
        &[
            "--git-dir",
            origin.to_str().unwrap(),
            "fetch",
            local_git.to_str().unwrap(),
            &format!("{arm1}:refs/heads/main"),
        ],
        &repo.root,
    );
    repo.jj(&["git", "fetch"]);

    let app = RefCell::new(repo.app(None));
    let s0 = state(&app);
    assert_eq!(
        s0["jjr"]["preflight"]["trunk"]["commitId"], arm1,
        "trunk() follows main@origin"
    );
    assert_eq!(
        by_desc(&s0, "feat: arm 1")["immutable"],
        true,
        "arm1InImmutable === true"
    );
    assert!(
        s0["jjr"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "ROOT_BEHIND_TRUNK"
                && strings(&d["affectedChanges"]).contains(&arm2))
    );

    let outcomes = runner()
        .preview_pattern(
            &AppHost(&app),
            &JjrPatterns::post_merge_convergence(false),
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        outcomes.iter().map(|o| o.skipped).collect::<Vec<_>>(),
        [true, false, true]
    );
    let after = &outcomes[1].outcome.as_ref().unwrap().state;
    assert_eq!(
        strings(&by_change(after, &arm2)["parents"]),
        [arm1],
        "arm2RebasedOnTrunk === true"
    );
    assert!(!codes(after).contains(&"ROOT_BEHIND_TRUNK".to_owned()));
    assert_eq!(after["jjr"]["summary"]["shape"], "single");
}

#[test]
fn pre_01_an_unresolvable_trunk_blocks_rewrites_and_trunk_history_stays_bedrock() {
    let repo = EvalRepo::plain();
    repo.write("work.js", "export const work = 1;\n");
    repo.jj(&["describe", "-m", "feat: work"]);
    let app = RefCell::new(repo.app(None));

    // trunk() points at a bookmark that no longer exists.
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "revset-aliases.\"trunk()\"",
        "present(gone)",
    ]);
    let s0 = state(&app);
    assert_eq!(s0["jjr"]["preflight"]["trunk"]["resolved"], false);
    assert!(codes(&s0).contains(&"PREFLIGHT_UNRESOLVED".to_owned()));
    let err = dry(&app, &["new", "-m", "more"]).unwrap_err();
    assert!(err.contains("PreflightGuard"), "{err}");

    // trunk() resolves, but immutable_heads() was overridden without it.
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "revset-aliases.\"trunk()\"",
        "main",
    ]);
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "revset-aliases.\"immutable_heads()\"",
        "none()",
    ]);
    repo.write("work.js", "export const work = 2;\n"); // a new operation, so a fresh pre-flight
    let s1 = state(&app);
    let seed = by_desc(&s1, "seed trunk").clone();
    assert_eq!(
        seed["immutable"], false,
        "jj itself would let this rewrite through"
    );
    assert!(codes(&s1).contains(&"PREFLIGHT_TRUNK_NOT_IMMUTABLE".to_owned()));
    let err = dry(
        &app,
        &[
            "describe",
            s(&seed["change"]),
            "-m",
            "rewrite shared history",
        ],
    )
    .unwrap_err();
    assert!(err.contains("ImmutableBedrockGuard"), "{err}");
    let ok = dry(&app, &["describe", "-m", "feat: work, described"]).unwrap();
    assert_eq!(
        ok["result"]["changed"], true,
        "work above trunk() stays mutable"
    );
}

#[test]
fn pub_01_verify_the_stack_publish_green_bottom_layers_and_keep_the_rest_local() {
    let repo = EvalRepo::new(
        &[
            ("README.md", "# seed\n"),
            ("check.sh", "test ! -e broken.txt\n"),
        ],
        false,
    );
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "fix.tools.trim.command",
        "[\"sed\", \"-e\", \"s/[[:space:]]*$//\"]",
    ]);
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "fix.tools.trim.patterns",
        "[\"glob:**/*.txt\"]",
    ]);
    repo.write("a.txt", "layer a\n");
    repo.jj(&["commit", "-m", "feat: layer a"]);
    repo.write("broken.txt", "layer b breaks the build\n");
    repo.jj(&["commit", "-m", "feat: layer b"]);
    repo.write("c.txt", "layer c   \n");
    repo.jj(&["commit", "-m", "feat: layer c"]);

    let app = RefCell::new(repo.app(Some("sh check.sh")));
    let s0 = state(&app);
    let [a, b, c] = ["feat: layer a", "feat: layer b", "feat: layer c"]
        .map(|d| s(&by_desc(&s0, d)["change"]).to_owned());

    // Nothing is known before verification, so a push is refused.
    let unverified = post(
        &mut app.borrow_mut(),
        "/api/jjr/publish-plan",
        json!({ "rev": a }),
    )
    .unwrap();
    assert_eq!(unverified["layers"][0]["publishable"], false);

    let v = post(
        &mut app.borrow_mut(),
        "/api/jjr/verify",
        json!({ "range": "trunk()..@" }),
    )
    .unwrap();
    let result = |change: &str| {
        v["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["changeId"] == change)
            .unwrap()
            .clone()
    };
    assert_eq!(result(&a)["state"], "green", "{v:#}");
    assert_eq!(result(&b)["state"], "red");
    assert_eq!(
        result(&c)["formatted"],
        false,
        "jj fix found trailing whitespace in layer c"
    );
    assert_eq!(strings(&result(&c)["unformattedFiles"]), ["c.txt"]);

    let plan = post(
        &mut app.borrow_mut(),
        "/api/jjr/publish-plan",
        json!({ "rev": c }),
    )
    .unwrap();
    assert_eq!(
        strings(&plan["publish"]),
        std::slice::from_ref(&a),
        "only the green bottom layer publishes"
    );
    assert_eq!(strings(&plan["keepLocal"]), [b.clone(), c.clone()]);
    assert_eq!(
        strings(&plan["commands"]),
        [format!("jj git push -c {}", &a[..8])]
    );

    // Bookmarks are export pointers: the gate applies to them too.
    let err = dry(&app, &["bookmark", "set", "feat-b", "-r", &b]).unwrap_err();
    assert!(err.contains("PublishingGate"), "{err}");
    let ok = dry(&app, &["bookmark", "set", "feat-a", "-r", &a]).unwrap();
    assert_eq!(ok["result"]["changed"], true);
    assert_eq!(ok["result"]["warnings"], json!([]));
}
