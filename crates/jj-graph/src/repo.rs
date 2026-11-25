//! Reading a jj repository in-process with jj's own libraries.
//!
//! Configuration loads the way the jj CLI loads it (jj-cli's config
//! environment: defaults, system, user, repo and workspace layers, with
//! conditional scopes and migrations), so revset aliases such as `trunk()`
//! and `immutable_heads()` mean exactly what they mean to `jj`. Revisions,
//! operations, diffs and the evolution log are read with jj-lib at any
//! operation, including operations a dry run left out of the operation log.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use bstr::BStr;
use bstr::ByteSlice as _;
use futures::StreamExt as _;
use futures::TryStreamExt as _;
use jj_cli::cli_util::find_workspace_dir;
use jj_cli::cli_util::load_fileset_aliases;
use jj_cli::cli_util::load_revset_aliases;
use jj_cli::config::ConfigEnv;
use jj_cli::config::config_from_environment;
use jj_cli::config::default_config_layers;
use jj_cli::config::default_config_migrations;
use jj_cli::ui::Ui;
use jj_frontend::workspace_env::WorkspaceEnvironment;
use jj_frontend::workspace_env::WorkspaceEnvironmentDiagnostics;
use jj_lib::backend::ChangeId;
use jj_lib::backend::CommitId;
use jj_lib::backend::Timestamp;
use jj_lib::commit::Commit;
use jj_lib::config::StackedConfig;
use jj_lib::conflict_labels::ConflictLabels;
use jj_lib::conflicts::ConflictMaterializeOptions;
use jj_lib::conflicts::materialize_tree_value;
use jj_lib::default_backend_factories::default_backend_factories;
use jj_lib::default_backend_factories::default_working_copy_factories;
use jj_lib::diff_presentation::LineCompareMode;
use jj_lib::diff_presentation::unified::DiffLineType;
use jj_lib::diff_presentation::unified::git_diff_part;
use jj_lib::diff_presentation::unified::unified_diff_hunks;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merge::Diff;
use jj_lib::object_id::ObjectId as _;
use jj_lib::operation::Operation;
use jj_lib::repo::ReadonlyRepo;
use jj_lib::repo::Repo as _;
use jj_lib::revset;
use jj_lib::revset::Revset;
use jj_lib::revset::RevsetDiagnostics;
use jj_lib::revset::RevsetExtensions;
use jj_lib::revset::SymbolResolver;
use jj_lib::revset::UserRevsetExpression;
use jj_lib::settings::UserSettings;
use jj_lib::workspace::DefaultWorkspaceLoaderFactory;
use jj_lib::workspace::Workspace;
use jj_lib::workspace::WorkspaceLoaderFactory as _;
use jjr::graph::Edge;
use jjr::graph::GitCompatIssue;
use jjr::graph::GraphNode;
use jjr::graph::NodeBookmark;
use jjr::graph::PreflightRow;
use pollster::FutureExt as _;

/// An error reading the repository, with jj's own message.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ReadError(pub String);

pub type ReadResult<T> = Result<T, ReadError>;

fn e(err: impl std::fmt::Display) -> ReadError {
    ReadError(err.to_string())
}

/// Hook names git runs (githooks(5)); jj runs none of them.
const GIT_HOOKS: &[&str] = &[
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "post-index-change",
];

/// An entry of the operation log.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct OpEntry {
    pub id: String,
    pub description: String,
    pub time: String,
    pub snapshot: bool,
}

/// One version of a change, from its evolution log.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Version {
    pub commit: String,
    pub change: String,
    pub description: String,
    pub operation: Option<String>,
    pub time: String,
    pub snapshot: bool,
    pub empty: bool,
    pub conflict: bool,
}

/// A revision a guardrail check resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedRow {
    pub change_id: String,
    pub commit_id: String,
    pub immutable: bool,
    pub divergent: bool,
    pub in_trunk: bool,
}

/// A mutable revision to verify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifyTarget {
    pub change_id: String,
    pub commit_id: String,
    pub divergent: bool,
    pub title: String,
}

/// What a pre-flight check reads from the repository itself.
#[derive(Clone, Debug, Default)]
pub struct RepoFacts {
    pub colocated: bool,
    pub git_dir: Option<PathBuf>,
    pub remotes: Vec<String>,
    pub git_compat: Vec<GitCompatIssue>,
    pub keep_refs: usize,
}

/// The configuration, workspace and revset environment of one repository,
/// loaded the way `jj` loads them.
pub struct RepoContext {
    workspace: Workspace,
    env: WorkspaceEnvironment,
    extensions: Arc<RevsetExtensions>,
}

