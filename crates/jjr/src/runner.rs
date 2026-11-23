//! `JjrRunner`: guarded command planning, layered publishing, and guarded
//! dry runs against a host that runs them (jj-graph's engine).
//!
//! Every graph mutation passes the [`JjrGuardrailPipeline`] before it touches
//! even a dry-run operation (`jj --at-op <tip> --no-integrate-operation`);
//! recipes are previewed step by step before they are applied, and stacks
//! are published layer by layer.
//!
//! Port of `jjr/runner.mjs`. The JavaScript runner reached jj-graph through
//! a bound server app; here the engine is a [`DryRunHost`] passed to each call.

use std::collections::HashSet;

use indexmap::IndexSet;
use serde::Deserialize;
use serde::Serialize;

use crate::commands::describe_mutation;
use crate::graph::JjrGraph;
use crate::guardrails::BookmarkAction;
use crate::guardrails::GitInteropAction;
use crate::guardrails::GuardrailAction;
use crate::guardrails::GuardrailResult;
use crate::guardrails::JjrGuardrailPipeline;
use crate::guardrails::MutateAction;
use crate::guardrails::PushAction;
use crate::guardrails::WorkspaceAddAction;
use crate::guardrails::WorkspaceReason;
use crate::jev::JjrJevAssistant;
use crate::narrator::JjrNarrator;
use crate::patterns::JjrPatterns;
use crate::patterns::JjrRecipe;
use crate::patterns::forge_adapter;
use crate::types::ForgeKind;
use crate::types::VerificationState;
use crate::types::short;

/// A planned command and the guardrails' verdict on it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedAction {
    pub command: String,
    pub guard_result: GuardrailResult,
    pub blocked: bool,
}

/// One layer of a stack and whether it can be published now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishLayer {
    pub change_id: String,
    pub commit_id: String,
    pub title: String,
    pub publishable: bool,
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterSummary {
    pub name: String,
    pub model_alignment: String,
    pub caveats: Vec<String>,
}

/// Which bottom layers of a stack can be published now, and how.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredPublishPlan {
    pub forge: ForgeKind,
    pub adapter: AdapterSummary,
    pub head: String,
    pub layers: Vec<PublishLayer>,
    pub publish: Vec<String>,
    pub keep_local: Vec<String>,
    pub commands: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatterSummary {
    pub configured: bool,
    pub fixed: usize,
    pub checked: usize,
    pub error: Option<String>,
}

/// One revision's verification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub change_id: String,
    pub commit_id: String,
    pub title: String,
    pub state: VerificationState,
    pub formatted: Option<bool>,
    pub tests_pass: Option<bool>,
    pub unformatted_files: Vec<String>,
    pub output: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationCounts {
    pub green: usize,
    pub red: usize,
    pub unknown: usize,
}

/// The result of verifying a stack (jj-graph's `POST /api/jjr/verify`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackVerification {
    pub op: String,
    pub range: String,
    pub command: Option<String>,
    pub formatter: FormatterSummary,
    pub results: Vec<VerificationResult>,
    pub skipped: usize,
    pub summary: VerificationCounts,
    pub hint: Option<String>,
}

/// An error from the host that runs dry runs.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct HostError(pub String);

/// Runs dry runs and verification for a [`JjrRunner`]: jj-graph's engine.
pub trait DryRunHost {
    /// The live graph of `revset` and the state it was read from.
    fn live_graph(&self, revset: &str) -> Result<(JjrGraph, serde_json::Value), HostError>;
    /// Add `args` to the dry-run plan; returns the step result and the new state.
    fn dry_run(
        &self,
        args: &[String],
        revset: &str,
    ) -> Result<(serde_json::Value, serde_json::Value), HostError>;
    /// Verify the revisions of `range`.
    fn verify(&self, range: Option<&str>, revset: &str) -> Result<StackVerification, HostError>;
}

