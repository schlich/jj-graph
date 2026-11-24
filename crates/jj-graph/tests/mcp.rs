//! The MCP server: protocol, an agent's plan from preview to restore, the
//! reading tools, and the stdio transport.

mod common;

use std::io::BufRead as _;
use std::io::BufReader;
use std::io::Write as _;
use std::process::Command;
use std::process::Stdio;
use std::sync::LazyLock;

use common::TempRepo;
use jj_graph::mcp::McpServer;
use jj_graph::mcp::PROTOCOL_VERSIONS;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn rpc(server: &mut McpServer, method: &str, params: Value) -> Value {
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    server
        .handle(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
        .expect("a response")
}

/// Call a tool; returns its text and whether it is an error.
fn call(server: &mut McpServer, name: &str, args: Value) -> (String, bool) {
    let res = rpc(
        server,
        "tools/call",
        json!({ "name": name, "arguments": args }),
    );
    let result = res.get("result").unwrap_or_else(|| panic!("{res}"));
    let text = result["content"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["text"].as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    (text, result["isError"].as_bool().unwrap_or(false))
}

/// The 12-character change id the graph shows for the revision titled `title`.
fn id_in(text: &str, title: &str) -> String {
    let re = Regex::new(&format!(
        r"(?m)^. ([k-z]{{12}}) \S+ {}",
        regex::escape(title)
    ))
    .unwrap();
    re.captures(text)
        .unwrap_or_else(|| panic!("no {title} in\n{text}"))[1]
        .to_owned()
}

fn parent_of(repo: &TempRepo, title: &str) -> String {
    repo.jj(&[
        "log",
        "--no-graph",
        "-r",
        &format!("description(exact:\"{title}\n\")"),
        "-T",
        "parents.map(|p| p.description().first_line()).join(\",\")",
    ])
}

fn server(repo: &TempRepo) -> McpServer {
    McpServer::new(repo.app(), None)
}

fn matches(re: &str, text: &str) -> bool {
    Regex::new(re).unwrap().is_match(text)
}

#[test]
fn the_protocol_initialize_ping_tools_list_and_errors() {
    let repo = TempRepo::new("jj-graph-mcp-test");
    let mut server = server(&repo);
    let init = rpc(
        &mut server,
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } }),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "jj-graph");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert!(
        init["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("dry_run")
    );
    // An unknown revision gets the newest one this server speaks.
    let old = rpc(
        &mut server,
        "initialize",
        json!({ "protocolVersion": "1999-01-01" }),
    );
    assert_eq!(old["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);

    assert!(
        server
            .handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .is_none()
    );
    assert_eq!(rpc(&mut server, "ping", json!(null))["result"], json!({}));

    let list = rpc(&mut server, "tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in [
        "graph",
        "dry_run",
        "plan_undo",
        "plan_redo",
        "plan_discard",
        "apply_plan",
        "restore_operation",
        "op_log",
        "show",
        "evolog",
        "diagnose",
        "preflight",
        "guard",
        "verify_stack",
        "publish_plan",
        "triage",
        "assess_dependency",
        "suggest_name",
        "recipe",
    ] {
        assert!(names.contains(&n), "lists {n}");
    }
    // The state request is for clients, not a tool the model sees.
    assert!(!names.iter().any(|n| n.contains("state")));
    for t in tools {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        assert!(t["description"].as_str().unwrap().len() > 20);
        assert!(t["annotations"]["readOnlyHint"].is_boolean());
    }
    let tool = |name: &str| tools.iter().find(|t| t["name"] == name).unwrap();
    assert_eq!(tool("graph")["annotations"]["readOnlyHint"], true);
    assert_eq!(tool("apply_plan")["annotations"]["destructiveHint"], true);

    assert_eq!(
        rpc(&mut server, "resources/list", json!({}))["error"]["code"],
        -32601
    );
    assert_eq!(
        rpc(
            &mut server,
            "tools/call",
            json!({ "name": "nope", "arguments": {} })
        )["error"]["code"],
        -32602
    );
    assert_eq!(
        server
            .handle(&json!({ "id": 1, "method": "ping" }))
            .unwrap()["error"]["code"],
        -32600
    );
    // A missing required argument is a tool error the model can read and fix.
    let (text, is_error) = call(&mut server, "restore_operation", json!({}));
    assert!(is_error);
    assert!(text.contains("Missing argument: op"), "{text}");
}

#[test]
fn an_agent_previews_a_plan_applies_it_and_restores() {
    let repo = TempRepo::two_arms("jj-graph-mcp-test");
    let mut server = server(&repo);

    let (graph, is_error) = call(&mut server, "graph", json!({ "revset": "all()" }));
    assert!(!is_error, "{graph}");
    assert!(
        matches(
            r"live at operation [0-9a-f]{12}; no dry run is open",
            &graph
        ),
        "{graph}"
    );
    assert!(
        matches(
            r"(?m)^@ [k-z]{12} \S+ feat b \(1 file\) ← [k-z]{12}$",
            &graph
        ),
        "{graph}"
    );
    // Without a remote, trunk() is root(): only root is immutable.
    assert!(
        matches(
            r"(?m)^○ [k-z]{12} \S+ base \[main\] \(1 file\) ← zzzzzzzzzzzz$",
            &graph
        ),
        "{graph}"
    );
    assert!(
        matches(
            r"(?m)^◆ zzzzzzzzzzzz 00000000 \(no description\) \(empty\)$",
            &graph
        ),
        "{graph}"
    );
    assert!(matches(r"(?m)^jjr: \w+ shape, ", &graph), "{graph}");
    let a = id_in(&graph, "feat a");
    let b = id_in(&graph, "feat b");
    let before = repo.jj(&["log", "--no-graph", "-T", "commit_id ++ \"\\n\""]);

    // The 12-character ids from the graph are expanded to full ones for replay.
    let (text, is_error) = call(
        &mut server,
        "dry_run",
        json!({ "command": format!("jj rebase -s {b} -o {a}") }),
    );
    assert!(!is_error, "{text}");
    assert!(
        matches(r"(?m)^Step 1: jj rebase -s [k-z]{8} -o [k-z]{8}$", &text),
        "{text}"
    );
    assert!(text.contains("DRY RUN: 1 step(s)"), "{text}");
    assert!(
        matches(
            &format!(
                r"(?m)^@ {b} [0-9a-f]{{8}}→[0-9a-f]{{8}} feat b \(1 file, edited by plan\) ← {a}$"
            ),
            &text
        ),
        "{text}"
    );
    let step = &server.app().plan().steps[0].args;
    assert!(
        step.iter().any(|x| x.len() == 32 && x.starts_with(&b)),
        "{step:?}"
    );
    assert!(
        step.iter().any(|x| x.len() == 32 && x.starts_with(&a)),
        "{step:?}"
    );
    assert_eq!(
        repo.jj(&["log", "--no-graph", "-T", "commit_id ++ \"\\n\""]),
        before,
        "repository is untouched"
    );

    // A message that happens to look like an id is left alone.
    let (text, is_error) = call(
        &mut server,
        "dry_run",
        json!({ "args": ["describe", a, "-m", b] }),
    );
    assert!(!is_error, "{text}");
    assert_eq!(server.app().plan().steps[1].args.last().unwrap(), &b);

    let (text, _) = call(&mut server, "plan_undo", json!({}));
    assert!(
        text.contains("Undid 1 step")
            && text.contains("DRY RUN: 1 step(s)")
            && text.contains("redo: jj describe"),
        "{text}"
    );
    let (text, _) = call(&mut server, "plan_redo", json!({}));
    assert!(text.contains("DRY RUN: 2 step(s)"), "{text}");
    let (text, _) = call(&mut server, "plan_undo", json!({ "count": 1 }));
    assert!(text.contains("DRY RUN: 1 step(s)"), "{text}");

    // A client reads the same plan, with the graph it leaves, as data.
    let state = rpc(&mut server, "jj-graph/state", json!({ "revset": "all()" }));
    let state = state.get("result").unwrap_or_else(|| panic!("{state}"));
    assert_eq!(state["revset"], "all()");
    assert_eq!(state["dry"]["active"], true);
    assert_eq!(state["dry"]["steps"].as_array().unwrap().len(), 1);
    assert!(
        state["dry"]["steps"][0]["label"]
            .as_str()
            .unwrap()
            .starts_with("jj rebase"),
        "{state}"
    );
    assert_eq!(state["dry"]["redo"].as_array().unwrap().len(), 1);
    assert!(
        state["touched"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t.as_str().is_some_and(|t| t.starts_with(&b)))
    );
    assert!(
        state["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["wc"] == true)
    );
    assert!(state["jjr"]["summary"].is_object());
    // A bad revset is an error response, not a tool result.
    let bad = rpc(&mut server, "jj-graph/state", json!({ "revset": "nope((" }));
    assert_eq!(bad["error"]["code"], -32000, "{bad}");

    // Refusals come back as tool errors, and the plan is unchanged.
    let (text, is_error) = call(&mut server, "dry_run", json!({ "args": ["git", "push"] }));
    assert!(is_error && text.contains("cannot be dry-run"), "{text}");
    let (_, is_error) = call(
        &mut server,
        "dry_run",
        json!({ "command": "describe -r root() -m x" }),
    );
    assert!(is_error);
    let (_, is_error) = call(&mut server, "dry_run", json!({}));
    assert!(is_error);
    assert_eq!(server.app().plan().steps.len(), 1);

    let (text, is_error) = call(&mut server, "apply_plan", json!({}));
    assert!(!is_error, "{text}");
    assert!(
        text.contains("Applied 1 step(s)") && text.contains("live at operation"),
        "{text}"
    );
    assert_eq!(parent_of(&repo, "feat b"), "feat a");
    let undo_op = Regex::new(r#"restore_operation with op "([0-9a-f]+)""#)
        .unwrap()
        .captures(&text)
        .unwrap()[1]
        .to_owned();

    let (text, is_error) = call(&mut server, "restore_operation", json!({ "op": undo_op }));
    assert!(!is_error, "{text}");
    assert_eq!(parent_of(&repo, "feat b"), "base");

    // Discarding forgets a plan without touching the repository.
    call(
        &mut server,
        "dry_run",
        json!({ "command": format!("abandon {a}") }),
    );
    let (text, _) = call(&mut server, "plan_discard", json!({}));
    assert!(
        text.contains("no dry run is open") && text.contains("feat a"),
        "{text}"
    );
}

#[test]
fn reading_tools_show_evolog_op_log_diagnostics_recipes_guardrails() {
    let repo = TempRepo::two_arms("jj-graph-mcp-test");
    let mut server = server(&repo);
    let (graph, _) = call(&mut server, "graph", json!({ "revset": "all()" }));
    let a = id_in(&graph, "feat a");
    let b = id_in(&graph, "feat b");

    let (text, _) = call(&mut server, "show", json!({}));
    assert!(text.contains("fb.txt"), "{text}");
    let (text, _) = call(&mut server, "show", json!({ "rev": a, "mode": "diff" }));
    assert!(matches(r"(?m)^\+a$", &text), "{text}");
    let (text, _) = call(&mut server, "show", json!({ "rev": "@-" }));
    assert!(text.contains("base"), "{text}");
    let (text, is_error) = call(&mut server, "show", json!({ "rev": "all()" }));
    assert!(
        is_error && matches(r"resolves to \d+ revisions", &text),
        "{text}"
    );

    let (text, _) = call(&mut server, "evolog", json!({ "rev": "@" }));
    assert!(matches(r"(?m)^1\. [0-9a-f]{12} .*feat b", &text), "{text}");

    let (text, _) = call(&mut server, "op_log", json!({}));
    let op = Regex::new(r"(?m)^▸ ([0-9a-f]{12})")
        .unwrap()
        .captures(&text)
        .unwrap_or_else(|| panic!("{text}"))[1]
        .to_owned();
    let (text, _) = call(&mut server, "graph", json!({ "at": op, "revset": "all()" }));
    assert!(
        matches(r"(?m)^(live at operation|looking back at operation)", &text),
        "{text}"
    );

    let (text, _) = call(
        &mut server,
        "graph",
        json!({ "revset": "all()", "format": "json" }),
    );
    let state: Value = serde_json::from_str(&text).unwrap();
    assert!(
        state["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["description"].as_str().unwrap().starts_with("feat a"))
    );

    let pre: Value = serde_json::from_str(&call(&mut server, "preflight", json!({})).0).unwrap();
    assert_eq!(pre["preflight"]["trunk"]["resolved"], true);
    let diag: Value =
        serde_json::from_str(&call(&mut server, "diagnose", json!({ "revset": "all()" })).0)
            .unwrap();
    assert!(diag["summary"]["shape"].is_string());

    let (text, is_error) = call(&mut server, "publish_plan", json!({ "rev": b }));
    assert!(!is_error, "{text}");
    assert!(matches(r"^Publishing [k-z]{12} with ", &text), "{text}");

    let (text, _) = call(
        &mut server,
        "recipe",
        json!({ "pattern": "tidy-first", "changeId": b, "description": "extract helper" }),
    );
    assert!(text.starts_with("tidy-first: "), "{text}");
    assert!(
        matches(
            r#"dry_run args: \["new","-B","[k-z]{12}","-m","refactor: extract helper"\]"#,
            &text
        ),
        "{text}"
    );
    let (text, is_error) = call(&mut server, "recipe", json!({ "pattern": "tidy-first" }));
    assert!(
        is_error && text.contains("needs: changeId, description"),
        "{text}"
    );

    let dep: Value = serde_json::from_str(
        &call(&mut server, "assess_dependency", json!({ "base": a, "child": b, "childCausallyDependsOnBase": false, "baseIndependentlyReviewable": true })).0,
    )
    .unwrap();
    assert_eq!(dep["source"], "explicit");
    assert_eq!(dep["verdict"]["outcome"], "parallelize");

    let verdict: Value = serde_json::from_str(
        &call(
            &mut server,
            "guard",
            json!({ "action": { "type": "git-interop", "rawGitCommand": "git status" } }),
        )
        .0,
    )
    .unwrap();
    assert_eq!(verdict["allowed"], true);
}

static BIN: LazyLock<&str> = LazyLock::new(|| env!("CARGO_BIN_EXE_jj-graph"));

#[test]
fn stdio_one_json_rpc_message_per_line_and_nothing_else_on_stdout() {
    let repo = TempRepo::two_arms("jj-graph-mcp-test");
    let mut child = Command::new(*BIN)
        .args(["mcp"])
        .arg(repo.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap() };

    writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } })).unwrap();
    assert_eq!(next()["result"]["protocolVersion"], "2025-11-25");
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
    )
    .unwrap();
    writeln!(stdin, "{{not json").unwrap();
    assert_eq!(next()["error"]["code"], -32700);
    writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "graph", "arguments": { "revset": "all()" } } })).unwrap();
    let res = next();
    assert_eq!(res["id"], 2);
    assert!(
        res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("feat b")
    );

    drop(stdin);
    assert!(child.wait().unwrap().success());
}