impl RepoContext {
    /// Load the workspace containing `path` with the user's jj configuration.
    pub fn load(path: &Path) -> ReadResult<Self> {
        let ui = Ui::null();
        let mut raw_config = config_from_environment(default_config_layers());
        let mut config_env = ConfigEnv::from_environment();
        config_env
            .reload_system_config(&mut raw_config)
            .map_err(e)?;
        config_env.reload_user_config(&mut raw_config).map_err(e)?;
        let loader = DefaultWorkspaceLoaderFactory
            .create(find_workspace_dir(path))
            .map_err(e)?;
        config_env.reset_repo_path(loader.repo_path());
        config_env
            .reload_repo_config(&ui, &mut raw_config)
            .map_err(|err| e(err.error))?;
        config_env.reset_workspace_path(loader.workspace_root());
        config_env
            .reload_workspace_config(&ui, &mut raw_config)
            .map_err(|err| e(err.error))?;
        let mut config = config_env.resolve_config(&raw_config).map_err(e)?;
        jj_lib::config::migrate(&mut config, &default_config_migrations()).map_err(e)?;
        let settings = UserSettings::from_config_and_home_dir(
            config,
            config_env.home_dir().map(ToOwned::to_owned),
        )
        .map_err(e)?;
        let workspace = loader
            .load(
                &settings,
                &default_backend_factories(),
                &default_working_copy_factories(),
            )
            .map_err(e)?;
        let revset_aliases =
            load_revset_aliases(&ui, settings.config()).map_err(|err| e(err.error))?;
        let fileset_aliases =
            load_fileset_aliases(&ui, settings.config()).map_err(|err| e(err.error))?;
        let extensions = Arc::new(RevsetExtensions::default());
        let mut diagnostics = WorkspaceEnvironmentDiagnostics::new();
        let root = workspace.workspace_root().to_owned();
        let env = WorkspaceEnvironment::new(
            &mut diagnostics,
            &workspace,
            &root,
            extensions.clone(),
            fileset_aliases,
            revset_aliases,
        )
        .map_err(e)?;
        Ok(Self {
            workspace,
            env,
            extensions,
        })
    }

    pub fn workspace_root(&self) -> &Path {
        self.workspace.workspace_root()
    }

    pub fn workspace_name(&self) -> &str {
        self.workspace.workspace_name().as_str()
    }

    pub fn settings(&self) -> &UserSettings {
        self.env.settings()
    }

    fn config(&self) -> &StackedConfig {
        self.env.settings().config()
    }

    /// A configured string, trimmed; `None` when unset, empty, or not a string.
    pub fn config_string(&self, name: &'static str) -> Option<String> {
        let value = self.config().get::<String>(name).ok()?;
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    }

    /// Whether a config table has any entries (e.g. `fix.tools`).
    pub fn has_table_entries(&self, name: &'static str) -> bool {
        self.config().table_keys(name).next().is_some()
    }

    /// The repository's current operation.
    pub fn head_op(&self) -> ReadResult<Operation> {
        match jj_lib::op_walk::resolve_op_for_load(self.workspace.repo_loader(), "@").block_on() {
            Ok(op) => Ok(op),
            // Concurrent operations: load (and merge) the heads the way jj does.
            Err(_) => Ok(self
                .workspace
                .repo_loader()
                .load_at_head(Some(self.workspace.workspace_name()))
                .block_on()
                .map_err(e)?
                .operation()
                .clone()),
        }
    }

    /// An operation by id or unique prefix, published or not.
    pub fn op(&self, id: &str) -> ReadResult<Operation> {
        jj_lib::op_walk::resolve_op_for_load(self.workspace.repo_loader(), id)
            .block_on()
            .map_err(e)
    }

    /// The repository as of an operation.
    pub fn repo_at(&self, op: &Operation) -> ReadResult<Arc<ReadonlyRepo>> {
        self.workspace
            .repo_loader()
            .load_at(op)
            .block_on()
            .map_err(e)
    }

    /// The repository as of an operation id.
    pub fn repo_at_id(&self, id: &str) -> ReadResult<Arc<ReadonlyRepo>> {
        self.repo_at(&self.op(id)?)
    }

    fn parse(&self, revset_str: &str) -> ReadResult<Arc<UserRevsetExpression>> {
        let mut diagnostics = RevsetDiagnostics::new();
        revset::parse(
            &mut diagnostics,
            revset_str,
            &self.env.revset_parse_context(),
        )
        .map_err(e)
    }

    fn evaluate_expr(
        &self,
        repo: &ReadonlyRepo,
        expression: &Arc<UserRevsetExpression>,
    ) -> ReadResult<Box<dyn Revset>> {
        let id_prefix_context = self.env.new_id_prefix_context();
        let resolver = SymbolResolver::new(repo, self.extensions.symbol_resolvers())
            .with_id_prefix_context(&id_prefix_context);
        let resolved = expression
            .resolve_user_expression(repo, &resolver)
            .map_err(e)?;
        resolved.evaluate().map_err(e)
    }

    fn evaluate(&self, repo: &ReadonlyRepo, revset_str: &str) -> ReadResult<Box<dyn Revset>> {
        self.evaluate_expr(repo, &self.parse(revset_str)?)
    }

    fn commit_ids(revset: &dyn Revset, limit: Option<usize>) -> ReadResult<Vec<CommitId>> {
        let stream = revset.stream();
        let ids: Vec<CommitId> = match limit {
            Some(n) => stream.take(n).try_collect().block_on(),
            None => stream.try_collect().block_on(),
        }
        .map_err(e)?;
        Ok(ids)
    }

