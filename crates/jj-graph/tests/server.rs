//! The engine against throwaway repositories: port of test/server.test.mjs
//! and the server part of test/jjr.test.mjs.

mod common;

use std::cell::RefCell;
use std::io::Read as _;
use std::io::Write as _;

use common::TempRepo;
use common::get;
use common::get_state;
use common::node;
use common::post;
use common::s;
use common::strings;
use common::try_node;
use serde_json::json;

fn commit_ids(repo: &TempRepo) -> String {
    repo.jj(&["log", "--no-graph", "-T", "commit_id ++ \"\\n\""])
}

#[test]
fn a_dry_run_previews_without_touching_the_repository_then_applies() {
    let repo = TempRepo::two_arms("jj-graph-test");
    let mut app = repo.app();

    let live = get_state(&mut app, "all()");
    assert_eq!(live["dry"]["active"], false);
    let a = node(&live, "feat a").clone();
    let b = node(&live, "feat b").clone();
    assert_eq!(b["wc"], true);
    let edges: Vec<String> = b["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| s(&e["to"]).to_owned())
        .collect();
    assert_eq!(edges, [s(&node(&live, "base")["id"])]);
    let before = commit_ids(&repo);

    // Step 1: move b onto a.
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["rebase", "-s", b["change"], "-o", a["change"]] }),
    )
    .unwrap();
    assert_eq!(r["result"]["changed"], true);
    assert_eq!(r["state"]["dry"]["active"], true);
    assert_eq!(
        strings(&node(&r["state"], "feat b")["parents"]),
        [s(&a["id"])]
    );
    assert_ne!(
        r["state"]["baseline"][s(&b["change"])],
        node(&r["state"], "feat b")["id"]
    );
    assert_eq!(commit_ids(&repo), before, "repository is untouched");

    // Step 2, typed as a command line, builds on step 1.
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "line": format!("describe {} -m \"feat a, renamed\"", s(&a["change"])) }),
    )
    .unwrap();
    assert_eq!(r["state"]["dry"]["steps"].as_array().unwrap().len(), 2);
    let renamed = node(&r["state"], "feat a, renamed");
    assert_eq!(
        strings(&node(&r["state"], "feat b")["parents"]),
        [s(&renamed["id"])]
    );

    // A no-op adds no step.
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["rebase", "-s", b["change"], "-o", a["change"]] }),
    )
    .unwrap();
    assert_eq!(r["result"]["changed"], false);
    assert_eq!(r["state"]["dry"]["steps"].as_array().unwrap().len(), 2);

    // Undo and redo move between previews.
    let r = post(&mut app, "/api/undo", json!({})).unwrap();
    assert_eq!(r["state"]["dry"]["steps"].as_array().unwrap().len(), 1);
    assert!(try_node(&r["state"], "feat a\n").is_some());
    let r = post(&mut app, "/api/redo", json!({})).unwrap();
    assert_eq!(r["state"]["dry"]["steps"].as_array().unwrap().len(), 2);

    // A failing command reports jj's error and leaves the plan alone.
    let err = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["rebase", "-s", "nosuchrev", "-o", "main"] }),
    )
    .unwrap_err();
    assert!(err.contains("nosuchrev"), "{err}");
    let err = post(&mut app, "/api/dry", json!({ "args": ["git", "push"] })).unwrap_err();
    assert!(err.contains("cannot be dry-run"), "{err}");

    // An edit made while the dry run is open survives the apply.
    repo.write("late.txt", "late\n");

    let r = post(&mut app, "/api/apply", json!({})).unwrap();
    assert_eq!(r["result"]["applied"], 2);
    assert_eq!(r["state"]["dry"]["active"], false);
    let log = repo.jj(&["log", "--no-graph", "-T", "description.first_line() ++ \"|\" ++ parents.map(|p| p.description().first_line()).join(\",\") ++ \"\\n\""]);
    assert!(log.contains("feat b|feat a, renamed"), "{log}");
    let status = repo.jj(&["status"]);
    assert!(
        status.contains("A late.txt") && status.contains("A fb.txt"),
        "{status}"
    );

    // The apply can be undone as one unit.
    let undo_op = s(&r["result"]["undoOp"]).to_owned();
    let r = post(&mut app, "/api/restore", json!({ "op": undo_op })).unwrap();
    assert!(try_node(&r["state"], "feat a\n").is_some());
    assert_eq!(
        strings(&node(&r["state"], "feat b")["parents"]),
        [s(&node(&r["state"], "base")["id"])]
    );
}