/// A guarded dry run: blocked by the guardrails, or run with its result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunOutcome {
    pub blocked: bool,
    pub guard_result: serde_json::Value,
    pub result: Option<serde_json::Value>,
    pub state: serde_json::Value,
}

/// One step of a previewed recipe.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternStepOutcome {
    pub title: String,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<DryRunOutcome>,
}

#[derive(Debug, thiserror::Error)]
#[error("Change {0} not found in the loaded graph.")]
pub struct HeadNotFound(pub String);

/// Guarded planning and publishing.
#[derive(Clone, Debug)]
pub struct JjrRunner {
    pub pipeline: JjrGuardrailPipeline,
    pub jev: JjrJevAssistant,
    pub narrator: JjrNarrator,
}

impl Default for JjrRunner {
    fn default() -> Self {
        let jev = JjrJevAssistant::from_env();
        Self {
            pipeline: JjrGuardrailPipeline::new(),
            narrator: JjrNarrator::from_env(jev.clone()),
            jev,
        }
    }
}

/// The revset a dry run loads when none is given.
const DEFAULT_REVSET: &str = "all()";

/// A guardrail result as JSON. Guardrail results hold only strings, numbers
/// and booleans, so they always serialize.
fn to_json<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or_default()
}

impl JjrRunner {
    pub fn new(
        pipeline: JjrGuardrailPipeline,
        jev: JjrJevAssistant,
        narrator: JjrNarrator,
    ) -> Self {
        Self {
            pipeline,
            jev,
            narrator,
        }
    }

    fn planned(
        &self,
        graph: &JjrGraph,
        action: &GuardrailAction,
        command: String,
    ) -> PlannedAction {
        let guard_result = self.pipeline.evaluate(graph, action);
        PlannedAction {
            command,
            blocked: !guard_result.allowed,
            guard_result,
        }
    }

    /// Check a mutation against the graph. Pass `args` (the jj argv) when
    /// available so the guardrails see exactly which revisions it rewrites.
    pub fn plan_mutation(
        &self,
        graph: &JjrGraph,
        target_changes: &[String],
        command: &str,
        args: Option<&[String]>,
    ) -> PlannedAction {
        let action = match args {
            Some(args) => {
                let m = describe_mutation(args);
                let targets: IndexSet<String> =
                    target_changes.iter().cloned().chain(m.rewrites).collect();
                MutateAction {
                    target_changes: targets.into_iter().collect(),
                    command: command.to_owned(),
                    args: Some(args.to_vec()),
                    ignore_immutable: Some(m.ignore_immutable),
                    recovery: Some(m.recovery),
                    ..MutateAction::default()
                }
            }
            None => MutateAction {
                target_changes: target_changes.to_vec(),
                command: command.to_owned(),
                ..MutateAction::default()
            },
        };
        self.planned(graph, &GuardrailAction::Mutate(action), command.to_owned())
    }

    /// Check creating or moving bookmarks (export pointers).
    pub fn plan_bookmark(
        &self,
        graph: &JjrGraph,
        names: &[String],
        target_change: &str,
    ) -> PlannedAction {
        let action = BookmarkAction {
            bookmarks: names.to_vec(),
            target_changes: vec![target_change.to_owned()],
        };
        let command = format!(
            "jj bookmark set {} -r {}",
            names.join(" "),
            short(target_change)
        );
        self.planned(graph, &GuardrailAction::Bookmark(action), command)
    }