    /// Commit ids of `revset_str`, newest first, at most `limit`.
    pub fn revset_commit_ids(
        &self,
        repo: &ReadonlyRepo,
        revset_str: &str,
        limit: Option<usize>,
    ) -> ReadResult<Vec<CommitId>> {
        Self::commit_ids(self.evaluate(repo, revset_str)?.as_ref(), limit)
    }

    fn immutable_revset(&self, repo: &ReadonlyRepo) -> ReadResult<Box<dyn Revset>> {
        let expression = self
            .env
            .resolve_immutable_expression(repo, false)
            .map_err(e)?;
        expression.evaluate(repo).map_err(e)
    }

    fn commit(repo: &ReadonlyRepo, id: &CommitId) -> ReadResult<Commit> {
        repo.store().get_commit_async(id).block_on().map_err(e)
    }

    /// The single commit a revision string names.
    pub fn single_commit(&self, repo: &ReadonlyRepo, rev: &str) -> ReadResult<Commit> {
        let ids = self.revset_commit_ids(repo, rev, Some(2))?;
        match ids.as_slice() {
            [id] => Self::commit(repo, id),
            [] => Err(ReadError(format!(
                "Revset `{rev}` didn't resolve to any revisions"
            ))),
            _ => Err(ReadError(format!(
                "Revset `{rev}` resolved to more than one revision"
            ))),
        }
    }

    /// The paths a commit changes relative to its parents.
    pub fn changed_paths(repo: &ReadonlyRepo, commit: &Commit) -> ReadResult<Vec<String>> {
        let parent_tree = commit.parent_tree(repo.index()).block_on().map_err(e)?;
        let tree = commit.tree();
        let paths: Vec<String> = parent_tree
            .diff(&tree, &EverythingMatcher)
            .map(|entry| entry.path.as_internal_file_string().to_owned())
            .collect::<Vec<_>>()
            .block_on();
        Ok(paths)
    }

    /// Revision nodes for `revset_str` at `repo`, newest first, at most
    /// `limit`, with parents outside the revset resolved to their nearest
    /// drawn ancestors (at most `max_elided` lookups).
    pub fn read_nodes(
        &self,
        repo: &ReadonlyRepo,
        revset_str: &str,
        limit: usize,
        max_elided: usize,
    ) -> ReadResult<Vec<GraphNode>> {
        let expression = self.parse(revset_str)?;
        let ids = Self::commit_ids(self.evaluate_expr(repo, &expression)?.as_ref(), Some(limit))?;
        let immutable = self.immutable_revset(repo)?;
        let is_immutable = immutable.containing_fn();
        let id_prefix_context = self.env.new_id_prefix_context();
        let prefix_index = id_prefix_context.populate(repo).map_err(e)?;
        let view = repo.view();
        let wc_id = view
            .get_wc_commit_id(self.workspace.workspace_name())
            .cloned();
        let mut nodes = Vec::with_capacity(ids.len());
        let mut mutable_ids: Vec<(usize, CommitId)> = Vec::new();
        for id in &ids {
            let commit = Self::commit(repo, id)?;
            let change_id = commit.change_id();
            let change = change_id.reverse_hex();
            let prefix_len = prefix_index
                .shortest_change_prefix_len(repo, change_id)
                .block_on()
                .map_err(e)?
                .max(4);
            let immutable = is_immutable(id).block_on().map_err(e)?;
            let targets = repo.resolve_change_id(change_id).block_on().map_err(e)?;
            let paths = if immutable {
                Vec::new()
            } else {
                Self::changed_paths(repo, &commit)?
            };
            if !immutable {
                mutable_ids.push((nodes.len(), id.clone()));
            }
            let author = commit.author();
            nodes.push(GraphNode {
                id: id.hex(),
                prefix: change.chars().take(prefix_len).collect(),
                change,
                parents: commit.parent_ids().iter().map(|p| p.hex()).collect(),
                description: commit.description().to_owned(),
                author: if author.name.is_empty() {
                    author.email.clone()
                } else {
                    author.name.clone()
                },
                time: format_timestamp(&commit.committer().timestamp, false),
                bookmarks: view
                    .local_bookmarks_for_commit(id)
                    .map(|(name, target)| NodeBookmark {
                        name: name.as_str().to_owned(),
                        conflict: target.present_adds().count() != 1,
                    })
                    .collect(),
                remotes: view
                    .all_remote_bookmarks()
                    .filter(|(symbol, remote_ref)| {
                        symbol.remote.as_str() != "git"
                            && remote_ref.target.present_adds().any(|t| t == id)
                    })
                    .map(|(symbol, _)| {
                        format!("{}@{}", symbol.name.as_str(), symbol.remote.as_str())
                    })
                    .collect(),
                tags: view
                    .local_tags()
                    .filter(|(_, target)| target.present_adds().any(|t| t == id))
                    .map(|(name, _)| name.as_str().to_owned())
                    .collect(),
                wc: wc_id.as_ref() == Some(id),
                immutable,
                conflict: commit.has_conflict(),
                empty: commit.is_empty(repo.index()).block_on().map_err(e)?,
                divergent: targets.as_ref().is_some_and(|t| t.is_divergent()),
                hidden: !targets.as_ref().is_some_and(|t| t.has_visible(id)),
                // Like jj's `working_copies`, named only when there are several workspaces.
                workspaces: if view.wc_commit_ids().len() <= 1 {
                    Vec::new()
                } else {
                    view.wc_commit_ids()
                        .iter()
                        .filter(|(_, c)| *c == id)
                        .map(|(name, _)| name.as_str().to_owned())
                        .collect()
                },
                files: paths.len(),
                paths,
                conflicted_paths: Vec::new(),
                versions: 1,
                edges: Vec::new(),
            });
        }
        if !mutable_ids.is_empty() {
            let start_ids: Vec<CommitId> = mutable_ids.iter().map(|(_, id)| id.clone()).collect();
            let counts = Self::version_counts(repo, &start_ids, 60);
            for (idx, id) in mutable_ids {
                if let Some(&count) = counts.get(&id) {
                    nodes[idx].versions = count;
                }
            }
        }
        self.resolve_edges(repo, &mut nodes, &expression, max_elided)?;
        Ok(nodes)
    }

