//! The narrator test of `test/jjr.test.mjs`, plus the deterministic
//! fallbacks for names, graph feedback and dependency critiques.

use std::sync::Arc;
use std::sync::Mutex;

use jjr::JjrGraph;
use jjr::JjrJevAssistant;
use jjr::JjrNarrator;
use jjr::graph::DependencyAssessment;
use jjr::graph::JjrChange;
use jjr::narrator::LlmTransport;
use jjr::narrator::NamingInput;
use jjr::narrator::NarrationSource;
use jjr::narrator::NarratorError;
use jjr::types::ChangeIntent;
use jjr::types::JjrRepoConfig;
use serde_json::json;

/// A transport with a canned reply (`None` fails), recording the prompts it gets.
struct Canned {
    reply: Option<String>,
    configured: bool,
    prompts: Mutex<Vec<(String, String)>>,
}

impl Canned {
    fn new(reply: Option<&str>, configured: bool) -> Arc<Self> {
        Arc::new(Self {
            reply: reply.map(str::to_owned),
            configured,
            prompts: Mutex::new(Vec::new()),
        })
    }
}

impl LlmTransport for Canned {
    fn is_configured(&self) -> bool {
        self.configured
    }

    fn complete(&self, system_prompt: &str, user_prompt: &str) -> Result<String, NarratorError> {
        self.prompts
            .lock()
            .unwrap()
            .push((system_prompt.to_owned(), user_prompt.to_owned()));
        self.reply
            .clone()
            .ok_or_else(|| NarratorError::Http("HTTP 500".to_owned()))
    }
}

fn naming(
    change_id: Option<&str>,
    description: &str,
    touched_paths: &[&str],
    diff_excerpt: &str,
) -> NamingInput {
    NamingInput {
        change_id: change_id.map(str::to_owned),
        description: description.to_owned(),
        touched_paths: touched_paths.iter().map(|p| (*p).to_owned()).collect(),
        diff_excerpt: diff_excerpt.to_owned(),
    }
}

fn change(change_id: &str, parents: &[&str], description: &str) -> JjrChange {
    let hex: String = change_id.bytes().map(|b| format!("{b:02x}")).collect();
    let commit_id = format!("{hex:0<40}");
    serde_json::from_value(json!({
        "changeId": change_id,
        "currentCommit": { "commitId": &commit_id[..40], "changeId": change_id, "description": description, "touchedPaths": ["src/lib.rs", "tests/lib.rs"] },
        "zone": if parents.is_empty() { "immutable" } else { "mutable" },
        "parents": parents,
        "intent": "behavioral",
        "verification": { "formatted": true, "builds": true, "testsPass": true },
    }))
    .unwrap()
}

#[test]
fn narrator_combines_jev_classification_with_light_llm_transport_and_offline_fallback() {
    let reply = json!({
        "conventionalTitle": "refactor(session): extract cookie signature verifier",
        "bookmarkSlug": "refactor/session-verifier",
        "rationale": "Pure structural extraction with zero behavioral changes.",
    })
    .to_string();
    let narrator_with_llm = JjrNarrator::new(
        Some(Canned::new(Some(&reply), true)),
        JjrJevAssistant::offline(),
    );
    let named = narrator_with_llm.suggest_change_name(&naming(
        Some("kmpqrstu"),
        "refactor: extract verifier",
        &["src/session.ts"],
        "function verifyCookie() {}",
    ));
    assert_eq!(named.source, NarrationSource::Llm);
    assert_eq!(named.detected_intent, ChangeIntent::Structural);
    assert_eq!(named.bookmark_slug, "refactor/session-verifier");

    let offline_narrator = JjrNarrator::new(None, JjrJevAssistant::offline());
    let fallback = offline_narrator.suggest_change_name(&naming(
        None,
        "",
        &["src/auth/login.test.ts"],
        r#"test("logs in")"#,
    ));
    assert_eq!(fallback.source, NarrationSource::Deterministic);
    assert_eq!(fallback.detected_intent, ChangeIntent::TestHarness);
}

