//! The Jev tests of `test/jjr.test.mjs`, with a one-shot local HTTP server
//! standing in for TypeSafe, plus the fallback to the offline heuristics.

use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;

use jjr::graph::DependencyOutcome;
use jjr::jev::CandidateArm;
use jjr::jev::ChangeContext;
use jjr::jev::ChangeTriageInput;
use jjr::jev::JevClient;
use jjr::jev::JevClientOptions;
use jjr::jev::JevError;
use jjr::jev::JevSource;
use jjr::jev::JjrJevAssistant;
use jjr::jev::RecoveryContext;
use jjr::jev::SystemOneRequest;
use jjr::jev::choice;
use jjr::jev::noul;
use jjr::jev::score;
use serde_json::Value;
use serde_json::json;

/// A request the one-shot server received.
struct Received {
    request_line: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Received {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Serve exactly one HTTP request on a local port, answering with `status`
/// and `body`. Returns the server's base URL and the request it received.
fn serve_once(status: &'static str, body: String) -> (String, JoinHandle<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("a client connection");
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let (name, value) = line.split_once(':').expect("a header line");
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
        let length = headers
            .iter()
            .find(|(k, _)| k == "content-length")
            .map_or(0, |(_, v)| v.parse().unwrap());
        let mut request_body = vec![0; length];
        reader.read_exact(&mut request_body).unwrap();
        write!(
            stream,
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        stream.flush().unwrap();
        Received {
            request_line: request_line.trim_end().to_owned(),
            headers,
            body: String::from_utf8(request_body).unwrap(),
        }
    });
    (base_url, server)
}

/// A client of `base_url` that never reads the environment.
fn client(base_url: &str) -> JevClient {
    JevClient::new(JevClientOptions {
        api_key: Some("ts_test_key".to_owned()),
        base_url: Some(base_url.to_owned()),
        default_model: Some("jev-latest".to_owned()),
        timeout: Some(Duration::from_secs(5)),
    })
}

fn token_parser_change() -> ChangeTriageInput {
    ChangeTriageInput {
        change_id: "kmpqrstu".to_owned(),
        description: "refactor: extract token parser".to_owned(),
        touched_paths: vec!["src/token.ts".to_owned()],
        diff_excerpt: "export function parseToken() {}".to_owned(),
        ..ChangeTriageInput::default()
    }
}

fn arm(change_id: &str, description: &str, touched_paths: &[&str]) -> CandidateArm {
    CandidateArm {
        change_id: change_id.to_owned(),
        description: description.to_owned(),
        touched_paths: touched_paths.iter().map(|p| (*p).to_owned()).collect(),
    }
}

#[test]
fn jev_client_uses_exact_post_v1_systemone_wire_format_and_assistant_powers_system_one_workflows() {
    let reply = json!({
        "answers": {
            "intent": { "choice": "structural", "probabilities": { "structural": 0.92, "behavioral": 0.08 }, "confidence": 0.92 },
            "entangled": { "noul": 0.14 },
            "publishReadiness": { "score": 2.75, "legend": "ready-to-land", "probabilities": [0.02, 0.05, 0.2, 0.73], "confidence": 0.73 },
            "hasDebugOrSecrets": { "noul": 0.03 },
        },
        "usage": { "input_tokens": 180 },
    });
    let (base_url, server) = serve_once("200 OK", reply.to_string());
    // Trailing slashes are trimmed from the base URL.
    let jev = JjrJevAssistant::new(Some(client(&format!("{base_url}//"))));
    assert_eq!(jev.mode(), JevSource::LiveJev);

    let triage = jev.triage_change(&token_parser_change());

    let request = server.join().unwrap();
    assert_eq!(request.request_line, "POST /v1/systemone HTTP/1.1");
    assert_eq!(request.header("authorization"), Some("Bearer ts_test_key"));
    assert_eq!(request.header("content-type"), Some("application/json"));
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["model"], "jev-latest");
    assert_eq!(body["questions"]["intent"]["type"], "choice");
    assert_eq!(body["questions"]["entangled"]["type"], "noul");
    assert_eq!(body["questions"]["publishReadiness"]["type"], "score");
    // The body is JSON.stringify's: the same keys, in the same order.
    let expected_prefix = concat!(
        r#"{"model":"jev-latest","state":{"change_id":"kmpqrstu","description":"refactor: extract token parser","#,
        r#""touched_paths":["src/token.ts"],"diff_excerpt":"export function parseToken() {}","is_empty":false,"#,
        r#""is_working_copy":false,"mutable_parent_count":1,"is_conflicted":false},"questions":{"intent":{"type":"choice","#,
    );
    assert!(
        request.body.starts_with(expected_prefix),
        "{}",
        request.body
    );
    assert_eq!(triage.source, JevSource::LiveJev);
    assert_eq!(triage.model, "jev-latest");
    assert_eq!(triage.answers.intent.choice, "structural");
    assert_eq!(triage.answers.api_without_consumer, None);
    assert_eq!(
        triage
            .usage
            .as_ref()
            .and_then(|u| u.get("input_tokens"))
            .copied(),
        Some(180.0)
    );

