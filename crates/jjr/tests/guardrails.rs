//! The guardrail tests of `test/jjr.test.mjs` and `test/reference.test.mjs`,
//! plus the Jev pass of `JjrGuardrailPipeline::evaluate_with_jev`.

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use jjr::JjrGraph;
use jjr::JjrGuardrailPipeline;
use jjr::JjrJevAssistant;
use jjr::commands::describe_mutation;
use jjr::graph::DiagnosticCode;
use jjr::graph::JjrChange;
use jjr::graph::PreflightFacts;
use jjr::guardrails::DecisionSeverity;
use jjr::guardrails::GuardrailAction;
use jjr::guardrails::GuardrailResult;
use jjr::guardrails::is_read_only_git_command;
use jjr::types::JjrRepoConfig;
use jjr::types::VerificationState;
use jjr::types::VerificationStatus;
use jjr::types::verification_state;
use serde_json::Value;
use serde_json::json;

const ROOT: &str = "0000000000000000000000000000000000000000";

fn green() -> Value {
    json!({ "formatted": true, "builds": true, "testsPass": true, "verified": true })
}

fn unknown() -> Value {
    json!({ "formatted": null, "builds": null, "testsPass": null, "verified": false })
}

static COMMIT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// A change for an in-memory graph: the reference tests' `change()` helper.
/// `extra` may set `description`, `paths`, `empty`, `conflict` and
/// `commitId`, and overrides any other field of the change.
fn change(change_id: &str, parents: &[&str], extra: Value) -> JjrChange {
    let seq = COMMIT_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let mut rest = extra.as_object().cloned().unwrap_or_default();
    let description = rest
        .remove("description")
        .unwrap_or_else(|| json!(change_id));
    let paths = rest.remove("paths").unwrap_or_else(|| json!([]));
    let empty = rest.remove("empty").unwrap_or(json!(false));
    let conflict = rest.remove("conflict").is_some_and(|c| c == true);
    let commit_id = rest
        .remove("commitId")
        .unwrap_or_else(|| json!(format!("{:0<40}", format!("{:a>8}", format!("{seq:x}")))));
    let files_count = paths.as_array().map_or(0, Vec::len);
    let mut c = json!({
        "changeId": change_id,
        "currentCommit": {
            "commitId": commit_id,
            "changeId": change_id,
            "parentCommits": [],
            "isEmpty": empty,
            "conflict": if conflict { json!({ "isConflicted": true, "conflictedPaths": [] }) } else { json!({ "isConflicted": false }) },
            "author": "t",
            "timestamp": "",
            "touchedPaths": paths,
            "filesCount": files_count,
            "description": description,
        },
        "zone": "mutable",
        "parents": parents,
        "children": [],
        "bookmarks": [],
        "isWorkingCopy": false,
        "intent": "behavioral",
        "verification": green(),
        "isDivergent": false,
    });
    for (k, v) in rest {
        c[k.as_str()] = v;
    }
    serde_json::from_value(c).expect("a valid change")
}

fn trunk() -> JjrChange {
    change(
        "kkkkkkkk",
        &[],
        json!({ "zone": "immutable", "bookmarks": ["main"], "description": "trunk" }),
    )
}

/// Pre-flight facts of a repository whose trunk() is `kkkkkkkk`, with `over` merged in.
fn preflight(over: Value) -> PreflightFacts {
    let mut p = json!({
        "trunk": { "resolved": true, "changeId": "kkkkkkkk", "commitId": "f".repeat(40), "immutable": true, "isRoot": false },
        "immutableHeads": { "resolved": true, "heads": [{ "changeId": "kkkkkkkk", "commitId": "f".repeat(40), "immutable": true }] },
        "divergent": [],
        "remotes": ["origin"],
        "gitCompat": [],
    });
    for (k, v) in over.as_object().cloned().unwrap_or_default() {
        p[k.as_str()] = v;
    }
    serde_json::from_value(p).expect("valid pre-flight facts")
}

fn graph(changes: Vec<JjrChange>) -> JjrGraph {
    JjrGraph::new(changes, JjrRepoConfig::default(), None)
}

fn graph_with(changes: Vec<JjrChange>, facts: PreflightFacts) -> JjrGraph {
    JjrGraph::new(changes, JjrRepoConfig::default(), Some(facts))
}

fn colocated(colocated: bool) -> JjrRepoConfig {
    JjrRepoConfig {
        colocated,
        ..JjrRepoConfig::default()
    }
}