#[test]
fn llm_names_are_read_from_prose_and_failures_fall_back_to_deterministic_names() {
    let input = naming(
        Some("kmpqrstu"),
        "refactor: extract verifier",
        &["src/session.ts"],
        "function verifyCookie() {}",
    );
    let deterministic =
        JjrNarrator::new(None, JjrJevAssistant::offline()).suggest_change_name(&input);
    assert_eq!(
        deterministic.conventional_title,
        "refactor(session): refactor session"
    );
    assert_eq!(deterministic.bookmark_slug, "refactor/session");
    assert_eq!(deterministic.intent_confidence, 0.713);
    assert_eq!(
        deterministic.rationale,
        "Jev classified this change as \"structural\" (confidence 0.71) across 1 file(s)."
    );

    // JSON wrapped in prose, without a rationale.
    let chatty = Canned::new(
        Some(
            "Sure! {\"conventionalTitle\": \"refactor: x\", \"bookmarkSlug\": \"refactor/x\"} Hope it helps.",
        ),
        true,
    );
    let named = JjrNarrator::new(Some(chatty.clone()), JjrJevAssistant::offline())
        .suggest_change_name(&input);
    assert_eq!(named.source, NarrationSource::Llm);
    assert_eq!(named.conventional_title, "refactor: x");
    assert_eq!(named.rationale, "Classified as structural by Jev.");
    let prompts = chatty.prompts.lock().unwrap();
    assert!(
        prompts[0]
            .0
            .starts_with("You name Jujutsu (jj) changes. Return strict JSON")
    );
    assert_eq!(
        prompts[0].1,
        "Jev intent: structural (confidence 0.71), entangled=0.18\nTouched paths:\nsrc/session.ts\n\nDiff excerpt:\nfunction verifyCookie() {}"
    );

    // A reply without both keys, a failing call, and an unconfigured transport.
    for transport in [
        Canned::new(
            Some(r#"{"conventionalTitle": "x", "bookmarkSlug": ""}"#),
            true,
        ),
        Canned::new(None, true),
    ] {
        assert_eq!(
            JjrNarrator::new(Some(transport), JjrJevAssistant::offline())
                .suggest_change_name(&input),
            deterministic
        );
    }
    let unconfigured = Canned::new(Some("{}"), false);
    assert_eq!(
        JjrNarrator::new(Some(unconfigured.clone()), JjrJevAssistant::offline())
            .suggest_change_name(&input),
        deterministic
    );
    assert!(unconfigured.prompts.lock().unwrap().is_empty());

    let megamerge = JjrNarrator::new(None, JjrJevAssistant::offline())
        .suggest_change_name(&naming(None, "local: dev megamerge", &[], ""));
    assert_eq!(megamerge.detected_intent, ChangeIntent::Megamerge);
    assert_eq!(megamerge.conventional_title, "local: dev megamerge (core)");
    assert_eq!(megamerge.bookmark_slug, "");
}

#[test]
fn graph_feedback_and_dependency_critiques() {
    let narrator = JjrNarrator::new(None, JjrJevAssistant::offline());
    let clean = JjrGraph::new(
        vec![change("zzzzzzzz", &[], "trunk")],
        JjrRepoConfig::default(),
        None,
    );
    let feedback = narrator.explain_graph_feedback(&clean);
    assert_eq!(
        feedback.summary,
        "Your revision graph is clean: every mutable change is non-divergent and properly ordered."
    );
    assert!(feedback.suggestions.is_empty());
    assert_eq!(feedback.source, NarrationSource::Deterministic);

    // An empty change that is neither @ nor a blueprint.
    let mut empty = change("kkkkkkkk", &["zzzzzzzz"], "");
    empty.current_commit.is_empty = true;
    empty.current_commit.touched_paths.clear();
    let untidy = JjrGraph::new(
        vec![change("zzzzzzzz", &[], "trunk"), empty],
        JjrRepoConfig::default(),
        None,
    );
    let feedback = narrator.explain_graph_feedback(&untidy);
    assert_eq!(feedback.source, NarrationSource::Deterministic);
    assert_eq!(
        feedback.summary,
        "Found 1 hygiene suggestion(s) in mutable() that can tidy your stack before review."
    );
    assert_eq!(
        feedback.suggestions,
        [
            "Change kkkkkkkk is empty and undescribed (neither @ nor a stack blueprint). -> Try: `jj abandon kkkkkkkk`"
        ]
    );

    let llm = Canned::new(Some("  One empty change. Abandon it.  \n"), true);
    let feedback =
        JjrNarrator::new(Some(llm), JjrJevAssistant::offline()).explain_graph_feedback(&untidy);
    assert_eq!(feedback.source, NarrationSource::Llm);
    assert_eq!(feedback.summary, "One empty change. Abandon it.");
    let blank = Canned::new(Some("   "), true);
    let feedback =
        JjrNarrator::new(Some(blank), JjrJevAssistant::offline()).explain_graph_feedback(&untidy);
    assert_eq!(feedback.source, NarrationSource::Deterministic);

    let base = change("kkkkkkkkbase", &["zzzzzzzz"], "base");
    let child = change("mmmmmmmmchild", &["kkkkkkkkbase"], "child");
    let critique = |causal: f64, reviewable: f64| {
        narrator.critique_dependency(
            &base,
            &child,
            &DependencyAssessment {
                base: base.change_id.clone(),
                child: child.change_id.clone(),
                causal_probability: Some(causal),
                reviewability_probability: Some(reviewable),
                ..Default::default()
            },
        )
    };
    assert_eq!(
        critique(0.89, 0.85),
        "Keep mmmmmmmm stacked on kkkkkkkk: mmmmmmmm causally depends on kkkkkkkk, and kkkkkkkk is independently reviewable."
    );
    assert!(
        critique(0.52, 0.85).starts_with(
            "Confirm relationship between kkkkkkkk and mmmmmmmm: Calibrated confidence"
        )
    );
    assert_eq!(
        critique(0.12, 0.88),
        "No causal dependency between kkkkkkkk and mmmmmmmm. Linear stacking creates an artificial merge bottleneck. Suggested: `jj parallelize kkkkkkkkbase mmmmmmmmchild`."
    );
}