    // Also check question builders & offline workflows
    assert_eq!(
        serde_json::to_value(choice("q", [("a", Some("A".to_owned()))])).unwrap()["type"],
        "choice"
    );
    assert_eq!(
        serde_json::to_value(score("q", ["low", "high"])).unwrap()["type"],
        "score"
    );
    assert_eq!(
        serde_json::to_value(noul("q", None)).unwrap(),
        json!({ "type": "noul", "instructions": "q" })
    );

    let offline_jev = JjrJevAssistant::offline();
    let routed = offline_jev.route_hunk(
        "diff --git a/src/billing/invoice.ts",
        &[
            arm("kkkkkkkk", "feat: auth cookies", &["src/auth/cookie.ts"]),
            arm(
                "mmmmmmmm",
                "feat: billing invoice export",
                &["src/billing/invoice.ts"],
            ),
        ],
    );
    assert_eq!(
        routed.decision.map(|d| d.choice).as_deref(),
        Some("mmmmmmmm")
    );

    let rec = offline_jev.recommend_recovery(&RecoveryContext {
        symptom: Some("Regression in arm A".to_owned()),
        target_change_id: Some("kkkkkkkk".to_owned()),
        sibling_arms_modified_since: Some(true),
        bookmark_or_topology_corrupted: Some(false),
    });
    assert_eq!(rec.decision.choice, "evolog");
}