    /// Count evolution-log commits sharing each mutable commit's `change_id`,
    /// using a single batched predecessor walk across all requested starts.
    fn version_counts(
        repo: &ReadonlyRepo,
        start_ids: &[CommitId],
        per_node_cap: usize,
    ) -> std::collections::HashMap<CommitId, usize> {
        if start_ids.is_empty() {
            return std::collections::HashMap::new();
        }
        let max_entries = start_ids
            .len()
            .saturating_mul(per_node_cap)
            .max(per_node_cap);
        let entries: Vec<_> = jj_lib::evolution::walk_predecessors(repo, start_ids)
            .take(max_entries)
            .try_collect()
            .block_on()
            .unwrap_or_default();
        let mut graph: std::collections::HashMap<CommitId, (ChangeId, Vec<CommitId>)> =
            std::collections::HashMap::with_capacity(entries.len());
        for entry in entries {
            let preds = entry.predecessor_ids().to_vec();
            let id = entry.commit.id().clone();
            let change_id = entry.commit.change_id().clone();
            graph.entry(id).or_insert((change_id, preds));
        }
        let mut counts = std::collections::HashMap::with_capacity(start_ids.len());
        for start in start_ids {
            let Some((target_change, _)) = graph.get(start) else {
                counts.insert(start.clone(), 1);
                continue;
            };
            let mut visited: HashSet<&CommitId> = HashSet::new();
            let mut stack: Vec<&CommitId> = vec![start];
            let mut count = 0usize;
            while let Some(cur) = stack.pop() {
                if !visited.insert(cur) {
                    continue;
                }
                let Some((change_id, preds)) = graph.get(cur) else {
                    continue;
                };
                if change_id != target_change {
                    continue;
                }
                count += 1;
                if count >= per_node_cap {
                    break;
                }
                for p in preds {
                    if !visited.contains(p) {
                        stack.push(p);
                    }
                }
            }
            counts.insert(start.clone(), count.max(1));
        }
        counts
    }

    /// Resolve each node's parents to edges. A parent outside the revset is
    /// replaced by its nearest visible ancestors, marked `indirect`; with
    /// none, the edge is a stub (`to: None`).
    fn resolve_edges(
        &self,
        repo: &ReadonlyRepo,
        nodes: &mut [GraphNode],
        expression: &Arc<UserRevsetExpression>,
        max_elided: usize,
    ) -> ReadResult<()> {
        let visible: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
        let mut missing: Vec<String> = Vec::new();
        for n in nodes.iter() {
            for p in &n.parents {
                if !visible.contains(p) && !missing.contains(p) {
                    missing.push(p.clone());
                }
            }
        }
        let mut elided: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for p in missing.iter().take(max_elided) {
            let found = CommitId::try_from_hex(p)
                .ok_or_else(|| ReadError(format!("Bad commit id {p}")))
                .and_then(|id| {
                    let heads = UserRevsetExpression::commit(id)
                        .ancestors()
                        .intersection(expression)
                        .heads();
                    Self::commit_ids(self.evaluate_expr(repo, &heads)?.as_ref(), None)
                })
                .map(|ids| {
                    ids.iter()
                        .map(|id| id.hex())
                        .filter(|id| visible.contains(id))
                        .collect()
                })
                .unwrap_or_default();
            elided.insert(p.clone(), found);
        }
        for n in nodes.iter_mut() {
            let mut edges = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            for p in &n.parents {
                if visible.contains(p) {
                    edges.push(Edge {
                        to: Some(p.clone()),
                        parent: p.clone(),
                        indirect: false,
                    });
                    seen.insert(p.clone());
                    continue;
                }
                let targets: Vec<String> = elided
                    .get(p)
                    .map(|t| t.iter().filter(|t| !seen.contains(*t)).cloned().collect())
                    .unwrap_or_default();
                if targets.is_empty() {
                    edges.push(Edge {
                        to: None,
                        parent: p.clone(),
                        indirect: true,
                    });
                }
                for t in targets {
                    seen.insert(t.clone());
                    edges.push(Edge {
                        to: Some(t),
                        parent: p.clone(),
                        indirect: true,
                    });
                }
            }
            n.edges = edges;
        }
        Ok(())
    }

