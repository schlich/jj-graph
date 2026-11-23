//! jjr: the framework layer of jj-graph.
//!
//! - [`types`]: identity and state vocabulary (change, commit and operation
//!   ids, intents, zones, verification).
//! - [`commands`]: which revisions each jj command rewrites, only reads, or
//!   points a bookmark at.
//! - [`graph`]: the revision DAG, its canonical shape, the Two-Part
//!   Dependency Test, and diagnostics with dry-runnable fixes.
//! - [`guardrails`]: the rules every dry-run step, bookmark, push, Git
//!   command and workspace creation passes.
//! - [`patterns`]: dry-runnable workflow recipes, forge adapters, the SDLC
//!   lifecycle and time-travel recovery plans.
//! - [`runner`]: guarded planning and layered publishing.
//! - [`jev`]: TypeSafe Jev System-One decisions with a calibrated offline
//!   fallback.
//! - [`narrator`]: the System-Two prose layer for names and summaries.
//! - [`ui`]: render-agnostic view models with TUI and GUI adapters.

pub mod commands;
pub mod graph;
pub mod guardrails;
pub mod jev;
pub mod narrator;
pub mod patterns;
pub mod runner;
pub mod types;
pub mod ui;

pub use commands::describe_mutation;
pub use commands::extract_mutated_targets;
pub use commands::parse_jj_args;
pub use graph::GraphNode;
pub use graph::JjrChange;
pub use graph::JjrGraph;
pub use graph::PreflightFacts;
pub use guardrails::GuardrailAction;
pub use guardrails::JjrGuardrailPipeline;
pub use jev::JjrJevAssistant;
pub use narrator::JjrNarrator;
pub use patterns::JjrPatterns;
pub use runner::JjrRunner;
pub use types::ChangeIntent;
pub use types::JjrRepoConfig;
pub use types::verification_state;