/// An action in the JSON shape the JS API and the HTTP server use.
fn action(v: Value) -> GuardrailAction {
    serde_json::from_value(v).expect("a valid action")
}

fn first_blocker(r: &GuardrailResult) -> Option<&str> {
    r.blockers.first().map(|d| d.rule_name.as_str())
}

fn first_warning(r: &GuardrailResult) -> Option<&str> {
    r.warnings.first().map(|d| d.rule_name.as_str())
}

#[test]
fn pipeline_enforces_all_6_deterministic_rules_and_permits_divergence_recovery() {
    let changes: Vec<JjrChange> = serde_json::from_value(json!([
        {
            "changeId": "kkkkkkkk",
            "currentCommit": { "commitId": "11111111", "changeId": "kkkkkkkk", "parentCommits": [], "isEmpty": false, "conflict": { "isConflicted": false }, "author": "t", "timestamp": "", "touchedPaths": [], "description": "main" },
            "zone": "immutable",
            "parents": [],
            "children": ["mmmmmmmm", "nnnnnnnn"],
            "bookmarks": ["main"],
            "isWorkingCopy": false,
            "intent": "behavioral",
            "verification": { "formatted": true, "builds": true, "testsPass": true },
            "isDivergent": false,
        },
        {
            "changeId": "mmmmmmmm",
            "currentCommit": { "commitId": "22222222", "changeId": "mmmmmmmm", "parentCommits": ["11111111"], "isEmpty": false, "conflict": { "isConflicted": false }, "author": "t", "timestamp": "", "touchedPaths": ["a.js"], "description": "feat: arm A" },
            "zone": "mutable",
            "parents": ["kkkkkkkk"],
            "children": ["pppppppp"],
            "bookmarks": [],
            "isWorkingCopy": false,
            "intent": "behavioral",
            "verification": { "formatted": true, "builds": true, "testsPass": true },
            "isDivergent": false,
        },
        {
            "changeId": "nnnnnnnn",
            "currentCommit": { "commitId": "33333333", "changeId": "nnnnnnnn", "parentCommits": ["11111111"], "isEmpty": false, "conflict": { "isConflicted": true, "conflictedPaths": ["b.js"] }, "author": "t", "timestamp": "", "touchedPaths": ["b.js"], "description": "feat: arm B" },
            "zone": "mutable",
            "parents": ["kkkkkkkk"],
            "children": ["pppppppp"],
            "bookmarks": [],
            "isWorkingCopy": false,
            "intent": "behavioral",
            "verification": { "formatted": true, "builds": false, "testsPass": false },
            "isDivergent": false,
        },
        {
            "changeId": "pppppppp",
            "currentCommit": { "commitId": "44444444", "changeId": "pppppppp", "parentCommits": ["22222222", "33333333"], "isEmpty": true, "conflict": { "isConflicted": false }, "author": "t", "timestamp": "", "touchedPaths": [], "description": "local: dev megamerge" },
            "zone": "mutable",
            "parents": ["mmmmmmmm", "nnnnnnnn"],
            "children": [],
            "bookmarks": ["oops-mega"],
            "isWorkingCopy": true,
            "intent": "megamerge",
            "verification": { "formatted": true, "builds": true, "testsPass": true },
            "isDivergent": false,
        },
    ]))
    .unwrap();
    let graph = JjrGraph::new(changes, colocated(true), None);

    let pipeline = JjrGuardrailPipeline::new();
    let eval = |a: Value| pipeline.evaluate(&graph, &action(a));
    assert_eq!(
        first_blocker(&eval(
            json!({ "type": "mutate", "targetChanges": ["kkkkkkkk"], "command": "jj describe kkkkkkkk" })
        )),
        Some("ImmutableBedrockGuard")
    );
    assert_eq!(
        first_blocker(&eval(
            json!({ "type": "push", "targetChanges": ["pppppppp"] })
        )),
        Some("MegamergeFence")
    );
    assert_eq!(
        first_blocker(&eval(
            json!({ "type": "push", "targetChanges": ["nnnnnnnn"] })
        )),
        Some("PublishingGate")
    );
    assert_eq!(
        first_blocker(&eval(
            json!({ "type": "git-interop", "rawGitCommand": "git checkout main" })
        )),
        Some("ColocatedGitGuard")
    );
    assert_eq!(
        first_blocker(&eval(
            json!({ "type": "workspace-add", "reason": "switch-branch" })
        )),
        Some("WorkspaceDisciplineGuard")
    );
    assert!(eval(json!({ "type": "push", "targetChanges": ["mmmmmmmm"] })).allowed);

    // Graph diagnostics should catch megamerge carrying a bookmark
    assert!(
        graph
            .diagnose()
            .iter()
            .any(|d| d.code == DiagnosticCode::MegamergeWithBookmark)
    );

    // DivergenceGuard blocks rebase but allows converge/abandon recovery
    let div_graph = JjrGraph::new(
        vec![
            serde_json::from_value(json!({
                "changeId": "zzzzzzzz",
                "currentCommit": { "commitId": "aaaaaaaa", "changeId": "zzzzzzzz", "parentCommits": [], "isEmpty": false, "conflict": { "isConflicted": false }, "author": "t", "timestamp": "", "touchedPaths": [], "description": "div 1" },
                "zone": "mutable", "parents": [], "children": [], "bookmarks": [], "isWorkingCopy": false, "intent": "behavioral",
                "verification": { "formatted": true, "builds": true, "testsPass": true }, "isDivergent": true,
            }))
            .unwrap(),
        ],
        JjrRepoConfig::default(),
        None,
    );
    let rebase = action(
        json!({ "type": "mutate", "targetChanges": ["zzzzzzzz"], "command": "jj rebase -s zzzzzzzz -o main" }),
    );
    assert!(!pipeline.evaluate(&div_graph, &rebase).allowed);
    let converge = action(
        json!({ "type": "mutate", "targetChanges": ["zzzzzzzz"], "command": "jj converge" }),
    );
    assert!(pipeline.evaluate(&div_graph, &converge).allowed);
}