    /// Rows for a pre-flight check: `(change id, commit id, immutable)` of
    /// up to `limit` revisions of `revset_str`.
    pub fn preflight_rows(
        &self,
        repo: &ReadonlyRepo,
        revset_str: &str,
        limit: usize,
    ) -> ReadResult<Vec<PreflightRow>> {
        let ids = self.revset_commit_ids(repo, revset_str, Some(limit))?;
        let immutable = self.immutable_revset(repo)?;
        let is_immutable = immutable.containing_fn();
        ids.iter()
            .map(|id| {
                let commit = Self::commit(repo, id)?;
                Ok(PreflightRow {
                    change_id: commit.change_id().reverse_hex(),
                    commit_id: id.hex(),
                    immutable: is_immutable(id).block_on().map_err(e)?,
                })
            })
            .collect()
    }

    /// Change ids of up to `limit` revisions of `revset_str`, without duplicates.
    pub fn change_ids(
        &self,
        repo: &ReadonlyRepo,
        revset_str: &str,
        limit: Option<usize>,
    ) -> ReadResult<Vec<String>> {
        let revset = self.evaluate(repo, revset_str)?;
        let pairs: Vec<(CommitId, ChangeId)> = match limit {
            Some(n) => revset.commit_change_ids().take(n).try_collect().block_on(),
            None => revset.commit_change_ids().try_collect().block_on(),
        }
        .map_err(e)?;
        let mut out: Vec<String> = Vec::new();
        for (_, change) in pairs {
            let hex = change.reverse_hex();
            if !out.contains(&hex) {
                out.push(hex);
            }
        }
        Ok(out)
    }

    /// Resolve revsets for a guardrail check, up to 500 revisions. `None`
    /// when one of them does not resolve: jj reports that itself when the
    /// command runs.
    pub fn resolve_targets(
        &self,
        repo: &ReadonlyRepo,
        revsets: &[String],
    ) -> Option<Vec<ResolvedRow>> {
        if revsets.is_empty() {
            return Some(Vec::new());
        }
        let union = revsets
            .iter()
            .map(|r| format!("({r})"))
            .collect::<Vec<_>>()
            .join(" | ");
        let ids = self.revset_commit_ids(repo, &union, Some(500)).ok()?;
        let immutable = self.immutable_revset(repo).ok()?;
        let is_immutable = immutable.containing_fn();
        let trunk = self.evaluate(repo, "::trunk()").ok();
        let in_trunk = trunk.as_ref().map(|t| t.containing_fn());
        let mut rows = Vec::new();
        for id in &ids {
            let commit = Self::commit(repo, id).ok()?;
            let targets = repo.resolve_change_id(commit.change_id()).block_on().ok()?;
            rows.push(ResolvedRow {
                change_id: commit.change_id().reverse_hex(),
                commit_id: id.hex(),
                immutable: is_immutable(id).block_on().ok()?,
                divergent: targets.is_some_and(|t| t.is_divergent()),
                in_trunk: match &in_trunk {
                    Some(f) => f(id).block_on().unwrap_or(false),
                    None => false,
                },
            });
        }
        Some(rows)
    }

    /// The mutable revisions of `revset_str`, bottom-up (parents first).
    pub fn verify_targets(
        &self,
        repo: &ReadonlyRepo,
        revset_str: &str,
    ) -> ReadResult<Vec<VerifyTarget>> {
        let ids = self.revset_commit_ids(repo, revset_str, None)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids.iter().rev() {
            let commit = Self::commit(repo, id)?;
            let targets = repo
                .resolve_change_id(commit.change_id())
                .block_on()
                .map_err(e)?;
            out.push(VerifyTarget {
                change_id: commit.change_id().reverse_hex(),
                commit_id: id.hex(),
                divergent: targets.is_some_and(|t| t.is_divergent()),
                title: first_line(commit.description())
                    .map_or_else(|| "(no description)".to_owned(), ToOwned::to_owned),
            });
        }
        Ok(out)
    }

    /// The paths whose changes differ between commit `from` and the visible
    /// commit of change `to` (`jj interdiff --from <from> --to <to> --name-only`).
    pub fn interdiff_paths(
        &self,
        repo: &ReadonlyRepo,
        from_commit: &str,
        to_change: &str,
    ) -> ReadResult<Vec<String>> {
        let from_id = CommitId::try_from_hex(from_commit)
            .ok_or_else(|| ReadError(format!("Bad commit id {from_commit}")))?;
        let from = Self::commit(repo, &from_id)?;
        let to = self.single_commit(repo, &format!("change_id({to_change})"))?;
        let from_tree = jj_lib::rewrite::rebase_to_dest_parent(repo.index(), &[from], &to)
            .block_on()
            .map_err(e)?;
        let paths: Vec<String> = from_tree
            .diff(&to.tree(), &EverythingMatcher)
            .map(|entry| entry.path.as_internal_file_string().to_owned())
            .collect::<Vec<_>>()
            .block_on();
        Ok(paths)
    }

