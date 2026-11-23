//! The jj-graph engine: dry runs of jj commands, guarded by jjr, previewed
//! as operations that never enter the operation log until applied.
//!
//! Every previewed command runs as
//!   `jj --at-op <tip> --no-integrate-operation <command>`
//! which writes a real operation but leaves it out of the operation log, so
//! the repository, its Git refs and the working copy stay untouched. The
//! preview is read back with jj-lib at that operation. "Apply" is
//! `jj op integrate <tip>` followed by `jj workspace update-stale`;
//! "discard" just forgets the tip.
//!
//! Every step first passes the jjr guardrails, with the revisions it
//! rewrites resolved by jj itself and a pre-flight check of `trunk()` and
//! `immutable_heads()`. `jj fix` and `jj run --ignore-changes` verify
//! revisions for the Publishing Gate the same way, as operations that are
//! never kept.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;
use std::time::Instant;

use indexmap::IndexMap;
use jj_lib::repo::ReadonlyRepo;
use jjr::commands::describe_mutation;
use jjr::commands::parse_jj_args;
use jjr::graph::FromNodesOptions;
use jjr::graph::GraphNode;
use jjr::graph::ImmutableHeadsFact;
use jjr::graph::JjrGraph;
use jjr::graph::PreflightFacts;
use jjr::graph::TrunkFact;
use jjr::guardrails::BookmarkTargets;
use jjr::guardrails::GuardrailAction;
use jjr::guardrails::GuardrailResult;
use jjr::guardrails::JjrGuardrailPipeline;
use jjr::guardrails::MutateAction;
use jjr::guardrails::ResolvedTarget;
use jjr::jev::ChangeContext;
use jjr::jev::ChangeTriageInput;
use jjr::jev::JjrJevAssistant;
use jjr::narrator::JjrNarrator;
use jjr::narrator::NamingInput;
use jjr::runner::FormatterSummary;
use jjr::runner::JjrRunner;
use jjr::runner::StackVerification;
use jjr::runner::VerificationCounts;
use jjr::runner::VerificationResult;
use jjr::types::ForgeKind;
use jjr::types::JjrRepoConfig;
use jjr::types::MergeSameChange;
use jjr::types::VerificationState;
use jjr::types::VerificationStatus;
use jjr::types::verification_state;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

use crate::error::AppError;
use crate::error::AppResult;
use crate::jj::JjCli;
use crate::jj::JjRun;
use crate::repo::OpEntry;
use crate::repo::RepoContext;

pub const MAX_NODES: usize = 400;
const MAX_ELIDED_LOOKUPS: usize = 24;
const PREFLIGHT_TTL: Duration = Duration::from_secs(5);
const MAX_VERIFY: usize = 30;
const VERIFY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CACHE_SIZE: usize = 24;

/// Commands a dry run may contain: ones that only rewrite the repository.
/// Anything with effects outside it (git push/fetch), anything interactive,
/// and anything that manages operations or workspaces is left out. `split`
/// qualifies only with paths, `converge` only with --no-interactive.
pub const ALLOWED: &[&str] = &[
    "abandon",
    "absorb",
    "bookmark",
    "converge",
    "describe",
    "duplicate",
    "edit",
    "fix",
    "metaedit",
    "new",
    "next",
    "parallelize",
    "prev",
    "rebase",
    "restore",
    "revert",
    "simplify-parents",
    "split",
    "squash",
    "tag",
];
/// Commands that can make new changes, whose ids differ on every run.
const CREATORS: &[&str] = &["new", "duplicate", "revert", "squash", "split", "metaedit"];
const FORBIDDEN_FLAGS: &[&str] = &[
    "-i",
    "--interactive",
    "--tool",
    "--editor",
    "-R",
    "--repository",
    "--at-op",
    "--at-operation",
    "--no-integrate-operation",
    "--ignore-working-copy",
    "--config",
    "--config-file",
    // jjr never force-rewrites immutable() history.
    "--ignore-immutable",
];
/// Options naming only where a change goes, not a change being edited.
const DEST: &[&str] = &[
    "-o",
    "-d",
    "--onto",
    "--destination",
    "-A",
    "-B",
    "--insert-after",
    "--insert-before",
    "--after",
    "--before",
];

static FULL_CHANGE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[k-z]{32}$").unwrap());
static FULL_COMMIT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40}$").unwrap());
static PLAIN_ARG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_@./:=+-]+$").unwrap());
static OP_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{8,128}$").unwrap());
static REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-z]{4,64}$").unwrap());
static REV_CONTEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-z@+-]{1,64}$").unwrap());
static UNINTEGRATED_OP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"--no-integrate-operation was requested: ([0-9a-f]+)").unwrap());
static FIXED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Fixed (\d+) commits? of (\d+) checked").unwrap());

/// Shorten full change and commit ids so a command fits on a phone.
pub fn display_command<S: AsRef<str>>(args: &[S]) -> String {
    let words: Vec<String> = args
        .iter()
        .map(|a| {
            let a = a.as_ref();
            if FULL_CHANGE_ID.is_match(a) || FULL_COMMIT_ID.is_match(a) {
                a[..8].to_owned()
            } else if PLAIN_ARG.is_match(a) {
                a.to_owned()
            } else {
                serde_json::to_string(a).unwrap_or_default()
            }
        })
        .collect();
    format!("jj {}", words.join(" "))
}

/// Check that a command may run as a dry run; returns the argv to run.
pub fn validate_args(args: &[String]) -> AppResult<Vec<String>> {
    if args.is_empty() {
        return Err(AppError::bad("A command is a non-empty list of strings."));
    }
    // Rewinding the repository is itself an operation, so it previews too.
    let rewind = ["op", "operation"].contains(&args[0].as_str())
        && args.get(1).is_some_and(|a| a == "restore" || a == "revert");
    if !ALLOWED.contains(&args[0].as_str()) && !rewind {
        return Err(AppError::bad(format!(
            "\"jj {}\" cannot be dry-run here. Allowed: {}, op restore, op revert.",
            args[0],
            ALLOWED.join(", ")
        )));
    }
    for a in args {
        let flag = a.split('=').next().unwrap_or_default();
        if FORBIDDEN_FLAGS.contains(&flag) {
            return Err(AppError::bad(format!(
                "The flag {flag} is not allowed in a dry run."
            )));
        }
    }
    if args[0] == "split" && parse_jj_args(args).positional.is_empty() {
        return Err(AppError::bad(
            "\"jj split\" needs paths to run without its interactive editor, for example: split --parallel src/impl.js",
        ));
    }
    // Without --no-interactive, jj converge prompts.
    if args[0] == "converge" && !args.iter().any(|a| a == "--no-interactive") {
        let mut out = args.to_vec();
        out.push("--no-interactive".into());
        return Ok(out);
    }
    Ok(args.to_vec())
}