#[test]
fn immutable_bedrock_guard_ignore_immutable_rewritten_destinations_and_trunk_when_immutable_heads_omits_it()
 {
    let pipeline = JjrGuardrailPipeline::new();
    let g = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"], json!({ "isWorkingCopy": true })),
    ]);
    let block = |args: &[&str]| {
        pipeline.evaluate(&g, &action(json!({ "type": "mutate", "args": args, "targetChanges": describe_mutation(args).rewrites })))
    };
    assert_eq!(
        first_blocker(&block(&["squash", "-r", "mmmmmmmm"])),
        Some("ImmutableBedrockGuard"),
        "squash -r rewrites the immutable parent"
    );
    assert_eq!(
        first_blocker(&block(&["new", "-B", "main"])),
        Some("ImmutableBedrockGuard")
    );
    assert!(
        block(&["new", "-A", "main"]).allowed,
        "only trunk's mutable children are rebased"
    );
    assert!(block(&["new", "main"]).allowed);
    assert_eq!(
        first_blocker(&block(&["describe", "--ignore-immutable", "mmmmmmmm"])),
        Some("ImmutableBedrockGuard")
    );

    // immutable_heads() was overridden without trunk(): trunk history is still bedrock.
    let misconfigured = graph_with(
        vec![
            change("kkkkkkkk", &[], json!({ "bookmarks": ["main"] })),
            change("mmmmmmmm", &["kkkkkkkk"], json!({ "isWorkingCopy": true })),
        ],
        preflight(
            json!({ "trunk": { "resolved": true, "changeId": "kkkkkkkk", "commitId": "f".repeat(40), "immutable": false, "isRoot": false } }),
        ),
    );
    let r = pipeline.evaluate(
        &misconfigured,
        &action(json!({ "type": "mutate", "args": ["describe", "main", "-m", "x"], "targetChanges": ["main"] })),
    );
    assert_eq!(first_blocker(&r), Some("ImmutableBedrockGuard"));
    assert!(r.warnings.iter().any(|w| w.rule_name == "PreflightGuard"));
    assert!(
        misconfigured
            .diagnose()
            .iter()
            .any(|d| d.code == DiagnosticCode::PreflightTrunkNotImmutable)
    );
    // Server-resolved targets carry the same facts.
    let resolved = action(json!({
        "type": "mutate",
        "command": "jj describe x",
        "targetChanges": [],
        "resolvedTargets": [{ "changeId": "qqqqqqqq", "inTrunk": true }],
    }));
    assert!(!pipeline.evaluate(&misconfigured, &resolved).allowed);
}