#[test]
fn live_failures_fall_back_to_the_calibrated_offline_answers() {
    let offline = JjrJevAssistant::offline().triage_change(&token_parser_change());
    assert_eq!(offline.source, JevSource::CalibratedOffline);
    assert_eq!(offline.model, "offline-heuristic");
    assert_eq!(offline.usage, None);

    // The server fails.
    let (base_url, server) = serve_once(
        "500 Internal Server Error",
        r#"{"error":"boom"}"#.to_owned(),
    );
    let failing = JjrJevAssistant::new(Some(client(&base_url)));
    assert_eq!(failing.triage_change(&token_parser_change()), offline);
    server.join().unwrap();

    // The server answers something else than the questions asked.
    let (base_url, server) =
        serve_once("200 OK", r#"{"answers":{"axis":{"noul":0.5}}}"#.to_owned());
    let confused = JjrJevAssistant::new(Some(client(&base_url)));
    assert_eq!(confused.triage_change(&token_parser_change()), offline);
    server.join().unwrap();

    // Nothing listens.
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let unreachable = JjrJevAssistant::new(Some(client(&base_url)));
    assert_eq!(unreachable.triage_change(&token_parser_change()), offline);

    // A client without an API key is not configured and never calls out.
    let keyless = JevClient::new(JevClientOptions {
        api_key: Some(String::new()),
        base_url: Some(base_url),
        default_model: Some("jev-latest".to_owned()),
        timeout: None,
    });
    assert!(!keyless.is_configured());
    let request = SystemOneRequest {
        model: None,
        state: json!({}),
        questions: Default::default(),
    };
    assert!(matches!(
        keyless.system_one(&request),
        Err(JevError::NotConfigured)
    ));
    let keyless = JjrJevAssistant::new(Some(keyless));
    assert_eq!(keyless.mode(), JevSource::CalibratedOffline);
    assert_eq!(keyless.triage_change(&token_parser_change()), offline);
}

#[test]
fn system_one_returns_the_raw_answers_and_numeric_usage() {
    let reply = r#"{"answers":{"axis":{"choice":"undo","probabilities":{"undo":0.7,"evolog":0.2,"op-restore":0.1},"confidence":0.7}},"usage":{"input_tokens":12,"detail":{"cached":3}}}"#;
    let (base_url, server) = serve_once("200 OK", reply.to_owned());
    let request = SystemOneRequest {
        model: Some("jev-small".to_owned()),
        state: json!({ "symptom": "oops" }),
        questions: [(
            "axis".to_owned(),
            choice("Which axis?", [("undo", None), ("evolog", None)]),
        )]
        .into_iter()
        .collect(),
    };
    let res = client(&base_url).system_one(&request).unwrap();
    let sent: Value = serde_json::from_str(&server.join().unwrap().body).unwrap();
    assert_eq!(
        sent,
        json!({
            "model": "jev-small",
            "state": { "symptom": "oops" },
            "questions": { "axis": { "type": "choice", "instructions": "Which axis?", "criteria": { "undo": null, "evolog": null } } },
        })
    );
    assert_eq!(res.answers["axis"]["choice"], "undo");
    assert_eq!(
        res.usage.map(|u| u.into_iter().collect::<Vec<_>>()),
        Some(vec![("input_tokens".to_owned(), 12.0)])
    );
}

#[test]
fn offline_heuristics_route_dependencies_and_recovery() {
    let jev = JjrJevAssistant::offline();
    let ctx = |id: &str, description: &str, paths: &[&str]| ChangeContext {
        change_id: id.to_owned(),
        description: description.to_owned(),
        touched_paths: paths.iter().map(|p| (*p).to_owned()).collect(),
        diff_excerpt: String::new(),
    };

    // Overlapping files: the child depends on a self-contained base.
    let stacked = jev.assess_dependency(
        &ctx("kkkkkkkk", "feat: parser", &["src/parser.rs"]),
        &ctx("mmmmmmmm", "feat: use parser", &["src/parser.rs"]),
    );
    assert_eq!(stacked.source, JevSource::CalibratedOffline);
    assert_eq!(stacked.answers.child_causally_depends_on_base.noul, 0.89);
    assert_eq!(stacked.answers.base_independently_reviewable.noul, 0.88);
    assert_eq!(stacked.verdict.outcome, DependencyOutcome::Stack);

    // Unrelated files: parallel arms.
    let parallel = jev.assess_dependency(
        &ctx("kkkkkkkk", "docs", &["README.md"]),
        &ctx("mmmmmmmm", "feat: x", &["src/x.rs"]),
    );
    assert_eq!(parallel.answers.child_causally_depends_on_base.noul, 0.11);
    assert_eq!(parallel.verdict.outcome, DependencyOutcome::Parallelize);

    // A half-finished rename next door: collapse.
    let collapsed = jev.assess_dependency(
        &ctx("kkkkkkkk", "refactor: rename helper", &["src/a/x.ts"]),
        &ctx("mmmmmmmm", "feat: use helper", &["src/a/y.ts"]),
    );
    assert_eq!(collapsed.answers.child_causally_depends_on_base.noul, 0.81);
    assert_eq!(collapsed.answers.base_independently_reviewable.noul, 0.14);
    assert_eq!(collapsed.verdict.outcome, DependencyOutcome::Collapse);

    let rec = |context: RecoveryContext| jev.recommend_recovery(&context).decision;
    let corrupted = rec(RecoveryContext {
        bookmark_or_topology_corrupted: Some(true),
        ..Default::default()
    });
    assert_eq!(corrupted.choice, "op-restore");
    let undo = rec(RecoveryContext::default());
    assert_eq!(undo.choice, "undo");
    assert_eq!(
        undo.probabilities.keys().collect::<Vec<_>>(),
        ["evolog", "op-restore", "undo"]
    );
    assert_eq!(undo.confidence, 0.709);

    assert_eq!(jev.route_hunk("anything", &[]).decision, None);
}
