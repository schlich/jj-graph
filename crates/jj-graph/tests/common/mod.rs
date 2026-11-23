//! Throwaway jj repositories for jj-graph's integration tests.

#![allow(dead_code)]

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use jj_graph::app::App;
use jj_graph::app::AppOptions;
use jj_graph::app::Query;
use jjr::jev::JjrJevAssistant;
use jjr::narrator::JjrNarrator;
use serde_json::Value;
use serde_json::json;

/// A jj repository in a temporary directory, removed when dropped.
pub struct TempRepo {
    pub dir: PathBuf,
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A new, empty, uniquely named directory under the system temp directory.
pub fn temp_dir(prefix: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(&dir).unwrap()
}

impl TempRepo {
    /// An empty `jj git init` repository with a test identity.
    pub fn new(prefix: &str) -> Self {
        let repo = Self {
            dir: temp_dir(prefix),
        };
        repo.jj(&["git", "init"]);
        repo.jj(&["config", "set", "--repo", "user.name", "Test"]);
        repo.jj(&["config", "set", "--repo", "user.email", "test@example.com"]);
        repo
    }

    /// base (main) ← feat a, and base ← feat b (the working copy, with fb.txt).
    pub fn two_arms(prefix: &str) -> Self {
        let repo = Self::new(prefix);
        repo.write("a.txt", "base\n");
        repo.jj(&["commit", "-m", "base"]);
        repo.jj(&["bookmark", "create", "main", "-r", "@-"]);
        repo.write("fa.txt", "a\n");
        repo.jj(&["commit", "-m", "feat a"]);
        repo.jj(&["new", "main", "-m", "feat b"]);
        repo.write("fb.txt", "b\n");
        repo
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    pub fn write(&self, name: &str, contents: &str) {
        std::fs::write(self.dir.join(name), contents).unwrap();
    }

    /// Run jj in the repository; panics unless it succeeds.
    pub fn jj(&self, args: &[&str]) -> String {
        let out = Command::new("jj")
            .args(["--color", "never", "--no-pager"])
            .args(args)
            .current_dir(&self.dir)
            .output()
            .expect("run jj");
        assert!(
            out.status.success(),
            "jj {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// An engine for this repository that never calls Jev or an LLM.
    pub fn app(&self) -> App {
        let jev = JjrJevAssistant::offline();
        App::new(
            &self.dir,
            AppOptions {
                jev: Some(jev.clone()),
                narrator: Some(JjrNarrator::new(None, jev)),
                ..Default::default()
            },
        )
    }
}

pub fn get_state(app: &mut App, revset: &str) -> Value {
    let query: Query = [("revset".to_owned(), revset.to_owned())]
        .into_iter()
        .collect();
    app.handle("GET", "/api/state", &query, None).unwrap()
}

pub fn get(app: &mut App, route: &str, params: &[(&str, &str)]) -> Result<Value, String> {
    let query: Query = params
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    app.handle("GET", route, &query, None)
        .map_err(|e| e.message)
}

pub fn post(app: &mut App, route: &str, body: Value) -> Result<Value, String> {
    let mut body = body;
    if body.get("revset").is_none() {
        body["revset"] = json!("all()");
    }
    app.handle("POST", route, &Query::new(), Some(&body))
        .map_err(|e| e.message)
}

/// The node whose description starts with `description`.
pub fn node<'a>(state: &'a Value, description: &str) -> &'a Value {
    try_node(state, description).unwrap_or_else(|| panic!("no node starting with {description:?}"))
}

pub fn try_node<'a>(state: &'a Value, description: &str) -> Option<&'a Value> {
    state["nodes"].as_array().unwrap().iter().find(|n| {
        n["description"]
            .as_str()
            .unwrap_or("")
            .starts_with(description)
    })
}

pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

pub fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|x| s(x).to_owned()).collect())
        .unwrap_or_default()
}