#[test]
fn preflight_guard_blocks_when_trunk_does_not_resolve_and_warns_when_shared_history_is_unprotected()
{
    let pipeline = JjrGuardrailPipeline::new();
    let act = action(json!({ "type": "mutate", "args": ["new"], "targetChanges": [] }));
    let unresolved = graph_with(
        vec![],
        preflight(
            json!({ "trunk": { "resolved": false, "error": "trunk() resolves to no revision" } }),
        ),
    );
    assert_eq!(
        first_blocker(&pipeline.evaluate(&unresolved, &act)),
        Some("PreflightGuard")
    );
    assert_eq!(
        unresolved.diagnose()[0].code,
        DiagnosticCode::PreflightUnresolved
    );

    // (Rust's pre-flight rows always say whether they are immutable.)
    let at_root = json!({ "resolved": true, "changeId": "z".repeat(32), "commitId": ROOT, "immutable": true, "isRoot": true });
    let no_bedrock = graph_with(
        vec![],
        preflight(json!({
            "trunk": at_root,
            "immutableHeads": { "resolved": true, "heads": [{ "changeId": "z".repeat(32), "commitId": ROOT, "immutable": true }] },
        })),
    );
    let r = pipeline.evaluate(&no_bedrock, &act);
    assert!(r.allowed);
    assert_eq!(first_warning(&r), Some("PreflightGuard"));
    assert!(
        no_bedrock
            .diagnose()
            .iter()
            .any(|d| d.code == DiagnosticCode::PreflightNoBedrock)
    );

    // No pre-flight context (an in-memory graph): nothing to check.
    assert!(pipeline.evaluate(&graph(vec![]), &act).allowed);

    // The JS test goes on to render this through the UI view models, which are not ported yet.
    let compat = graph_with(
        vec![],
        preflight(
            json!({ "gitCompat": [{ "kind": "lfs", "message": "LFS in use" }], "keepRefs": 9000 }),
        ),
    );
    let codes: Vec<DiagnosticCode> = compat
        .diagnose()
        .into_iter()
        .map(|d| d.code)
        .filter(|c| *c != DiagnosticCode::LossyMergeConfig)
        .collect();
    assert_eq!(
        codes,
        [DiagnosticCode::GitCompat, DiagnosticCode::GcRecommended]
    );
}

#[test]
fn publishing_gate_gates_bookmarks_like_pushes_unverified_snapshots_warn_on_bookmarks_and_block_pushes()
 {
    let pipeline = JjrGuardrailPipeline::new();
    let g = graph(vec![
        trunk(),
        change(
            "mmmmmmmm",
            &["kkkkkkkk"],
            json!({ "verification": green() }),
        ),
        change(
            "nnnnnnnn",
            &["mmmmmmmm"],
            json!({ "verification": unknown() }),
        ),
        change(
            "pppppppp",
            &["nnnnnnnn"],
            json!({ "verification": { "formatted": true, "builds": true, "testsPass": false, "verified": true } }),
        ),
        change(
            "qqqqqqqq",
            &["kkkkkkkk"],
            json!({ "empty": true, "description": "feat: planned", "intent": "blueprint", "verification": unknown() }),
        ),
    ]);
    let bookmark = |id: &str| {
        pipeline.evaluate(
            &g,
            &action(json!({ "type": "bookmark", "bookmarks": ["b"], "targetChanges": [id] })),
        )
    };
    let push = |id: &str| {
        pipeline.evaluate(
            &g,
            &action(json!({ "type": "push", "targetChanges": [id] })),
        )
    };
    assert!(bookmark("mmmmmmmm").allowed);
    assert!(bookmark("nnnnnnnn").allowed);
    assert_eq!(first_warning(&bookmark("nnnnnnnn")), Some("PublishingGate"));
    assert_eq!(first_blocker(&push("nnnnnnnn")), Some("PublishingGate"));
    assert_eq!(first_blocker(&bookmark("pppppppp")), Some("PublishingGate"));
    assert!(
        push("qqqqqqqq").allowed,
        "an empty blueprint documents a plan and needs no verification"
    );
    // A dry-run step that creates a bookmark carries its targets.
    let step = pipeline.evaluate(
        &g,
        &action(json!({
            "type": "mutate",
            "args": ["bookmark", "set", "x", "-r", "pppppppp"],
            "targetChanges": [],
            "bookmarks": [{ "names": ["x"], "targetChanges": ["pppppppp"] }],
        })),
    );
    assert_eq!(first_blocker(&step), Some("PublishingGate"));
    // Pushing by bookmark name resolves the bookmark.
    let named = graph(vec![
        trunk(),
        change(
            "mmmmmmmm",
            &["kkkkkkkk"],
            json!({ "bookmarks": ["feat"], "verification": unknown() }),
        ),
    ]);
    assert!(
        !pipeline
            .evaluate(
                &named,
                &action(json!({ "type": "push", "targetChanges": [], "bookmark": "feat" }))
            )
            .allowed
    );

    let state = |v: Value| {
        verification_state(Some(
            &serde_json::from_value::<VerificationStatus>(v).unwrap(),
        ))
    };
    assert_eq!(state(green()), VerificationState::Green);
    assert_eq!(state(unknown()), VerificationState::Unknown);
    assert_eq!(state(json!({ "formatted": false })), VerificationState::Red);
    assert_eq!(
        state(json!({ "formatted": true, "builds": true, "testsPass": true })),
        VerificationState::Green,
        "explicit results count"
    );
}