/// Split a typed command line into arguments, honouring quotes.
pub fn split_command_line(line: &str) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else if ch == '\\' && q == '"' && chars.peek().is_some() {
                cur.push(chars.next().unwrap());
            } else {
                cur.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started || !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            started = false;
        } else {
            cur.push(ch);
        }
    }
    if quote.is_some() {
        return Err(AppError::bad("Unclosed quote in command."));
    }
    if started || !cur.is_empty() {
        out.push(cur);
    }
    if out.first().is_some_and(|w| w == "jj") {
        out.remove(0);
    }
    Ok(out)
}

/// One dry-run step: the command, its label, the operation it wrote, jj's
/// output, and the change ids it created (renamed when the plan replays).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub args: Vec<String>,
    pub label: String,
    pub op: String,
    pub output: String,
    pub created: Vec<String>,
}

/// The dry run: the operation it started from, its steps, and undone steps.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub base: Option<String>,
    pub steps: Vec<Step>,
    pub redo: Vec<Step>,
}

/// What a step does when run: an operation, or nothing.
struct ExecResult {
    op: Option<String>,
    output: String,
    created: Vec<String>,
}

/// Request parameters (`?revset=...&at=...`).
pub type Query = BTreeMap<String, String>;

/// Options for [`App::new`].
#[derive(Default)]
pub struct AppOptions {
    /// The build-and-test command for "Verify stack"; else `jj config get jjr.verify-command`.
    pub verify_command: Option<String>,
    pub pipeline: Option<JjrGuardrailPipeline>,
    pub jev: Option<JjrJevAssistant>,
    pub narrator: Option<JjrNarrator>,
}

/// A small cache that forgets its oldest entry past `CACHE_SIZE`.
struct Cache<V> {
    map: IndexMap<String, V>,
    cap: usize,
}

impl<V: Clone> Cache<V> {
    fn new(cap: usize) -> Self {
        Self {
            map: IndexMap::new(),
            cap,
        }
    }

    fn get(&self, key: &str) -> Option<V> {
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: String, value: V) {
        self.map.insert(key, value);
        while self.map.len() > self.cap {
            self.map.shift_remove_index(0);
        }
    }
}

/// The repository loaded for one request, with repos cached by operation.
struct Session {
    ctx: RepoContext,
    repos: RefCell<HashMap<String, Arc<ReadonlyRepo>>>,
}

impl Session {
    fn load(root: &Path) -> AppResult<Self> {
        Ok(Self {
            ctx: RepoContext::load(root)?,
            repos: RefCell::new(HashMap::new()),
        })
    }

    fn repo(&self, op: &str) -> AppResult<Arc<ReadonlyRepo>> {
        if let Some(repo) = self.repos.borrow().get(op) {
            return Ok(repo.clone());
        }
        let repo = self.ctx.repo_at_id(op)?;
        self.repos.borrow_mut().insert(op.to_owned(), repo.clone());
        Ok(repo)
    }
}

fn check_op(at: Option<&str>) -> AppResult<Option<String>> {
    match at {
        None | Some("") => Ok(None),
        Some(at) if OP_ID.is_match(at) => Ok(Some(at.to_owned())),
        Some(_) => Err(AppError::bad("Bad operation id.")),
    }
}

fn tail(text: &str, n: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > n {
        format!("…{}", chars[chars.len() - n..].iter().collect::<String>())
            .trim()
            .to_owned()
    } else {
        text.trim().to_owned()
    }
}

fn now_iso() -> String {
    jiff::Timestamp::now()
        .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn body_str<'a>(body: Option<&'a Value>, key: &str) -> Option<&'a str> {
    body.and_then(|b| b.get(key)).and_then(Value::as_str)
}

fn body_strings(value: &Value) -> AppResult<Vec<String>> {
    let Some(list) = value.as_array() else {
        return Err(AppError::bad("A command is a non-empty list of strings."));
    };
    list.iter()
        .map(|v| {
            v.as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| AppError::bad("A command is a non-empty list of strings."))
        })
        .collect()
}

/// The jj-graph engine for one repository.
pub struct App {
    root: PathBuf,
    jj: JjCli,
    verify_command: Option<String>,
    plan: Plan,
    views: Cache<Vec<GraphNode>>,
    ops: Cache<Vec<OpEntry>>,
    preflights: Cache<(Instant, PreflightFacts)>,
    /// Verification results by commit id: a result holds for that snapshot only.
    verifications: IndexMap<String, VerificationStatus>,
    default_revset: Option<String>,
    pipeline: JjrGuardrailPipeline,
    jev: JjrJevAssistant,
    narrator: JjrNarrator,
    runner: JjrRunner,
}

