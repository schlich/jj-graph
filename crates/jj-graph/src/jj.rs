//! Writing through the jj CLI.
//!
//! Every operation jj-graph writes (snapshots, dry-run steps, `op
//! integrate`, `op restore`, `jj fix` and `jj run`) is run by `jj` itself, so
//! command-line semantics, working-copy updates and Git import/export are
//! exactly jj's. Reads go through jj-lib (see `repo.rs`).

use std::io::Read as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use crate::error::AppError;

/// The output of a jj invocation that exited with an accepted code.
#[derive(Clone, Debug, Default)]
pub struct JjOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// How to run one jj command.
#[derive(Clone, Debug, Default)]
pub struct JjRun<'a> {
    pub at_op: Option<&'a str>,
    /// Exit codes that count as success (default: 0).
    pub ok: &'a [i32],
    /// Kill jj after this long (default: never).
    pub timeout: Option<Duration>,
}

/// The `jj` binary, run in one repository.
#[derive(Clone, Debug)]
pub struct JjCli {
    program: PathBuf,
    repo: PathBuf,
}

impl JjCli {
    /// `jj` from `$JJ_GRAPH_JJ` or `PATH`, run in `repo`.
    pub fn new(repo: &Path) -> Self {
        let program =
            std::env::var_os("JJ_GRAPH_JJ").map_or_else(|| PathBuf::from("jj"), PathBuf::from);
        Self {
            program,
            repo: repo.to_owned(),
        }
    }

    /// Run `jj --color never --no-pager [--at-op OP] ARGS...` with editors
    /// disabled, the way the JS server did.
    pub fn run<S: AsRef<str>>(&self, args: &[S], options: JjRun<'_>) -> Result<JjOutput, AppError> {
        let mut cmd = Command::new(&self.program);
        cmd.args(["--color", "never", "--no-pager"]);
        if let Some(op) = options.at_op {
            cmd.args(["--at-op", op]);
        }
        cmd.args(args.iter().map(AsRef::as_ref))
            .current_dir(&self.repo)
            .env("JJ_EDITOR", "true")
            .env("EDITOR", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                AppError::new(500, "jj is not on PATH.")
            } else {
                AppError::new(500, format!("Could not run jj: {err}"))
            }
        })?;
        // Drain both pipes on their own threads so a chatty command cannot block.
        let mut stdout_pipe = child.stdout.take().expect("piped stdout");
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let out_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout_pipe.read_to_end(&mut buf);
            buf
        });
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut buf);
            buf
        });
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|err| AppError::new(500, err.to_string()))?
            {
                break status;
            }
            if let Some(limit) = options.timeout
                && started.elapsed() > limit
            {
                let _ = child.kill();
                let _ = child.wait();
                let name = args.first().map_or("", AsRef::as_ref);
                return Err(AppError::bad(format!(
                    "jj {name} timed out after {}s.",
                    limit.as_secs()
                )));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();
        let code = status.code().unwrap_or(1);
        let ok: &[i32] = if options.ok.is_empty() {
            &[0]
        } else {
            options.ok
        };
        if !ok.contains(&code) {
            let message = stderr.trim();
            return Err(AppError::bad(if message.is_empty() {
                format!("jj exited with {code}")
            } else {
                message.to_owned()
            }));
        }
        Ok(JjOutput {
            stdout,
            stderr,
            code,
        })
    }

    /// `jj --version`, for the startup check that the CLI matches jj-lib.
    pub fn version(&self) -> Option<String> {
        let out = Command::new(&self.program)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }
}