#[test]
fn colocated_git_guard_lets_only_read_only_git_through_with_the_jj_equivalent_for_the_rest() {
    for cmd in [
        "git status",
        "git log --oneline",
        "git -C sub diff HEAD~1",
        "git show abc",
        "git branch",
        "git branch -a",
        "git tag -l \"v*\"",
        "git config --get user.name",
        "git stash list",
        "git remote -v",
        "git blame x.js",
    ] {
        assert!(is_read_only_git_command(cmd), "{cmd}");
    }
    for cmd in [
        "git checkout main",
        "git fetch",
        "git pull",
        "git push",
        "git commit -m x",
        "git branch -D x",
        "git branch new",
        "git tag -a v1",
        "git tag v1",
        "git stash",
        "git reset --hard",
        "git submodule update",
        "git config user.name x",
    ] {
        assert!(!is_read_only_git_command(cmd), "{cmd}");
    }
    let pipeline = JjrGuardrailPipeline::new();
    let fetch = action(json!({ "type": "git-interop", "rawGitCommand": "git fetch" }));
    let g = JjrGraph::new(vec![], colocated(true), None);
    let remediation = pipeline.evaluate(&g, &fetch).blockers[0]
        .remediation
        .clone()
        .unwrap();
    assert!(remediation.contains("jj git fetch"), "{remediation}");
    assert!(
        pipeline
            .evaluate(&JjrGraph::new(vec![], colocated(false), None), &fetch)
            .allowed
    );
}

#[test]
fn change_id_addressing_guard_warns_when_mutable_work_is_named_by_commit_id() {
    let pipeline = JjrGuardrailPipeline::new();
    let commit_id = format!("{:0<40}", "0123456789abcdef");
    let g = graph(vec![
        trunk(),
        change("mmmmmmmm", &["kkkkkkkk"], json!({ "commitId": commit_id })),
    ]);
    let r = pipeline.evaluate(
        &g,
        &action(json!({ "type": "mutate", "args": ["describe", &commit_id[..12], "-m", "x"], "targetChanges": [commit_id] })),
    );
    assert!(r.allowed);
    assert_eq!(first_warning(&r), Some("ChangeIdAddressingGuard"));
    assert!(
        r.warnings[0].message.contains("→ mmmmmmmm"),
        "{}",
        r.warnings[0].message
    );
    let by_change_id = action(
        json!({ "type": "mutate", "args": ["describe", "mmmmmmmm", "-m", "x"], "targetChanges": ["mmmmmmmm"] }),
    );
    assert_eq!(pipeline.evaluate(&g, &by_change_id).warnings.len(), 0);
}

#[test]
fn divergence_guard_halts_stacking_even_jj_new_and_counts_divergence_the_loaded_revset_missed() {
    let pipeline = JjrGuardrailPipeline::new();
    let missed = "w".repeat(32);
    let g = graph_with(vec![trunk()], preflight(json!({ "divergent": [missed] })));
    let new_main =
        action(json!({ "type": "mutate", "args": ["new", "main"], "targetChanges": [] }));
    assert_eq!(
        first_blocker(&pipeline.evaluate(&g, &new_main)),
        Some("DivergenceGuard")
    );
    let abandon =
        action(json!({ "type": "mutate", "args": ["abandon", "abc123"], "targetChanges": [] }));
    assert!(pipeline.evaluate(&g, &abandon).allowed);
    assert!(
        !pipeline
            .evaluate(
                &g,
                &action(json!({ "type": "bookmark", "targetChanges": [] }))
            )
            .allowed
    );
    assert!(
        g.diagnose()
            .iter()
            .any(|d| d.code == DiagnosticCode::DivergentChange
                && d.affected_changes.contains(&missed))
    );
}