    /// The newest operations from `head`, newest first.
    pub fn operations(&self, head: &Operation, limit: usize) -> ReadResult<Vec<OpEntry>> {
        let ops: Vec<Operation> = jj_lib::op_walk::walk_ancestors(std::slice::from_ref(head))
            .take(limit)
            .try_collect()
            .block_on()
            .map_err(e)?;
        Ok(ops
            .iter()
            .map(|op| {
                let meta = op.metadata();
                OpEntry {
                    id: op.id().hex(),
                    description: first_line(&meta.description).unwrap_or("").to_owned(),
                    time: format_timestamp(&meta.time.end, true),
                    snapshot: meta.is_snapshot,
                }
            })
            .collect())
    }

    /// Every version the change at `rev` has had, newest first.
    pub fn evolution(
        &self,
        repo: &ReadonlyRepo,
        rev: &str,
        limit: usize,
    ) -> ReadResult<Vec<Version>> {
        let commit = self.single_commit(repo, rev)?;
        let entries: Vec<_> =
            jj_lib::evolution::walk_predecessors(repo, std::slice::from_ref(commit.id()))
                .take(limit)
                .try_collect()
                .block_on()
                .map_err(e)?;
        let mut out = Vec::with_capacity(entries.len());
        for entry in &entries {
            let empty = entry
                .commit
                .is_empty(repo.index())
                .block_on()
                .unwrap_or(false);
            out.push(Version {
                commit: entry.commit.id().hex(),
                change: entry.commit.change_id().reverse_hex(),
                description: first_line(entry.commit.description())
                    .unwrap_or("")
                    .to_owned(),
                operation: entry.operation.as_ref().map(|op| {
                    first_line(&op.metadata().description)
                        .unwrap_or("")
                        .to_owned()
                }),
                time: entry.operation.as_ref().map_or_else(
                    || format_timestamp(&entry.commit.committer().timestamp, false),
                    |op| format_timestamp(&op.metadata().time.end, true),
                ),
                snapshot: entry
                    .operation
                    .as_ref()
                    .is_some_and(|op| op.metadata().is_snapshot),
                empty,
                conflict: entry.commit.has_conflict(),
            });
        }
        Ok(out)
    }

    /// A revision as `jj show` prints it: its header and description, then
    /// its changes as a Git-format diff or a diffstat.
    pub fn show(&self, repo: &ReadonlyRepo, rev: &str, git: bool) -> ReadResult<String> {
        let commit = self.single_commit(repo, rev)?;
        let mut out = String::new();
        let bookmarks: Vec<String> = repo
            .view()
            .local_bookmarks_for_commit(commit.id())
            .map(|(n, _)| n.as_str().to_owned())
            .collect();
        let _ = writeln!(out, "Commit ID: {}", commit.id().hex());
        let _ = writeln!(out, "Change ID: {}", commit.change_id().reverse_hex());
        if !bookmarks.is_empty() {
            let _ = writeln!(out, "Bookmarks: {}", bookmarks.join(" "));
        }
        let sig = |s: &jj_lib::backend::Signature| {
            format!(
                "{} <{}> ({})",
                s.name,
                s.email,
                format_timestamp_human(&s.timestamp)
            )
        };
        let _ = writeln!(out, "Author   : {}", sig(commit.author()));
        let _ = writeln!(out, "Committer: {}", sig(commit.committer()));
        out.push('\n');
        if commit.description().trim().is_empty() {
            out.push_str("    (no description set)\n");
        } else {
            for line in commit.description().lines() {
                let _ = writeln!(out, "    {line}");
            }
        }
        out.push('\n');
        let files = self.file_diffs(repo, &commit)?;
        if git {
            for f in &files {
                f.write_git(&mut out);
            }
        } else {
            write_stat(&mut out, &files);
        }
        Ok(out)
    }

    /// The Git-format diff of a revision (for triage and naming).
    pub fn git_diff(&self, repo: &ReadonlyRepo, rev: &str) -> ReadResult<(String, Vec<String>)> {
        let commit = self.single_commit(repo, rev)?;
        let files = self.file_diffs(repo, &commit)?;
        let mut out = String::new();
        for f in &files {
            f.write_git(&mut out);
        }
        Ok((out, files.into_iter().map(|f| f.path).collect()))
    }