#[test]
fn a_plan_follows_the_repository_when_it_changes_underneath() {
    let repo = TempRepo::two_arms("jj-graph-test");
    let mut app = repo.app();
    let live = get_state(&mut app, "all()");
    let a = node(&live, "feat a").clone();

    // Make a change, then name it by its id in a later step.
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["new", "--no-edit", a["change"], "-m", "fresh"] }),
    )
    .unwrap();
    let fresh = s(&node(&r["state"], "fresh")["change"]).to_owned();
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["describe", fresh, "-m", "fresh, described"] }),
    )
    .unwrap();
    let base = s(&r["state"]["dry"]["base"]).to_owned();

    // The repository moves on: both steps are replayed on the new operation.
    repo.jj(&[
        "describe",
        s(&a["change"]),
        "-m",
        "feat a, edited elsewhere",
    ]);
    let state = get_state(&mut app, "all()");
    assert!(state["dry"]["stale"].is_null(), "{}", state["dry"]["stale"]);
    assert_ne!(s(&state["dry"]["base"]), base);
    assert_eq!(state["dry"]["steps"].as_array().unwrap().len(), 2);
    let described = node(&state, "fresh, described");
    assert_eq!(
        strings(&described["parents"]),
        [s(&node(&state, "feat a, edited elsewhere")["id"])]
    );

    // A step whose target disappeared marks the plan stale and blocks apply.
    repo.jj(&["abandon", s(&a["change"])]);
    let state = get_state(&mut app, "all()");
    let stale = s(&state["dry"]["stale"]);
    assert!(
        stale.starts_with("Step 1 ") && stale.contains("no longer applies"),
        "{stale}"
    );
    let err = post(&mut app, "/api/apply", json!({})).unwrap_err();
    assert!(err.contains("no longer applies"), "{err}");
}

#[test]
fn the_operation_log_can_be_looked_back_at_and_restored_as_a_dry_run() {
    let repo = TempRepo::two_arms("jj-graph-test");
    let mut app = repo.app();
    let before = get_state(&mut app, "all()");
    assert!(before["viewing"].is_null());
    assert_eq!(node(&before, "feat b")["files"], 1);
    assert_eq!(before["ops"][0]["id"], before["head"]);

    repo.jj(&["describe", "-m", "feat b, reworded"]);
    let now = get_state(&mut app, "all()");
    assert!(try_node(&now, "feat b, reworded").is_some());
    assert!(
        s(&now["ops"][0]["description"]).contains("describe commit"),
        "{}",
        now["ops"][0]["description"]
    );

    // Looking back shows the old state and changes nothing.
    let head = s(&before["head"]).to_owned();
    let past = get(
        &mut app,
        "/api/state",
        &[("revset", "all()"), ("at", &head)],
    )
    .unwrap();
    assert_eq!(past["viewing"], before["head"]);
    assert!(try_node(&past, "feat b\n").is_some());
    assert_eq!(past["head"], now["head"]);

    // One change, several versions.
    let b = node(&now, "feat b, reworded").clone();
    let evo = get(&mut app, "/api/evolog", &[("rev", s(&b["id"]))]).unwrap();
    let versions = evo["versions"].as_array().unwrap();
    assert!(versions.len() >= 2);
    assert_eq!(versions[0]["commit"], b["id"]);
    assert!(
        s(&versions[0]["operation"]).contains("describe commit"),
        "{}",
        versions[0]["operation"]
    );

    // Restoring is an operation like any other, so it previews first.
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["op", "restore", &head[..16]] }),
    )
    .unwrap();
    assert_eq!(r["result"]["changed"], true);
    assert!(try_node(&r["state"], "feat b\n").is_some());
    assert!(
        repo.jj(&["log", "--no-graph", "-r", "@", "-T", "description"])
            .contains("reworded")
    );

    // The timeline can jump between plan steps.
    let r = post(&mut app, "/api/goto", json!({ "steps": 0 })).unwrap();
    assert_eq!(r["state"]["dry"]["active"], false);
    assert_eq!(r["state"]["dry"]["redo"].as_array().unwrap().len(), 1);
    let r = post(&mut app, "/api/goto", json!({ "steps": 1 })).unwrap();
    assert_eq!(r["state"]["dry"]["steps"].as_array().unwrap().len(), 1);
    assert!(try_node(&r["state"], "feat b\n").is_some());
}

#[test]
fn changes_a_step_names_are_told_apart_from_those_that_only_follow() {
    let repo = TempRepo::two_arms("jj-graph-test");
    let mut app = repo.app();
    let live = get_state(&mut app, "all()");
    let a = node(&live, "feat a").clone();
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["new", "--no-edit", a["change"], "-m", "child"] }),
    )
    .unwrap();
    let child = s(&node(&r["state"], "child")["change"]).to_owned();
    // `a` is only where the new change goes, so it is not counted as edited.
    assert_eq!(
        strings(&r["state"]["touched"]),
        std::slice::from_ref(&child)
    );
    let b = node(&live, "feat b").clone();
    let r = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["rebase", "-s", a["change"], "-o", b["change"]] }),
    )
    .unwrap();
    let mut touched = strings(&r["state"]["touched"]);
    touched.sort();
    let mut expected = vec![s(&a["change"]).to_owned(), child];
    expected.sort();
    assert_eq!(touched, expected);
    assert_eq!(r["state"]["rewound"], false);
}