#[test]
fn guardrail_results_serialize_in_the_js_shape() {
    let pipeline = JjrGuardrailPipeline::new();
    let r = pipeline.evaluate(&graph(vec![]), &action(json!({ "type": "workspace-add" })));
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["allowed"], true);
    assert_eq!(
        v["decisions"][0],
        json!({ "allowed": true, "ruleName": "PreflightGuard", "severity": "pass", "message": "OK" })
    );
    assert_eq!(
        v["warnings"][0],
        json!({
            "allowed": true,
            "ruleName": "WorkspaceDisciplineGuard",
            "severity": "warn",
            "message": "Creating a workspace without a stated reason.",
            "remediation": "Add a workspace only when parallel agents, concurrent test suites, or simultaneous builds need their own file tree.",
        })
    );
    assert_eq!(v["blockers"], json!([]));
    assert_eq!(r.decisions.len(), 8);
    assert!(r.decisions.iter().all(|d| d.allowed));
}

#[test]
fn evaluate_with_jev_adds_calibrated_scratchpad_and_blast_radius_decisions() {
    let pipeline = JjrGuardrailPipeline::new();
    let jev = JjrJevAssistant::offline();
    let g = graph(vec![
        trunk(),
        change(
            "mmmmmmmm",
            &["kkkkkkkk"],
            json!({ "description": "wip: try things", "paths": ["src/a.rs"] }),
        ),
        change(
            "nnnnnnnn",
            &["kkkkkkkk"],
            json!({ "description": "feat: finished work", "paths": ["src/b.rs"] }),
        ),
    ]);

    // Without Jev, or when the rules already block, Jev is not asked.
    let push_wip = action(json!({ "type": "push", "targetChanges": ["mmmmmmmm"] }));
    assert_eq!(
        pipeline
            .evaluate_with_jev(&g, &push_wip, None, "")
            .jev_assessment,
        None
    );
    let blocked = action(json!({ "type": "workspace-add", "reason": "switch-branch" }));
    let r = pipeline.evaluate_with_jev(&g, &blocked, Some(&jev), "");
    assert!(!r.result.allowed);
    assert_eq!(r.jev_assessment, None);
    assert_eq!(
        serde_json::to_value(&r).unwrap()["jevAssessment"],
        Value::Null
    );

    // A WIP description is a scratchpad: pushing it is blocked.
    let r = pipeline.evaluate_with_jev(&g, &push_wip, Some(&jev), "");
    assert!(!r.result.allowed);
    let gate = &r.result.blockers[0];
    assert_eq!(gate.rule_name, "JevScratchpadGate");
    assert_eq!(gate.calibrated_probability, Some(0.86));
    assert_eq!(
        gate.message,
        "Jev flagged this push target as an unfinished local scratchpad or unmarked megamerge (p=0.86)."
    );

    // Debug output in the diff only warns.
    let push_done = action(json!({ "type": "push", "targetChanges": ["nnnnnnnn"] }));
    let r = pipeline.evaluate_with_jev(&g, &push_done, Some(&jev), "+ console.log(x)");
    assert!(r.result.allowed);
    let warning = r
        .result
        .warnings
        .iter()
        .find(|w| w.rule_name == "JevScratchpadGate")
        .unwrap();
    assert_eq!(warning.severity, DecisionSeverity::Warn);
    assert_eq!(
        warning.message,
        "Jev noticed scratchpad signals in this change (p=0.54). Double-check before publishing."
    );
    assert_eq!(
        r.jev_assessment
            .as_ref()
            .map(|a| a.looks_like_scratchpad.noul),
        Some(0.54)
    );

    // Rewinding the operation log touches the whole repository.
    let restore =
        action(json!({ "type": "mutate", "command": "op restore 0123abcd", "targetChanges": [] }));
    let r = pipeline.evaluate_with_jev(&g, &restore, Some(&jev), "");
    assert!(r.result.allowed);
    let advisor = r
        .result
        .warnings
        .iter()
        .find(|w| w.rule_name == "JevBlastRadiusAdvisor")
        .unwrap();
    assert_eq!(
        advisor.message,
        "Jev scored this action's blast radius as \"repo-wide\" (score=2.58, confidence=0.78). Preview in dry-run mode first."
    );
    assert_eq!(advisor.calibrated_confidence, Some(0.78));
    assert_eq!(r.result.decisions.len(), 9);
}