    fn file_diffs(&self, repo: &ReadonlyRepo, commit: &Commit) -> ReadResult<Vec<FileDiff>> {
        let store = repo.store();
        let parent_tree = commit.parent_tree(repo.index()).block_on().map_err(e)?;
        let tree = commit.tree();
        let options = ConflictMaterializeOptions {
            marker_style: self.env.conflict_marker_style(),
            marker_len: None,
            merge: store.merge_options().clone(),
        };
        let labels = ConflictLabels::unlabeled();
        let entries: Vec<_> = parent_tree
            .diff(&tree, &EverythingMatcher)
            .collect::<Vec<_>>()
            .block_on();
        let mut files = Vec::with_capacity(entries.len());
        for entry in entries {
            let values = entry.values.map_err(e)?;
            let path = entry.path.as_ref();
            let before = materialize_tree_value(store, path, values.before, &labels)
                .block_on()
                .map_err(e)?;
            let after = materialize_tree_value(store, path, values.after, &labels)
                .block_on()
                .map_err(e)?;
            let left = git_diff_part(path, before, &options)
                .block_on()
                .map_err(e)?;
            let right = git_diff_part(path, after, &options).block_on().map_err(e)?;
            files.push(FileDiff {
                path: path.as_internal_file_string().to_owned(),
                left_mode: left.mode,
                right_mode: right.mode,
                left_hash: left.hash,
                right_hash: right.hash,
                binary: left.content.is_binary || right.content.is_binary,
                left: left.content.contents.into(),
                right: right.content.contents.into(),
            });
        }
        Ok(files)
    }

    /// Facts about the backing Git repository for a pre-flight check.
    pub fn repo_facts(&self, repo: &ReadonlyRepo) -> RepoFacts {
        let colocated = self.env.working_copy_shared_with_git();
        let git_dir = jj_lib::git::get_git_backend(repo.store())
            .ok()
            .map(|b| b.git_repo_path().to_owned());
        let remotes = jj_lib::git::get_all_remote_names(repo.store())
            .map(|names| names.iter().map(|n| n.as_str().to_owned()).collect())
            .unwrap_or_default();
        let keep_refs = git_dir
            .as_ref()
            .and_then(|d| std::fs::read_dir(d.join("refs").join("jj").join("keep")).ok())
            .map_or(0, Iterator::count);
        let mut git_compat = Vec::new();
        let root = self.workspace_root();
        if root.join(".gitmodules").exists() {
            git_compat.push(GitCompatIssue {
                kind: "submodules".into(),
                message: ".gitmodules found: jj does not support Git submodules, so they are neither checked out nor updated.".into(),
                suggested_command: None,
            });
        }
        if let Ok(attrs) = std::fs::read_to_string(root.join(".gitattributes")) {
            if attrs.contains("filter=lfs") {
                git_compat.push(GitCompatIssue {
                    kind: "lfs".into(),
                    message: ".gitattributes routes files through Git LFS: jj does not support LFS and commits the pointer files as they are.".into(),
                    suggested_command: None,
                });
            } else if attrs
                .lines()
                .any(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
            {
                git_compat.push(GitCompatIssue {
                    kind: "gitattributes".into(),
                    message: ".gitattributes has no effect under jj (no eol conversion, filters, or merge drivers).".into(),
                    suggested_command: None,
                });
            }
        }
        if colocated && let Some(dir) = &git_dir {
            let mut active: Vec<String> = std::fs::read_dir(dir.join("hooks"))
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter_map(|e| e.file_name().into_string().ok())
                        .filter(|n| GIT_HOOKS.contains(&n.as_str()))
                        .collect()
                })
                .unwrap_or_default();
            active.sort();
            if !active.is_empty() {
                git_compat.push(GitCompatIssue {
                    kind: "hooks".into(),
                    message: format!("Git hooks ({}) never run under jj; run their checks through jj fix or the verify command instead.", active.join(", ")),
                    suggested_command: Some("jj config set --repo jjr.verify-command '<build and test command>'".into()),
                });
            }
        }
        RepoFacts {
            colocated,
            git_dir,
            remotes,
            git_compat,
            keep_refs,
        }
    }
}

/// One file's change, materialized for display.
struct FileDiff {
    path: String,
    left_mode: Option<&'static str>,
    right_mode: Option<&'static str>,
    left_hash: String,
    right_hash: String,
    binary: bool,
    left: Vec<u8>,
    right: Vec<u8>,
}