impl App {
    /// An engine for the workspace at `root`.
    pub fn new(root: &Path, options: AppOptions) -> Self {
        let pipeline = options.pipeline.unwrap_or_default();
        let jev = options.jev.unwrap_or_else(JjrJevAssistant::from_env);
        let narrator = options
            .narrator
            .unwrap_or_else(|| JjrNarrator::from_env(jev.clone()));
        let runner = JjrRunner::new(pipeline.clone(), jev.clone(), narrator.clone());
        Self {
            root: root.to_owned(),
            jj: JjCli::new(root),
            verify_command: options.verify_command,
            plan: Plan::default(),
            views: Cache::new(CACHE_SIZE),
            ops: Cache::new(CACHE_SIZE),
            preflights: Cache::new(32),
            verifications: IndexMap::new(),
            default_revset: None,
            pipeline,
            jev,
            narrator,
            runner,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    pub fn jev(&self) -> &JjrJevAssistant {
        &self.jev
    }

    pub fn pipeline(&self) -> &JjrGuardrailPipeline {
        &self.pipeline
    }

    pub fn jj(&self) -> &JjCli {
        &self.jj
    }

    fn tip(&self) -> Option<String> {
        self.plan.steps.last().map(|s| s.op.clone())
    }

    fn head_op(&self, s: &Session) -> AppResult<String> {
        Ok(s.ctx.head_op()?.id().to_string())
    }

    /// Record working-copy edits as an operation, then return the head operation.
    fn snapshot(&self, s: &Session) -> AppResult<String> {
        self.jj.run(
            &["util", "snapshot"],
            JjRun {
                ok: &[0, 1],
                ..Default::default()
            },
        )?;
        self.head_op(s)
    }

    fn default_revset(&mut self, s: &Session) -> String {
        if self.default_revset.is_none() {
            self.default_revset = Some(
                s.ctx
                    .config_string("revsets.log")
                    .unwrap_or_else(|| "all()".into()),
            );
        }
        self.default_revset
            .clone()
            .unwrap_or_else(|| "all()".into())
    }

    /// Pre-flight check: where `trunk()` and `immutable_heads()` resolve at
    /// `op`, whether anything mutable is divergent, and repository facts the
    /// guardrails need.
    fn preflight(&mut self, s: &Session, op: &str) -> AppResult<PreflightFacts> {
        if let Some((at, value)) = self.preflights.get(op)
            && at.elapsed() < PREFLIGHT_TTL
        {
            return Ok(value);
        }
        let repo = s.repo(op)?;
        let ctx = &s.ctx;
        let trunk = match ctx.preflight_rows(&repo, "trunk()", 1) {
            Ok(rows) => match rows.into_iter().next() {
                Some(row) => TrunkFact::resolved(row),
                None => TrunkFact::unresolved("trunk() resolves to no revision"),
            },
            Err(err) => TrunkFact::unresolved(err.0),
        };
        let immutable_heads = match ctx.preflight_rows(&repo, "immutable_heads()", 50) {
            Ok(rows) => ImmutableHeadsFact::resolved(rows),
            Err(err) => ImmutableHeadsFact::unresolved(err.0),
        };
        let divergent = ctx
            .change_ids(&repo, "divergent() & mutable()", Some(50))
            .unwrap_or_default();
        let merge_same_change = ctx
            .config_string("merge.same-change")
            .map_or(MergeSameChange::Accept, |v| {
                MergeSameChange::parse(&v).unwrap_or(MergeSameChange::Keep)
            });
        let forge = ctx
            .config_string("jjr.forge")
            .and_then(|f| ForgeKind::parse(&f))
            .unwrap_or(ForgeKind::GithubBookmarks);
        let facts = ctx.repo_facts(&repo);
        let value = PreflightFacts {
            op: Some(op.to_owned()),
            trunk,
            immutable_heads,
            divergent,
            merge_same_change: Some(merge_same_change),
            forge: Some(forge),
            colocated: Some(facts.colocated),
            remotes: facts.remotes,
            git_compat: facts.git_compat,
            keep_refs: facts.keep_refs,
        };
        self.preflights
            .insert(op.to_owned(), (Instant::now(), value.clone()));
        Ok(value)
    }

    /// The verification records that still apply to the commits shown.
    fn verifications_for(&self, nodes: &[GraphNode]) -> HashMap<String, VerificationStatus> {
        nodes
            .iter()
            .filter_map(|n| {
                self.verifications
                    .get(&n.id)
                    .map(|v| (n.change.clone(), v.clone()))
            })
            .collect()
    }

    fn build_graph(&self, nodes: &[GraphNode], pre: &PreflightFacts) -> JjrGraph {
        let config = JjrRepoConfig {
            merge_same_change: pre.merge_same_change.unwrap_or(MergeSameChange::Accept),
            colocated: pre.colocated.unwrap_or(true),
            forge: pre.forge.unwrap_or(ForgeKind::GithubBookmarks),
            ..JjrRepoConfig::default()
        };
        JjrGraph::from_nodes(
            nodes,
            FromNodesOptions {
                config,
                verifications: self.verifications_for(nodes),
                preflight: Some(pre.clone()),
                ..Default::default()
            },
        )
    }

    /// Revision nodes of `revset` at `op`, cached by both.
    fn view(&mut self, s: &Session, op: &str, revset: &str) -> AppResult<Vec<GraphNode>> {
        let key = format!("{op}\n{revset}");
        if let Some(nodes) = self.views.get(&key) {
            return Ok(nodes);
        }
        let repo = s.repo(op)?;
        let nodes = s
            .ctx
            .read_nodes(&repo, revset, MAX_NODES, MAX_ELIDED_LOOKUPS)?;
        self.views.insert(key, nodes.clone());
        Ok(nodes)
    }

    fn graph_at(&mut self, s: &Session, op: &str, revset: &str) -> AppResult<JjrGraph> {
        let nodes = self.view(s, op, revset)?;
        let pre = self.preflight(s, op)?;
        Ok(self.build_graph(&nodes, &pre))
    }

    /// The newest operations, newest first: the repository's own history.
    fn operations(&mut self, s: &Session, head: &str) -> AppResult<Vec<OpEntry>> {
        if let Some(ops) = self.ops.get(head) {
            return Ok(ops);
        }
        let op = s.ctx.op(head)?;
        let ops = s.ctx.operations(&op, 24)?;
        self.ops.insert(head.to_owned(), ops.clone());
        Ok(ops)
    }

    /// Run the guardrails on one dry-run step, with its revisions resolved by jj.
    fn guard(&mut self, s: &Session, args: &[String], op: &str) -> AppResult<GuardrailResult> {
        let m = describe_mutation(args);
        let repo = s.repo(op)?;
        let targets = s.ctx.resolve_targets(&repo, &m.rewrites);
        let bookmark_targets: Vec<Option<Vec<crate::repo::ResolvedRow>>> = m
            .bookmarks
            .iter()
            .map(|b| {
                s.ctx
                    .resolve_targets(&repo, std::slice::from_ref(&b.target))
            })
            .collect();
        let graph = self.graph_at(s, op, "all()")?;
        let action = GuardrailAction::Mutate(MutateAction {
            args: Some(args.to_vec()),
            command: display_command(args),
            target_changes: match &targets {
                Some(t) => t
                    .iter()
                    .map(|t| {
                        if t.divergent {
                            t.commit_id.clone()
                        } else {
                            t.change_id.clone()
                        }
                    })
                    .collect(),
                None => m.rewrites.clone(),
            },
            resolved_targets: targets
                .unwrap_or_default()
                .into_iter()
                .map(|t| ResolvedTarget {
                    change_id: t.change_id,
                    commit_id: t.commit_id,
                    immutable: t.immutable,
                    divergent: t.divergent,
                    in_trunk: t.in_trunk,
                })
                .collect(),
            ignore_immutable: Some(m.ignore_immutable),
            recovery: Some(m.recovery),
            bookmarks: m
                .bookmarks
                .iter()
                .zip(bookmark_targets)
                .map(|(b, targets)| BookmarkTargets {
                    names: b.names.clone(),
                    target_changes: targets
                        .unwrap_or_default()
                        .into_iter()
                        .map(|t| t.change_id)
                        .collect(),
                })
                .collect(),
        });
        Ok(self.pipeline.evaluate(&graph, &action))
    }

    /// The full state the web UI draws: the graph of `revset` (the dry run's
    /// preview while one is open, or an earlier operation with `at`), the
    /// operation log, and jjr's reading of it.
    pub fn state(&mut self, revset: Option<&str>, at: Option<&str>) -> AppResult<Value> {
        let s = Session::load(&self.root)?;
        self.state_in(&s, revset, at)
    }

    fn state_in(
        &mut self,
        s: &Session,
        revset_arg: Option<&str>,
        at_arg: Option<&str>,
    ) -> AppResult<Value> {
        let default_revset = self.default_revset(s);
        let revset = revset_arg
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map_or_else(|| default_revset.clone(), ToOwned::to_owned);
        let at = check_op(at_arg)?;
        let head = self.snapshot(s)?;
        let stale = self.rebase_plan(s, &head).err().map(|err| err.message);
        let dry = !self.plan.steps.is_empty();
        // `at` looks back at an earlier operation; it never shows the plan.
        let view_op = at.clone().unwrap_or_else(|| {
            if dry {
                self.tip().unwrap_or_else(|| head.clone())
            } else {
                head.clone()
            }
        });
        let nodes = self.view(s, &view_op, &revset)?;
        let pre = self.preflight(s, &view_op)?;
        let baseline = match (&self.plan.base, dry && at.is_none()) {
            (Some(base), true) => {
                let base = base.clone();
                let mut map = serde_json::Map::new();
                for n in self.view(s, &base, &revset)? {
                    map.insert(n.change.clone(), Value::String(n.id.clone()));
                }
                Value::Object(map)
            }
            _ => Value::Null,
        };
        // `jj new` names only parents, so everything it lists is a destination.
        let named = |args: &[String]| -> Vec<String> {
            if args.first().is_some_and(|a| a == "new") {
                return Vec::new();
            }
            args.iter()
                .enumerate()
                .filter(|(i, a)| {
                    FULL_CHANGE_ID.is_match(a) && !(*i > 0 && DEST.contains(&args[i - 1].as_str()))
                })
                .map(|(_, a)| a.clone())
                .collect()
        };
        let mut touched: Vec<String> = Vec::new();
        for step in &self.plan.steps {
            for id in named(&step.args)
                .into_iter()
                .chain(step.created.iter().cloned())
            {
                if !touched.contains(&id) {
                    touched.push(id);
                }
            }
        }
        let graph = self.build_graph(&nodes, &pre);
        let verification: serde_json::Map<String, Value> = nodes
            .iter()
            .filter(|n| !n.immutable)
            .map(|n| {
                (
                    n.change.clone(),
                    json(&verification_state(self.verifications.get(&n.id))),
                )
            })
            .collect();
        let ops = self.operations(s, &head)?;
        Ok(json!({
            "repo": s.ctx.workspace_root().display().to_string(),
            "revset": revset,
            "defaultRevset": default_revset,
            "head": head,
            "viewing": at,
            "ops": ops,
            "truncated": nodes.len() >= MAX_NODES,
            "nodes": nodes,
            "baseline": baseline,
            "jjr": {
                "summary": graph.summary(),
                "diagnostics": graph.diagnose(),
                "jevMode": self.jev.mode(),
                "preflight": pre,
                "verification": verification,
            },
            // Changes a step names or creates; the rest of what moved only followed.
            "rewound": self.plan.steps.iter().any(|s| s.args[0].starts_with("op")),
            "touched": touched,
            "dry": {
                "active": dry,
                "base": self.plan.base,
                "stale": stale,
                "steps": self.plan.steps.iter().map(|s| json!({ "label": s.label, "output": s.output })).collect::<Vec<_>>(),
                "redo": self.plan.redo.iter().map(|s| s.label.clone()).collect::<Vec<_>>(),
            },
        }))
    }

    fn mutable_changes(&self, s: &Session, op: &str) -> AppResult<Vec<String>> {
        let repo = s.repo(op)?;
        Ok(s.ctx.change_ids(&repo, "mutable()", None)?)
    }

    /// Run one command on top of operation `at` without integrating it.
    /// `op` is `None` when jj reports that nothing changed. `created` lists
    /// the change ids the command made, so later steps that name them can be
    /// replayed against the ids a re-run produces.
    fn exec(&self, s: &Session, args: &[String], at: &str) -> AppResult<ExecResult> {
        let mut argv = vec!["--no-integrate-operation".to_owned()];
        argv.extend(args.iter().cloned());
        let out = self.jj.run(
            &argv,
            JjRun {
                at_op: Some(at),
                ..Default::default()
            },
        )?;
        let op = UNINTEGRATED_OP
            .captures(&out.stderr)
            .map(|c| c[1].to_owned());
        let output = format!("{}{}", out.stdout, out.stderr)
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with("Operation left uncommitted"))
            .collect::<Vec<_>>()
            .join("\n");
        let Some(op) = op else {
            return Ok(ExecResult {
                op: None,
                output: if output.is_empty() {
                    "Nothing changed.".into()
                } else {
                    output
                },
                created: Vec::new(),
            });
        };
        let mut created = Vec::new();
        if CREATORS.contains(&args[0].as_str()) {
            let before = self.mutable_changes(s, at)?;
            created = self
                .mutable_changes(s, &op)?
                .into_iter()
                .filter(|c| !before.contains(c))
                .collect();
        }
        Ok(ExecResult {
            op: Some(op),
            output,
            created,
        })
    }

    /// Re-run steps on top of `from`, renaming the changes they create.
    fn replay(
        &self,
        s: &Session,
        steps: &[Step],
        from: &str,
        renames: &mut HashMap<String, String>,
    ) -> AppResult<Vec<Step>> {
        let mut out = Vec::new();
        let mut at = from.to_owned();
        for (i, step) in steps.iter().enumerate() {
            let args: Vec<String> = step
                .args
                .iter()
                .map(|a| renames.get(a).cloned().unwrap_or_else(|| a.clone()))
                .collect();
            let r = self.exec(s, &args, &at).map_err(|err| {
                AppError::bad(format!(
                    "Step {} ({}) no longer applies: {}",
                    i + 1,
                    step.label,
                    err.message
                ))
            })?;
            let Some(op) = r.op else { continue }; // the repository already has this step's effect
            for (k, old) in step.created.iter().enumerate() {
                if let Some(new) = r.created.get(k) {
                    renames.insert(old.clone(), new.clone());
                }
            }
            at = op.clone();
            out.push(Step {
                label: display_command(&args),
                args,
                op,
                output: r.output,
                created: r.created,
            });
        }
        Ok(out)
    }

    /// Keep the plan based on the repository's latest operation. Integrating
    /// a plan built on an older one would count as a concurrent operation
    /// and leave divergent changes, for example after a file was edited.
    fn rebase_plan(&mut self, s: &Session, head: &str) -> AppResult<()> {
        if self.plan.steps.is_empty() || self.plan.base.as_deref() == Some(head) {
            return Ok(());
        }
        let mut renames = HashMap::new();
        let steps = self.replay(s, &self.plan.steps, head, &mut renames)?;
        self.plan.steps = steps;
        for step in &mut self.plan.redo {
            step.args = step
                .args
                .iter()
                .map(|a| renames.get(a).cloned().unwrap_or_else(|| a.clone()))
                .collect();
        }
        self.plan.base = if self.plan.steps.is_empty() {
            None
        } else {
            Some(head.to_owned())
        };
        Ok(())
    }

    /// The graph a jjr endpoint reasons about: at `at`, the dry run's tip, or now.
    fn current_graph(
        &mut self,
        s: &Session,
        revset_arg: Option<&str>,
        at_arg: Option<&str>,
    ) -> AppResult<(JjrGraph, String)> {
        let default_revset = self.default_revset(s);
        let revset = revset_arg
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map_or(default_revset, ToOwned::to_owned);
        let op = match (check_op(at_arg)?, self.tip()) {
            (Some(at), _) => at,
            (None, Some(tip)) => tip,
            (None, None) => self.snapshot(s)?,
        };
        let graph = self.graph_at(s, &op, &revset)?;
        Ok((graph, op))
    }

    /// The diff and touched paths of a revision, for Jev and the narrator.
    fn revision_context(
        &self,
        s: &Session,
        rev: &str,
        op: &str,
    ) -> AppResult<(String, Vec<String>)> {
        if !REV_CONTEXT.is_match(rev) {
            return Err(AppError::bad("Bad revision."));
        }
        let repo = s.repo(op)?;
        // Like `jj show` failing quietly: no diff is still something to triage.
        let (diff, paths) = s.ctx.git_diff(&repo, rev).unwrap_or_default();
        Ok((diff.chars().take(8000).collect(), paths))
    }

    /// Add a command to the plan as a dry run.
    pub fn dry_run(&mut self, raw_args: &[String]) -> AppResult<Value> {
        let s = Session::load(&self.root)?;
        self.dry_run_in(&s, raw_args)
    }

    fn dry_run_in(&mut self, s: &Session, raw_args: &[String]) -> AppResult<Value> {
        let args = validate_args(raw_args)?;
        let head = self.snapshot(s)?;
        self.rebase_plan(s, &head)?;
        // Every step passes the guardrails, including ones that name no
        // revision (`jj new` still stacks work, which divergence must halt).
        let at = self.tip().unwrap_or_else(|| head.clone());
        let verdict = self.guard(s, &args, &at)?;
        if !verdict.allowed {
            let first = &verdict.blockers[0];
            return Err(AppError::bad(format!(
                "{}: {}{}",
                first.rule_name,
                first.message,
                first
                    .remediation
                    .as_ref()
                    .map(|r| format!(" {r}"))
                    .unwrap_or_default()
            )));
        }
        let warnings: Vec<Value> = verdict
            .warnings
            .iter()
            .map(|w| json!({ "rule": w.rule_name, "message": w.message, "remediation": w.remediation }))
            .collect();
        if self.plan.steps.is_empty() {
            self.plan.base = Some(head.clone());
        }
        let at = self
            .tip()
            .or_else(|| self.plan.base.clone())
            .unwrap_or(head);
        let r = self.exec(s, &args, &at)?;
        let Some(op) = r.op else {
            return Ok(json!({ "changed": false, "output": r.output, "warnings": warnings }));
        };
        self.plan.steps.push(Step {
            label: display_command(&args),
            args,
            op,
            output: r.output.clone(),
            created: r.created,
        });
        self.plan.redo.clear();
        Ok(json!({ "changed": true, "output": r.output, "warnings": warnings }))
    }

    /// The configured build-and-test command: the option, then `jj config get jjr.verify-command`.
    fn verify_command_for(&self, s: &Session) -> Option<String> {
        self.verify_command
            .clone()
            .or_else(|| s.ctx.config_string("jjr.verify-command"))
    }

    /// Verify the mutable revisions of `range` as they stand in the dry run
    /// (or the repository): formatting with a `jj fix` that is never
    /// integrated, attributed per revision by interdiff, and the verify
    /// command in each revision with `jj run --ignore-changes`. Results are
    /// kept by commit id and feed the Publishing Gate.
    pub fn verify(&mut self, range: Option<&str>) -> AppResult<StackVerification> {
        let s = Session::load(&self.root)?;
        self.verify_in(&s, range)
    }

    fn verify_in(&mut self, s: &Session, range_arg: Option<&str>) -> AppResult<StackVerification> {
        let head = self.snapshot(s)?;
        // A stale plan is verified as it stands.
        let _ = self.rebase_plan(s, &head);
        let op = self.tip().unwrap_or(head);
        let range = range_arg
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("trunk()..@")
            .to_owned();
        let revs = format!("({range}) & mutable()");
        let command = self.verify_command_for(s);
        let repo = s.repo(&op)?;
        let all = s.ctx.verify_targets(&repo, &revs)?;
        let targets: Vec<_> = all.iter().take(MAX_VERIFY).cloned().collect();

        let mut formatter = FormatterSummary {
            configured: s.ctx.has_table_entries("fix.tools"),
            ..Default::default()
        };
        let mut formatting: HashMap<String, (Option<bool>, Vec<String>)> = HashMap::new();
        if !targets.is_empty() && !formatter.configured {
            // Nothing to format with: jj fix errors out, and every revision is as formatted as it gets.
            for t in &targets {
                formatting.insert(t.commit_id.clone(), (Some(true), Vec::new()));
            }
        } else if !targets.is_empty() {
            let fixed = self.jj.run(
                &[
                    "--no-integrate-operation".to_owned(),
                    "fix".into(),
                    "-s".into(),
                    format!("roots({revs})"),
                ],
                JjRun {
                    at_op: Some(&op),
                    ..Default::default()
                },
            );
            match fixed {
                Ok(res) => {
                    if let Some(m) = FIXED.captures(&res.stderr) {
                        formatter.fixed = m[1].parse().unwrap_or(0);
                        formatter.checked = m[2].parse().unwrap_or(0);
                    }
                    let fix_op = UNINTEGRATED_OP
                        .captures(&res.stderr)
                        .map(|c| c[1].to_owned());
                    let fix_repo = match &fix_op {
                        Some(fix_op) if formatter.fixed > 0 => Some(s.repo(fix_op)),
                        _ => None,
                    };
                    match fix_repo {
                        None => {
                            for t in &targets {
                                formatting.insert(t.commit_id.clone(), (Some(true), Vec::new()));
                            }
                        }
                        Some(Err(err)) => formatter.error = Some(err.message),
                        Some(Ok(fix_repo)) => {
                            for t in &targets {
                                if t.divergent {
                                    formatting.insert(t.commit_id.clone(), (None, Vec::new()));
                                    continue;
                                }
                                match s.ctx.interdiff_paths(&fix_repo, &t.commit_id, &t.change_id) {
                                    Ok(files) => {
                                        formatting.insert(
                                            t.commit_id.clone(),
                                            (Some(files.is_empty()), files),
                                        );
                                    }
                                    Err(err) => {
                                        formatter.error = Some(err.0);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(err) => formatter.error = Some(err.message),
            }
        }

        let mut results = Vec::new();
        for t in &targets {
            let (formatted, files) = formatting
                .get(&t.commit_id)
                .cloned()
                .unwrap_or((None, Vec::new()));
            let mut passed = None;
            let mut output = String::new();
            if let Some(command) = &command {
                let run = self.jj.run(
                    &[
                        "run",
                        "--ignore-changes",
                        "--passthrough",
                        "--root",
                        "-r",
                        t.commit_id.as_str(),
                        "--",
                        "sh",
                        "-c",
                        command.as_str(),
                    ],
                    JjRun {
                        at_op: Some(&op),
                        ok: &[0, 1],
                        timeout: Some(VERIFY_TIMEOUT),
                    },
                );
                match run {
                    Ok(r) => {
                        passed = Some(r.code == 0);
                        output = tail(&format!("{}{}", r.stdout, r.stderr), 1500);
                    }
                    Err(err) => {
                        passed = Some(false);
                        output = tail(&err.message, 1500);
                    }
                }
            }
            let record = VerificationStatus {
                formatted,
                builds: passed,
                tests_pass: passed,
                verified: Some(command.is_some() && formatted.is_some()),
                checked_at_commit: Some(t.commit_id.clone()),
                command: command.clone(),
                unformatted_files: files.clone(),
                checked_at: Some(now_iso()),
            };
            let state = verification_state(Some(&record));
            self.verifications.shift_remove(&t.commit_id);
            self.verifications.insert(t.commit_id.clone(), record);
            results.push(VerificationResult {
                change_id: t.change_id.clone(),
                commit_id: t.commit_id.clone(),
                title: t.title.clone(),
                state,
                formatted,
                tests_pass: passed,
                unformatted_files: files,
                output,
            });
        }
        while self.verifications.len() > 500 {
            self.verifications.shift_remove_index(0);
        }
        let count = |state: VerificationState| results.iter().filter(|r| r.state == state).count();
        let summary = VerificationCounts {
            green: count(VerificationState::Green),
            red: count(VerificationState::Red),
            unknown: count(VerificationState::Unknown),
        };
        Ok(StackVerification {
            op,
            range,
            hint: command.is_none().then(|| {
                "No verify command is set, so build and test results stay unknown. Set one with: jj config set --repo jjr.verify-command 'npm test'".to_owned()
            }),
            command,
            formatter,
            skipped: all.len() - targets.len(),
            summary,
            results,
        })
    }

    fn undo(&mut self) {
        if let Some(step) = self.plan.steps.pop() {
            self.plan.redo.push(step);
        }
        if self.plan.steps.is_empty() {
            self.plan.base = None;
        }
    }

    fn redo(&mut self, s: &Session) -> AppResult<()> {
        if self.plan.redo.is_empty() {
            return Ok(());
        }
        let head = self.snapshot(s)?;
        self.rebase_plan(s, &head)?;
        if self.plan.steps.is_empty() {
            self.plan.base = Some(head.clone());
        }
        let step = self.plan.redo.pop().expect("redo is not empty");
        let mut renames = HashMap::new();
        let from = self
            .tip()
            .or_else(|| self.plan.base.clone())
            .unwrap_or(head);
        let replayed = self.replay(s, std::slice::from_ref(&step), &from, &mut renames);
        let replayed = match replayed {
            Ok(r) => r,
            Err(err) => {
                // A step that no longer applies stays undone.
                self.plan.redo.push(step);
                if self.plan.steps.is_empty() {
                    self.plan.base = None;
                }
                return Err(err);
            }
        };
        self.plan.steps.extend(replayed);
        for s in &mut self.plan.redo {
            s.args = s
                .args
                .iter()
                .map(|a| renames.get(a).cloned().unwrap_or_else(|| a.clone()))
                .collect();
        }
        if self.plan.steps.is_empty() {
            self.plan.base = None;
        }
        Ok(())
    }

    pub fn discard(&mut self) {
        self.plan = Plan::default();
    }

    fn apply(&mut self, s: &Session) -> AppResult<Value> {
        if self.plan.steps.is_empty() {
            return Err(AppError::bad("There is no dry run to apply."));
        }
        let before = self.snapshot(s)?;
        self.rebase_plan(s, &before)?;
        let Some(tip) = self.tip() else {
            return Err(AppError::bad("The repository already matches the dry run."));
        };
        self.jj
            .run(&["op", "integrate", tip.as_str()], JjRun::default())?;
        let count = self.plan.steps.len();
        self.discard();
        // The working copy is now behind the operation log; bring it forward.
        let out = self.jj.run(
            &["workspace", "update-stale"],
            JjRun {
                ok: &[0, 1],
                ..Default::default()
            },
        )?;
        Ok(json!({ "applied": count, "undoOp": before, "output": out.stderr.trim() }))
    }

    fn restore(&mut self, op: Option<&str>) -> AppResult<Value> {
        let op = op
            .filter(|op| OP_ID.is_match(op))
            .ok_or_else(|| AppError::bad("Bad operation id."))?;
        let out = self.jj.run(&["op", "restore", op], JjRun::default())?;
        self.discard();
        Ok(json!({ "output": out.stderr.trim() }))
    }

    /// Undo or redo until the plan has `count` steps.
    fn goto(&mut self, s: &Session, count: Option<i64>) -> AppResult<()> {
        let count = count
            .filter(|c| *c >= 0)
            .ok_or_else(|| AppError::bad("Bad step."))? as usize;
        while self.plan.steps.len() > count {
            self.undo();
        }
        while self.plan.steps.len() < count && !self.plan.redo.is_empty() {
            let before = (self.plan.steps.len(), self.plan.redo.len());
            self.redo(s)?;
            if (self.plan.steps.len(), self.plan.redo.len()) == before {
                break;
            }
        }
        Ok(())
    }

    fn show(
        &self,
        s: &Session,
        rev: Option<&str>,
        mode: Option<&str>,
        at: Option<&str>,
    ) -> AppResult<Value> {
        let rev = rev
            .filter(|r| REV.is_match(r))
            .ok_or_else(|| AppError::bad("Bad revision."))?;
        let op = match (check_op(at)?, self.tip()) {
            (Some(at), _) => at,
            (None, Some(tip)) => tip,
            (None, None) => self.head_op(s)?,
        };
        let repo = s.repo(&op)?;
        let text = s.ctx.show(&repo, rev, mode == Some("diff"))?;
        const LIMIT: usize = 400_000;
        let text = if text.len() > LIMIT {
            let mut end = LIMIT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}\n… truncated", &text[..end])
        } else {
            text
        };
        Ok(json!({ "text": text }))
    }

    /// Every version a change has had, newest first.
    fn evolution(&self, s: &Session, rev: Option<&str>, at: Option<&str>) -> AppResult<Value> {
        let rev = rev
            .filter(|r| REV.is_match(r))
            .ok_or_else(|| AppError::bad("Bad revision."))?;
        let op = match (check_op(at)?, self.tip()) {
            (Some(at), _) => at,
            (None, Some(tip)) => tip,
            (None, None) => self.head_op(s)?,
        };
        let repo = s.repo(&op)?;
        Ok(json!({ "versions": s.ctx.evolution(&repo, rev, 60)? }))
    }

    /// Answer one API request. Requests are handled one at a time, so plan
    /// changes never interleave.
    pub fn handle(
        &mut self,
        method: &str,
        route: &str,
        query: &Query,
        body: Option<&Value>,
    ) -> AppResult<Value> {
        let s = Session::load(&self.root)?;
        let q = |key: &str| query.get(key).map(String::as_str);
        let revset_owned = q("revset")
            .map(ToOwned::to_owned)
            .or_else(|| body_str(body, "revset").map(ToOwned::to_owned));
        let revset = revset_owned.as_deref();
        if method == "GET" {
            match route {
                "/api/state" => return self.state_in(&s, revset, q("at")),
                "/api/show" => return self.show(&s, q("rev"), q("mode"), q("at")),
                "/api/evolog" => return self.evolution(&s, q("rev"), q("at")),
                "/api/jjr/diagnose" => {
                    let (graph, _) = self.current_graph(&s, revset, q("at"))?;
                    return Ok(json!({
                        "summary": graph.summary(),
                        "diagnostics": graph.diagnose(),
                        "patterns": jjr::patterns::suggest_patterns_for_graph(&graph),
                        "feedback": self.narrator.explain_graph_feedback(&graph),
                        "jevMode": self.jev.mode(),
                        "preflight": graph.preflight,
                    }));
                }
                "/api/jjr/preflight" => {
                    let (graph, _) = self.current_graph(&s, revset, q("at"))?;
                    return Ok(
                        json!({ "preflight": graph.preflight, "diagnostics": graph.preflight_diagnostics() }),
                    );
                }
                "/api/jjr/ui" => {
                    let (graph, _) = self.current_graph(&s, revset, q("at"))?;
                    let vm = jjr::ui::build_dag_graph_view_model(&graph, q("selected"));
                    return Ok(json!({
                        "tui": jjr::ui::render_dag_tui(&vm, false),
                        "guiRows": jjr::ui::to_gui_dag_rows(&vm),
                        "viewModel": vm,
                    }));
                }
                _ => {}
            }
        }
        if method != "POST" {
            return Err(AppError::not_found());
        }
        let field = |key: &str| body.and_then(|b| b.get(key)).filter(|v| !v.is_null());
        let at = body_str(body, "at");
        match route {
            "/api/dry" => {
                let args = match body.and_then(|b| b.get("line")) {
                    Some(line) => split_command_line(&match line {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })?,
                    None => body_strings(field("args").unwrap_or(&Value::Null))?,
                };
                let result = self.dry_run_in(&s, &args)?;
                Ok(json!({ "result": result, "state": self.state_in(&s, revset, None)? }))
            }
            "/api/undo" => {
                self.undo();
                Ok(json!({ "state": self.state_in(&s, revset, None)? }))
            }
            "/api/redo" => {
                self.redo(&s)?;
                Ok(json!({ "state": self.state_in(&s, revset, None)? }))
            }
            "/api/goto" => {
                self.goto(&s, field("steps").and_then(Value::as_i64))?;
                Ok(json!({ "state": self.state_in(&s, revset, None)? }))
            }
            "/api/discard" => {
                self.discard();
                Ok(json!({ "state": self.state_in(&s, revset, None)? }))
            }
            "/api/apply" => {
                let result = self.apply(&s)?;
                Ok(json!({ "result": result, "state": self.state_in(&s, revset, None)? }))
            }
            "/api/restore" => {
                let result = self.restore(body_str(body, "op"))?;
                Ok(json!({ "result": result, "state": self.state_in(&s, revset, None)? }))
            }
            "/api/jjr/guard" => {
                let (graph, _) = self.current_graph(&s, revset, at)?;
                let action = field("action")
                    .filter(|a| a.is_object())
                    .ok_or_else(|| AppError::bad("Expected an action object."))?;
                let action: GuardrailAction = serde_json::from_value(action.clone())
                    .map_err(|err| AppError::bad(format!("Bad action: {err}")))?;
                if field("useJev").and_then(Value::as_bool).unwrap_or(false) {
                    let diff = body_str(body, "diffExcerpt").unwrap_or("");
                    Ok(json(&self.pipeline.evaluate_with_jev(
                        &graph,
                        &action,
                        Some(&self.jev),
                        diff,
                    )))
                } else {
                    Ok(json(&self.pipeline.evaluate(&graph, &action)))
                }
            }
            "/api/jjr/triage" => {
                let (graph, op) = self.current_graph(&s, Some(revset.unwrap_or("all()")), at)?;
                let rev = body_str(body, "rev")
                    .map(ToOwned::to_owned)
                    .or_else(|| graph.working_copy().map(|c| c.change_id.clone()))
                    .ok_or_else(|| AppError::bad("Expected a revision changeId."))?;
                let node = graph.get_any(&rev);
                let (diff_excerpt, touched_paths) = self.revision_context(&s, &rev, &op)?;
                let input = ChangeTriageInput {
                    change_id: node.map_or_else(|| rev.clone(), |n| n.change_id.clone()),
                    description: node
                        .map(|n| n.current_commit.description.clone())
                        .unwrap_or_default(),
                    touched_paths,
                    diff_excerpt,
                    is_empty: node.is_some_and(|n| n.current_commit.is_empty),
                    is_working_copy: node.is_some_and(|n| n.is_working_copy),
                    mutable_parent_count: node
                        .map(|n| {
                            n.parents
                                .iter()
                                .filter(|p| {
                                    graph
                                        .get(p)
                                        .is_some_and(|p| p.zone == jjr::types::Zone::Mutable)
                                })
                                .count()
                        })
                        .unwrap_or(0),
                    is_conflicted: node.is_some_and(|n| n.is_conflicted()),
                };
                Ok(json(&self.jev.triage_change(&input)))
            }
            "/api/jjr/dependency" => {
                let (graph, op) = self.current_graph(&s, Some(revset.unwrap_or("all()")), at)?;
                let (Some(base), Some(child)) = (body_str(body, "base"), body_str(body, "child"))
                else {
                    return Err(AppError::bad("Expected base and child changeIds."));
                };
                let base_node = graph.get_any(base);
                let child_node = graph.get_any(child);
                let base_id = base_node.map_or_else(|| base.to_owned(), |n| n.change_id.clone());
                let child_id = child_node.map_or_else(|| child.to_owned(), |n| n.change_id.clone());
                let explicit = (
                    field("childCausallyDependsOnBase").and_then(Value::as_bool),
                    field("baseIndependentlyReviewable").and_then(Value::as_bool),
                );
                if let (Some(depends), Some(reviewable)) = explicit {
                    let verdict =
                        JjrGraph::evaluate_dependency(&jjr::graph::DependencyAssessment {
                            base: base_id,
                            child: child_id,
                            child_causally_depends_on_base: Some(depends),
                            base_independently_reviewable: Some(reviewable),
                            ..Default::default()
                        });
                    return Ok(json!({ "source": "explicit", "verdict": verdict }));
                }
                let (base_diff, base_paths) = self.revision_context(&s, base, &op)?;
                let (child_diff, child_paths) = self.revision_context(&s, child, &op)?;
                let result = self.jev.assess_dependency(
                    &ChangeContext {
                        change_id: base_id,
                        description: base_node
                            .map(|n| n.current_commit.description.clone())
                            .unwrap_or_default(),
                        touched_paths: base_paths,
                        diff_excerpt: base_diff,
                    },
                    &ChangeContext {
                        change_id: child_id,
                        description: child_node
                            .map(|n| n.current_commit.description.clone())
                            .unwrap_or_default(),
                        touched_paths: child_paths,
                        diff_excerpt: child_diff,
                    },
                );
                Ok(json(&result))
            }
            "/api/jjr/verify" => {
                let verification = self.verify_in(&s, body_str(body, "range"))?;
                let mut out = json(&verification);
                out["state"] = self.state_in(&s, revset, None)?;
                Ok(out)
            }
            "/api/jjr/publish-plan" => {
                let (graph, _) = self.current_graph(&s, Some("all()"), at)?;
                let rev = body_str(body, "rev")
                    .map(ToOwned::to_owned)
                    .or_else(|| graph.working_copy().map(|c| c.change_id.clone()))
                    .ok_or_else(|| AppError::bad("Expected a revision changeId."))?;
                let forge = body_str(body, "forge").and_then(ForgeKind::parse);
                let plan = self
                    .runner
                    .plan_layered_publish(&graph, &rev, forge)
                    .map_err(|err| AppError::bad(err.to_string()))?;
                Ok(json(&plan))
            }
            "/api/jjr/suggest-name" => {
                let (graph, op) = self.current_graph(&s, Some(revset.unwrap_or("all()")), at)?;
                let rev = body_str(body, "rev")
                    .map(ToOwned::to_owned)
                    .or_else(|| graph.working_copy().map(|c| c.change_id.clone()))
                    .ok_or_else(|| AppError::bad("Expected a revision changeId."))?;
                let node = graph.get_any(&rev);
                let (diff_excerpt, touched_paths) = self.revision_context(&s, &rev, &op)?;
                Ok(json(
                    &self.narrator.suggest_change_name(&NamingInput {
                        change_id: Some(node.map_or_else(|| rev.clone(), |n| n.change_id.clone())),
                        description: node
                            .map(|n| n.current_commit.description.clone())
                            .unwrap_or_default(),
                        touched_paths,
                        diff_excerpt,
                    }),
                ))
            }
            _ => Err(AppError::not_found()),
        }
    }
}

/// Lets a `JjrRunner` drive the engine: guarded dry runs, recipe previews
/// and stack verification.
pub struct AppHost<'a>(pub &'a RefCell<App>);

impl jjr::runner::DryRunHost for AppHost<'_> {
    fn live_graph(&self, revset: &str) -> Result<(JjrGraph, Value), jjr::runner::HostError> {
        let state = self
            .0
            .borrow_mut()
            .state(Some(revset), None)
            .map_err(|err| jjr::runner::HostError(err.message))?;
        let nodes: Vec<GraphNode> = serde_json::from_value(state["nodes"].clone())
            .map_err(|err| jjr::runner::HostError(err.to_string()))?;
        let preflight: Option<PreflightFacts> =
            serde_json::from_value(state["jjr"]["preflight"].clone()).ok();
        let graph = JjrGraph::from_nodes(
            &nodes,
            FromNodesOptions {
                preflight,
                ..Default::default()
            },
        );
        Ok((graph, state))
    }

    fn dry_run(
        &self,
        args: &[String],
        revset: &str,
    ) -> Result<(Value, Value), jjr::runner::HostError> {
        let body = json!({ "args": args, "revset": revset });
        let r = self
            .0
            .borrow_mut()
            .handle("POST", "/api/dry", &Query::new(), Some(&body))
            .map_err(|err| jjr::runner::HostError(err.message))?;
        Ok((r["result"].clone(), r["state"].clone()))
    }

    fn verify(
        &self,
        range: Option<&str>,
        revset: &str,
    ) -> Result<StackVerification, jjr::runner::HostError> {
        let body = json!({ "range": range, "revset": revset });
        let r = self
            .0
            .borrow_mut()
            .handle("POST", "/api/jjr/verify", &Query::new(), Some(&body))
            .map_err(|err| jjr::runner::HostError(err.message))?;
        serde_json::from_value(r).map_err(|err| jjr::runner::HostError(err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_helpers() {
        let words = |line: &str| split_command_line(line).unwrap();
        assert_eq!(
            words(r#"jj describe -m "two words" 'x y'"#),
            ["describe", "-m", "two words", "x y"]
        );
        assert_eq!(words(r#"describe -m """#), ["describe", "-m", ""]);
        assert!(split_command_line(r#"describe -m "open"#).is_err());
        let v = |args: &[&str]| {
            validate_args(&args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>())
        };
        assert!(
            v(&["git", "push"])
                .unwrap_err()
                .message
                .contains("cannot be dry-run")
        );
        assert!(
            v(&["squash", "-i"])
                .unwrap_err()
                .message
                .contains("not allowed")
        );
        assert!(
            v(&["rebase", "--at-op=abc"])
                .unwrap_err()
                .message
                .contains("not allowed")
        );
        assert!(
            v(&["describe", "--ignore-immutable", "x"])
                .unwrap_err()
                .message
                .contains("--ignore-immutable")
        );
        assert!(
            v(&["split", "-r", "x"])
                .unwrap_err()
                .message
                .contains("needs paths")
        );
        assert_eq!(
            v(&["split", "--parallel", "src/impl.js"]).unwrap(),
            ["split", "--parallel", "src/impl.js"]
        );
        assert_eq!(v(&["converge"]).unwrap(), ["converge", "--no-interactive"]);
        assert_eq!(v(&["fix", "-s", "@"]).unwrap(), ["fix", "-s", "@"]);
        assert_eq!(
            display_command(&["rebase", "-s", &"k".repeat(32), "-o", "main"]),
            "jj rebase -s kkkkkkkk -o main"
        );
        assert_eq!(
            display_command(&["describe", "-m", "two words"]),
            r#"jj describe -m "two words""#
        );
    }
}
