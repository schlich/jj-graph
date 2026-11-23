use std::path::PathBuf;
use std::process::ExitCode;

use jj_graph::app::App;
use jj_graph::app::AppOptions;
use jj_graph::repo::RepoContext;

const USAGE: &str = "Usage:
  jj-graph [REPO] [--port 7777] [--host 127.0.0.1] [--verify-command CMD]

Serves the web UI for REPO (default: the current directory). With a host
other than loopback (for a phone on your network), the URL carries a token
and the API refuses requests without it.

--verify-command is the build-and-test command run in each revision by
\"Verify stack\" (default: jj config jjr.verify-command).";

struct Options {
    repo: PathBuf,
    port: u16,
    host: String,
    verify_command: Option<String>,
}

fn parse_cli() -> Result<Option<Options>, String> {
    let mut args = std::env::args().skip(1);
    let mut opts = Options {
        repo: std::env::current_dir().map_err(|e| e.to_string())?,
        port: 7777,
        host: "127.0.0.1".into(),
        verify_command: None,
    };
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" | "-p" => {
                opts.port = args
                    .next()
                    .and_then(|p| p.parse().ok())
                    .ok_or("--port needs a port number")?;
            }
            "--host" => opts.host = args.next().ok_or("--host needs a host")?,
            "--verify-command" => {
                opts.verify_command = Some(args.next().ok_or("--verify-command needs a command")?)
            }
            "--help" | "-h" => return Ok(None),
            other if other.starts_with('-') => return Err(format!("Unknown option {other}")),
            path => opts.repo = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)),
        }
    }
    Ok(Some(opts))
}

fn main() -> ExitCode {
    let opts = match parse_cli() {
        Ok(Some(opts)) => opts,
        Ok(None) => {
            eprintln!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(err) => {
            eprintln!("jj-graph: {err}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let root = match RepoContext::load(&opts.repo) {
        Ok(ctx) => ctx.workspace_root().to_owned(),
        Err(err) => {
            eprintln!(
                "jj-graph: {} is not in a jj repository.\n{err}",
                opts.repo.display()
            );
            return ExitCode::FAILURE;
        }
    };
    let mut app = App::new(
        &root,
        AppOptions {
            verify_command: opts.verify_command.clone(),
            ..Default::default()
        },
    );
    match app.jj().version() {
        None => eprintln!(
            "jj-graph: warning: `jj` is not on PATH; dry runs and every other write need it."
        ),
        Some(v) if !v.contains(jj_graph::JJ_VERSION) => {
            eprintln!(
                "jj-graph: warning: built on jj {} but `jj` is {v}; repository formats may differ.",
                jj_graph::JJ_VERSION
            );
        }
        Some(_) => {}
    }
    let loopback = ["127.0.0.1", "localhost", "::1"].contains(&opts.host.as_str());
    let token = (!loopback).then(|| {
        rand::random::<[u8; 16]>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    });
    let shown = if opts.host == "0.0.0.0" || opts.host == "::" {
        "<this-machine>"
    } else {
        opts.host.as_str()
    };
    println!("jj-graph serving {}", root.display());
    println!(
        "  http://{shown}:{}/{}",
        opts.port,
        token
            .as_ref()
            .map(|t| format!("#token={t}"))
            .unwrap_or_default()
    );
    match jj_graph::server::serve(&mut app, (opts.host.as_str(), opts.port), token.as_deref()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("jj-graph: {err}");
            ExitCode::FAILURE
        }
    }
}