impl FileDiff {
    /// The file's diff in Git format, as `jj diff --git` writes it.
    fn write_git(&self, out: &mut String) {
        let path = &self.path;
        let _ = writeln!(out, "diff --git a/{path} b/{path}");
        match (self.left_mode, self.right_mode) {
            (None, Some(mode)) => {
                let _ = writeln!(out, "new file mode {mode}");
                let _ = writeln!(out, "index {}..{}", self.left_hash, self.right_hash);
            }
            (Some(mode), None) => {
                let _ = writeln!(out, "deleted file mode {mode}");
                let _ = writeln!(out, "index {}..{}", self.left_hash, self.right_hash);
            }
            (Some(left), Some(right)) => {
                if left != right {
                    let _ = writeln!(out, "old mode {left}");
                    let _ = writeln!(out, "new mode {right}");
                    if self.left_hash != self.right_hash {
                        let _ = writeln!(out, "index {}..{}", self.left_hash, self.right_hash);
                    }
                } else if self.left_hash != self.right_hash {
                    let _ = writeln!(out, "index {}..{} {left}", self.left_hash, self.right_hash);
                }
            }
            (None, None) => {}
        }
        if self.left == self.right {
            return;
        }
        let left_path = if self.left_mode.is_some() {
            format!("a/{path}")
        } else {
            "/dev/null".to_owned()
        };
        let right_path = if self.right_mode.is_some() {
            format!("b/{path}")
        } else {
            "/dev/null".to_owned()
        };
        if self.binary {
            let _ = writeln!(out, "Binary files {left_path} and {right_path} differ");
            return;
        }
        let _ = writeln!(out, "--- {left_path}");
        let _ = writeln!(out, "+++ {right_path}");
        let to_line_number =
            |r: &std::ops::Range<usize>| if r.is_empty() { r.start } else { r.start + 1 };
        let contents = Diff::new(BStr::new(&self.left), BStr::new(&self.right));
        for hunk in unified_diff_hunks(contents, 3, LineCompareMode::Exact) {
            let _ = writeln!(
                out,
                "@@ -{},{} +{},{} @@",
                to_line_number(&hunk.left_line_range),
                hunk.left_line_range.len(),
                to_line_number(&hunk.right_line_range),
                hunk.right_line_range.len()
            );
            for (line_type, tokens) in &hunk.lines {
                out.push(match line_type {
                    DiffLineType::Context => ' ',
                    DiffLineType::Removed => '-',
                    DiffLineType::Added => '+',
                });
                let mut line: Vec<u8> = Vec::new();
                for (_, content) in tokens {
                    line.extend_from_slice(content);
                }
                out.push_str(&line.to_str_lossy());
                if !line.ends_with(b"\n") {
                    out.push_str("\n\\ No newline at end of file\n");
                }
            }
        }
    }

    /// Lines added and removed.
    fn line_counts(&self) -> (usize, usize) {
        if self.binary {
            return (0, 0);
        }
        let contents = Diff::new(BStr::new(&self.left), BStr::new(&self.right));
        let mut added = 0;
        let mut removed = 0;
        for hunk in unified_diff_hunks(contents, 0, LineCompareMode::Exact) {
            for (line_type, _) in &hunk.lines {
                match line_type {
                    DiffLineType::Added => added += 1,
                    DiffLineType::Removed => removed += 1,
                    DiffLineType::Context => {}
                }
            }
        }
        (added, removed)
    }
}

/// A diffstat, as `jj diff --stat` writes it.
fn write_stat(out: &mut String, files: &[FileDiff]) {
    const MAX_BARS: usize = 40;
    let stats: Vec<(usize, usize)> = files.iter().map(FileDiff::line_counts).collect();
    let width = files
        .iter()
        .map(|f| f.path.chars().count())
        .max()
        .unwrap_or(0);
    let max_changes = stats.iter().map(|(a, r)| a + r).max().unwrap_or(0);
    let digits = max_changes.to_string().len();
    let (mut total_added, mut total_removed) = (0, 0);
    for (f, (added, removed)) in files.iter().zip(&stats) {
        total_added += added;
        total_removed += removed;
        let changes = added + removed;
        let (plus, minus) = if max_changes > MAX_BARS && changes > 0 {
            let scale = |n: usize| (n * MAX_BARS).div_ceil(max_changes);
            (scale(*added), scale(*removed))
        } else {
            (*added, *removed)
        };
        if f.binary {
            let _ = writeln!(out, "{:<width$} | (binary)", f.path);
        } else {
            let _ = writeln!(
                out,
                "{:<width$} | {changes:>digits$} {}{}",
                f.path,
                "+".repeat(plus),
                "-".repeat(minus)
            );
        }
    }
    let plural = |n: usize, word: &str| {
        if n == 1 {
            format!("{n} {word}")
        } else {
            format!("{n} {word}s")
        }
    };
    let _ = writeln!(
        out,
        "{} changed, {}(+), {}(-)",
        plural(files.len(), "file"),
        plural(total_added, "insertion"),
        plural(total_removed, "deletion")
    );
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().next().filter(|l| !l.is_empty())
}

/// A jj timestamp as RFC 3339 in its own UTC offset.
pub fn format_timestamp(ts: &Timestamp, millis: bool) -> String {
    let Ok(t) = jiff::Timestamp::from_millisecond(ts.timestamp.0) else {
        return String::new();
    };
    let offset = jiff::tz::Offset::from_seconds(ts.tz_offset.saturating_mul(60))
        .unwrap_or(jiff::tz::Offset::UTC);
    let zoned = t.to_zoned(jiff::tz::TimeZone::fixed(offset));
    zoned
        .strftime(if millis {
            "%Y-%m-%dT%H:%M:%S%.3f%:z"
        } else {
            "%Y-%m-%dT%H:%M:%S%:z"
        })
        .to_string()
}

fn format_timestamp_human(ts: &Timestamp) -> String {
    let Ok(t) = jiff::Timestamp::from_millisecond(ts.timestamp.0) else {
        return String::new();
    };
    let offset = jiff::tz::Offset::from_seconds(ts.tz_offset.saturating_mul(60))
        .unwrap_or(jiff::tz::Offset::UTC);
    t.to_zoned(jiff::tz::TimeZone::fixed(offset))
        .strftime("%Y-%m-%d %H:%M:%S")
        .to_string()
}
