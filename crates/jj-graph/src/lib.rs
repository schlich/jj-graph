//! jj-graph: a DAG-centred web UI for Jujutsu, with dry runs of every jj
//! command.
//!
//! - [`repo`] reads repositories in-process with jj-lib, configured the way
//!   the jj CLI configures itself.
//! - [`jj`] writes every operation through the jj CLI, so command semantics,
//!   working-copy updates and Git import/export are exactly jj's.
//! - [`app`] is the dry-run engine and its JSON API.
//! - [`server`] serves the web UI and the API over HTTP.

pub mod app;
pub mod error;
pub mod jj;
pub mod repo;
pub mod server;

/// The jj release whose libraries jj-graph is built on; the `jj` it drives
/// for writes should match it.
pub const JJ_VERSION: &str = "0.47.1";