    /// Check a push, of `target_changes` or of `bookmark` when one is named.
    pub fn plan_push(
        &self,
        graph: &JjrGraph,
        target_changes: &[String],
        bookmark: Option<&str>,
    ) -> PlannedAction {
        let bookmark = bookmark.filter(|b| !b.is_empty());
        let command = match bookmark {
            Some(b) => format!("jj git push --bookmark {b}"),
            None => format!(
                "jj git push -c {}",
                target_changes
                    .iter()
                    .map(|id| short(id))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        };
        let action = PushAction {
            target_changes: target_changes.to_vec(),
            bookmark: bookmark.map(str::to_owned),
        };
        self.planned(graph, &GuardrailAction::Push(action), command)
    }

    /// Plan publishing a stack layer by layer: the mutable ancestors of
    /// `head` bottom-up, each publishable when the push guardrails pass for
    /// it (its own ancestors included). Bottom layers that pass can be
    /// published now; the rest stay local until they are ready.
    ///
    /// `head` is a change id, a commit id, or a simple revset of the top of
    /// the stack; `forge` defaults to the graph's configured forge.
    pub fn plan_layered_publish(
        &self,
        graph: &JjrGraph,
        head: &str,
        forge: Option<ForgeKind>,
    ) -> Result<LayeredPublishPlan, HeadNotFound> {
        let top = graph
            .get(head)
            .or_else(|| graph.get_by_commit(head))
            .or_else(|| graph.resolve(head).into_iter().next())
            .ok_or_else(|| HeadNotFound(head.to_owned()))?;
        let forge = forge.unwrap_or(graph.config.forge);
        let adapter = forge_adapter(forge);
        let layers: Vec<PublishLayer> = graph
            .mutable_ancestors_of(&top.change_id)
            .into_iter()
            .map(|c| {
                let push = PushAction {
                    target_changes: vec![c.change_id.clone()],
                    bookmark: None,
                };
                let result = self.pipeline.evaluate(graph, &GuardrailAction::Push(push));
                let title = c
                    .current_commit
                    .description
                    .split('\n')
                    .next()
                    .filter(|t| !t.is_empty())
                    .unwrap_or("(no description)");
                PublishLayer {
                    change_id: c.change_id.clone(),
                    commit_id: c.current_commit.commit_id.clone(),
                    title: title.to_owned(),
                    publishable: result.allowed,
                    reasons: result
                        .blockers
                        .iter()
                        .map(|b| format!("{}: {}", b.rule_name, b.message))
                        .collect(),
                    warnings: result
                        .warnings
                        .iter()
                        .map(|w| format!("{}: {}", w.rule_name, w.message))
                        .collect(),
                    command: result
                        .allowed
                        .then(|| JjrPatterns::publish_command(forge, &c.change_id)),
                }
            })
            .collect();

        let publishable: Vec<&PublishLayer> = layers.iter().filter(|l| l.publishable).collect();
        let commands = if adapter.stack_aware {
            // Stack-aware forges upload the top publishable layer and its ancestors at once.
            let publishable_ids: HashSet<&str> =
                publishable.iter().map(|l| l.change_id.as_str()).collect();
            publishable
                .iter()
                .filter(|l| {
                    !graph
                        .children_of(&l.change_id)
                        .iter()
                        .any(|id| publishable_ids.contains(id.as_str()))
                })
                .map(|l| JjrPatterns::publish_command(forge, &l.change_id))
                .collect()
        } else {
            publishable
                .iter()
                .filter_map(|l| l.command.clone())
                .collect()
        };
        let publish = publishable.iter().map(|l| l.change_id.clone()).collect();
        let keep_local = layers
            .iter()
            .filter(|l| !l.publishable)
            .map(|l| l.change_id.clone())
            .collect();
        Ok(LayeredPublishPlan {
            forge,
            adapter: AdapterSummary {
                name: adapter.name.to_owned(),
                model_alignment: adapter.model_alignment.to_owned(),
                caveats: adapter.caveats.iter().map(|c| (*c).to_owned()).collect(),
            },
            head: top.change_id.clone(),
            layers,
            publish,
            keep_local,
            commands,
        })
    }

    /// Check a raw Git command in a colocated repository.
    pub fn plan_git_interop(&self, graph: &JjrGraph, raw_git_command: &str) -> PlannedAction {
        let action = GitInteropAction {
            raw_git_command: raw_git_command.to_owned(),
        };
        self.planned(
            graph,
            &GuardrailAction::GitInterop(action),
            raw_git_command.to_owned(),
        )
    }

    /// Check `jj workspace add`.
    pub fn plan_workspace_add(
        &self,
        graph: &JjrGraph,
        reason: Option<WorkspaceReason>,
    ) -> PlannedAction {
        self.planned(
            graph,
            &GuardrailAction::WorkspaceAdd(WorkspaceAddAction { reason }),
            "jj workspace add".to_owned(),
        )
    }

    /// Check `args` against the live graph, then dry-run them on `host`.
    ///
    /// The deterministic guardrails (and Jev's calibrated risk reading when
    /// `use_jev`) run against the live graph of `revset` (default `all()`)
    /// first; only when they allow the command does the host preview it
    /// (`jj --at-op <tip> --no-integrate-operation`), leaving the repository
    /// untouched until the plan is applied. The host checks again with the
    /// revisions jj itself resolves.
    pub fn dry_run(
        &self,
        host: &dyn DryRunHost,
        args: &[String],
        revset: Option<&str>,
        use_jev: bool,
    ) -> Result<DryRunOutcome, HostError> {
        let revset = revset.unwrap_or(DEFAULT_REVSET);
        let (graph, state) = host.live_graph(revset)?;
        let m = describe_mutation(args);
        let action = GuardrailAction::Mutate(MutateAction {
            target_changes: m.rewrites,
            command: format!("jj {}", args.join(" ")),
            args: Some(args.to_vec()),
            ignore_immutable: Some(m.ignore_immutable),
            recovery: Some(m.recovery),
            ..MutateAction::default()
        });

        let (allowed, guard_result) = if use_jev {
            let result = self
                .pipeline
                .evaluate_with_jev(&graph, &action, Some(&self.jev), "");
            (result.result.allowed, to_json(&result))
        } else {
            let result = self.pipeline.evaluate(&graph, &action);
            (result.allowed, to_json(&result))
        };
        if !allowed {
            return Ok(DryRunOutcome {
                blocked: true,
                guard_result,
                result: None,
                state,
            });
        }

        let (result, state) = host.dry_run(args, revset)?;
        Ok(DryRunOutcome {
            blocked: false,
            guard_result,
            result: Some(result),
            state,
        })
    }

    /// Dry-run every dry-runnable step of a recipe, stopping at the first blocked one.
    pub fn preview_pattern(
        &self,
        host: &dyn DryRunHost,
        recipe: &JjrRecipe,
        revset: Option<&str>,
        use_jev: bool,
    ) -> Result<Vec<PatternStepOutcome>, HostError> {
        let mut outcomes = Vec::new();
        for step in &recipe.steps {
            let Some(args) = step.args.as_deref().filter(|_| step.dry_runnable) else {
                outcomes.push(PatternStepOutcome {
                    title: step.title.clone(),
                    skipped: true,
                    reason: Some("Interactive or external step".to_owned()),
                    command: Some(step.command.clone()),
                    outcome: None,
                });
                continue;
            };
            let outcome = self.dry_run(host, args, revset, use_jev)?;
            let blocked = outcome.blocked;
            outcomes.push(PatternStepOutcome {
                title: step.title.clone(),
                skipped: false,
                reason: None,
                command: None,
                outcome: Some(outcome),
            });
            if blocked {
                break;
            }
        }
        Ok(outcomes)
    }

    /// Verify a range of revisions on `host` (`jj fix` as a formatting check
    /// plus the configured test command per revision). The results feed the
    /// Publishing Gate.
    pub fn verify_stack(
        &self,
        host: &dyn DryRunHost,
        range: Option<&str>,
        revset: Option<&str>,
    ) -> Result<StackVerification, HostError> {
        host.verify(range, revset.unwrap_or(DEFAULT_REVSET))
    }
}