#[test]
fn discard_forgets_the_preview() {
    let repo = TempRepo::two_arms("jj-graph-test");
    let mut app = repo.app();
    let live = get_state(&mut app, "all()");
    post(
        &mut app,
        "/api/dry",
        json!({ "args": ["abandon", node(&live, "feat a")["change"]] }),
    )
    .unwrap();
    let r = post(&mut app, "/api/discard", json!({})).unwrap();
    assert_eq!(r["state"]["dry"]["active"], false);
    assert!(try_node(&r["state"], "feat a").is_some());
}

#[test]
fn parents_outside_the_revset_become_indirect_edges() {
    let repo = TempRepo::two_arms("jj-graph-test");
    let mut app = repo.app();
    let state = get_state(&mut app, "heads(all()) | root()");
    let b = node(&state, "feat b");
    let root = state["nodes"].as_array().unwrap().last().unwrap();
    let edges: Vec<(bool, String)> = b["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["indirect"].as_bool().unwrap(), s(&e["to"]).to_owned()))
        .collect();
    assert_eq!(edges, [(true, s(&root["id"]).to_owned())]);
}

#[test]
fn jjr_endpoints_docs_and_guardrails_on_dry_runs() {
    let repo = TempRepo::new("jjr-test");
    repo.write("base.txt", "base\n");
    repo.jj(&["commit", "-m", "base"]);
    repo.jj(&["bookmark", "create", "main", "-r", "@-"]);
    repo.jj(&[
        "config",
        "set",
        "--repo",
        "revset-aliases.\"immutable_heads()\"",
        "main",
    ]);
    repo.write("auth.js", "export const auth = true;\n");
    repo.jj(&["commit", "-m", "feat: add auth"]);
    repo.write("cleanup.js", "export const tidy = true;\n");
    repo.jj(&["commit", "-m", "refactor: extract cleanup"]);

    let mut app = repo.app();
    let st = get_state(&mut app, "all()");
    assert!(st["jjr"].is_object());
    assert_eq!(
        st["jjr"]["summary"]["warnings"], 1,
        "{}",
        st["jjr"]["diagnostics"]
    );

    let diag = get(&mut app, "/api/jjr/diagnose", &[("revset", "all()")]).unwrap();
    assert!(
        diag["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "UNORDERED_STRUCTURAL_ABOVE_BEHAVIORAL")
    );

    let ui = get(&mut app, "/api/jjr/ui", &[("revset", "all()")]).unwrap();
    assert!(s(&ui["tui"]).contains("JJR REVISION GRAPH"));
    assert!(ui["guiRows"].as_array().unwrap().len() >= 3);

    let auth = node(&st, "feat: add auth").clone();
    let cleanup = node(&st, "refactor: extract cleanup").clone();
    let base = node(&st, "base").clone();

    let triage = post(
        &mut app,
        "/api/jjr/triage",
        json!({ "rev": cleanup["change"] }),
    )
    .unwrap();
    assert_eq!(triage["answers"]["intent"]["choice"], "structural");

    let naming = post(
        &mut app,
        "/api/jjr/suggest-name",
        json!({ "rev": auth["change"] }),
    )
    .unwrap();
    assert!(s(&naming["conventionalTitle"]).contains("auth"), "{naming}");

    let dep = post(
        &mut app,
        "/api/jjr/dependency",
        json!({ "base": auth["change"], "child": cleanup["change"] }),
    )
    .unwrap();
    assert_eq!(dep["verdict"]["outcome"], "parallelize");

    // The guardrails block rewriting the immutable base through a dry run.
    let err = post(
        &mut app,
        "/api/dry",
        json!({ "args": ["describe", base["change"], "-m", "nope"] }),
    )
    .unwrap_err();
    assert!(err.contains("ImmutableBedrockGuard"), "{err}");

    // A JjrRunner dry-runs end to end on mutable revisions.
    let cell = RefCell::new(app);
    let runner = jjr::runner::JjrRunner::new(
        jjr::guardrails::JjrGuardrailPipeline::new(),
        jjr::jev::JjrJevAssistant::offline(),
        jjr::narrator::JjrNarrator::new(None, jjr::jev::JjrJevAssistant::offline()),
    );
    let args: Vec<String> = [
        "rebase",
        "-r",
        s(&cleanup["change"]),
        "-B",
        s(&auth["change"]),
    ]
    .iter()
    .map(|a| (*a).to_owned())
    .collect();
    let outcome = runner
        .dry_run(&jj_graph::app::AppHost(&cell), &args, None, false)
        .unwrap();
    assert!(!outcome.blocked);
    assert_eq!(outcome.result.as_ref().unwrap()["changed"], true);

    // The HTTP server serves the reference docs.
    let server = jj_graph::server::bind("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let mut app = cell.into_inner();
    std::thread::spawn(move || jj_graph::server::serve_on(&server, &mut app, None));
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "GET /docs HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "{}",
        &response[..response.len().min(200)]
    );
    assert!(response.contains("jjr — A Framework for Jujutsu"));
    assert!(
        !response.to_lowercase().contains("django"),
        "docs must never mention Django"
    );
}
