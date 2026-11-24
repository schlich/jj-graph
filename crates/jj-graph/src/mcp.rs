//! jj-graph over the Model Context Protocol.
//!
//! The same dry-run engine as the web UI, for agents: every jj command an
//! agent previews runs as an operation jj leaves out of the operation log,
//! passes the jjr guardrails first, and becomes real only with apply_plan.
//! The transport is stdio with newline-delimited JSON-RPC 2.0.

use std::io::BufRead as _;
use std::io::Write as _;
use std::sync::LazyLock;

use jjr::patterns::JjrPatterns;
use jjr::patterns::JjrRecipe;
use jjr::patterns::RedTestOptions;
use jjr::types::ForgeKind;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

use crate::app::ALLOWED;
use crate::app::App;
use crate::app::Query;
use crate::app::split_command_line;
use crate::error::AppError;
use crate::error::AppResult;

/// Protocol revisions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Characters of a change id the graph shows; dry_run expands them back.
const ID_LEN: usize = 12;
const MAX_TEXT: usize = 60_000;

static SHORT_CHANGE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[k-z]{8,31}$").unwrap());
static REV_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-z]{4,64}$").unwrap());

fn instructions() -> String {
    format!(
        "jj-graph previews Jujutsu commands before they touch the repository.

1. Call graph to see the revisions (change id, commit id, title, parents).
2. Call dry_run with one jj command at a time. jj runs it for real on top of the previous step, as an operation it leaves out of the operation log, so the working copy, Git refs and `jj log` stay as they were. The jjr guardrails check every step first and refuse one that would, for example, rewrite immutable history or stack on a divergent change, saying what to do instead.
3. Read the graph each step returns. plan_undo, plan_redo and plan_discard move through or drop the plan.
4. apply_plan makes the whole plan real in one operation. It returns an operation id that restore_operation takes to undo the apply.

Name changes by change id, not commit id: a change keeps its id when it is rewritten. Ids of {ID_LEN} characters as graph shows them are expanded to full ids, so a plan survives being replayed when the repository changes underneath it. Before publishing, verify_stack runs the configured build-and-test command in each revision and publish_plan says which layers of a stack can go out now."
    )
}

/// Patterns from jjr's recipes, with the parameters each one takes (`?` marks optional ones).
const RECIPES: &[(&str, &[&str])] = &[
    ("squash-workflow", &["description"]),
    ("edit-workflow", &["changeId", "prerequisite?"]),
    ("tidy-first", &["changeId", "description"]),
    (
        "characterization-tests",
        &["changeId", "area", "testCommand?"],
    ),
    (
        "tdd-red-test",
        &["paths", "changeId?", "redSnapshot?", "testCommand?"],
    ),
    ("branch-by-abstraction", &["subject"]),
    ("expand-contract", &["subject", "from?", "to?"]),
    ("isolate-activation", &["changeId", "flag"]),
    ("local-megamerge", &["arms", "prefix?"]),
    ("absorb-fixups", &["changeId?"]),
    (
        "extract-shared-primitive",
        &["arms", "description", "from?", "paths?"],
    ),
    ("resolve-conflict", &["changeId"]),
    ("stack-validation", &["range?", "testCommand?"]),
    ("compose-agent-workspaces", &["workspaces", "prefix?"]),
    ("post-merge-convergence", &["includeParkedSiblings?"]),
];

fn make_recipe(pattern: &str, p: &Value, default_test: Option<&str>) -> AppResult<JjrRecipe> {
    let s = |k: &str| p.get(k).and_then(Value::as_str);
    let list = |k: &str| -> AppResult<Vec<String>> {
        match p.get(k) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => Ok(items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()),
            Some(_) => Err(AppError::bad(format!("{k} is a list of strings."))),
        }
    };
    let req = |k: &str| s(k).unwrap_or_default();
    let test = s("testCommand").or(default_test);
    Ok(match pattern {
        "squash-workflow" => JjrPatterns::squash_workflow(req("description")),
        "edit-workflow" => JjrPatterns::edit_workflow(req("changeId"), s("prerequisite")),
        "tidy-first" => JjrPatterns::tidy_first_below(req("changeId"), req("description")),
        "characterization-tests" => {
            JjrPatterns::characterization_tests_below(req("changeId"), req("area"), test)
        }
        "tdd-red-test" => JjrPatterns::verify_red_test(
            &list("paths")?,
            &RedTestOptions {
                change_id: s("changeId").map(ToOwned::to_owned),
                red_snapshot: s("redSnapshot").map(ToOwned::to_owned),
                test_command: test.map(ToOwned::to_owned),
            },
        ),
        "branch-by-abstraction" => JjrPatterns::branch_by_abstraction(req("subject")),
        "expand-contract" => JjrPatterns::expand_contract(req("subject"), s("from"), s("to")),
        "isolate-activation" => JjrPatterns::isolate_activation(req("changeId"), req("flag")),
        "local-megamerge" => JjrPatterns::local_megamerge(&list("arms")?, s("prefix")),
        "absorb-fixups" => JjrPatterns::absorb_fixups(s("changeId")),
        "extract-shared-primitive" => JjrPatterns::extract_shared_primitive(
            &list("arms")?,
            req("description"),
            s("from"),
            &list("paths")?,
        ),
        "resolve-conflict" => JjrPatterns::resolve_conflict_cleanly(req("changeId")),
        "stack-validation" => JjrPatterns::stack_validation(s("range"), test),
        "compose-agent-workspaces" => {
            JjrPatterns::compose_agent_workspaces(&list("workspaces")?, s("prefix"))
        }
        "post-merge-convergence" => JjrPatterns::post_merge_convergence(
            p.get("includeParkedSiblings")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        other => {
            let known: Vec<&str> = RECIPES.iter().map(|(id, _)| *id).collect();
            return Err(AppError::bad(format!(
                "Unknown pattern \"{other}\". Known: {}.",
                known.join(", ")
            )));
        }
    })
}

fn clip(text: &str) -> String {
    if text.chars().count() > MAX_TEXT {
        format!(
            "{}\n… truncated at {MAX_TEXT} characters",
            text.chars().take(MAX_TEXT).collect::<String>()
        )
    } else {
        text.to_owned()
    }
}

fn short(id: &str, n: usize) -> String {
    id.chars().take(n).collect()
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The graph as one line per revision, newest first, for a model to read.
pub fn render_state(s: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    let nodes = arr(s, "nodes");
    let by_commit: std::collections::HashMap<&str, &Value> =
        nodes.iter().map(|n| (str_of(n, "id"), n)).collect();
    let touched: std::collections::HashSet<&str> =
        arr(s, "touched").iter().filter_map(Value::as_str).collect();
    let dry = &s["dry"];
    lines.push(format!("repo {}", str_of(s, "repo")));
    lines.push(format!(
        "revset {}{}",
        str_of(s, "revset"),
        if s["truncated"].as_bool() == Some(true) {
            " (only the first 400 revisions are shown)"
        } else {
            ""
        }
    ));
    if let Some(viewing) = s["viewing"].as_str() {
        lines.push(format!(
            "looking back at operation {}; the repository is at {}",
            short(viewing, ID_LEN),
            short(str_of(s, "head"), ID_LEN)
        ));
    } else if dry["active"].as_bool() == Some(true) {
        let steps = arr(dry, "steps");
        lines.push(format!(
            "DRY RUN: {} step(s) on operation {}. The repository is unchanged until apply_plan.",
            steps.len(),
            short(str_of(dry, "base"), ID_LEN)
        ));
        for (i, step) in steps.iter().enumerate() {
            lines.push(format!("  {}. {}", i + 1, str_of(step, "label")));
        }
        if s["rewound"].as_bool() == Some(true) {
            lines.push("  The plan rewinds the operation log (op restore/revert).".into());
        }
    } else {
        lines.push(format!(
            "live at operation {}; no dry run is open",
            short(str_of(s, "head"), ID_LEN)
        ));
    }
    let redo = arr(dry, "redo");
    if !redo.is_empty() {
        let labels: Vec<&str> = redo.iter().rev().filter_map(Value::as_str).collect();
        lines.push(format!("  redo: {}", labels.join(" ; ")));
    }
    if let Some(stale) = dry["stale"].as_str() {
        lines.push(format!("STALE PLAN: {stale} Undo that step or discard the plan; apply_plan is refused until then."));
    }
    lines.push(String::new());
    lines.push("@ working copy · ○ mutable · ◆ immutable · × conflicted · ← parents".into());
    let baseline = s["baseline"].as_object();
    for n in nodes {
        let flag = |k: &str| n[k].as_bool() == Some(true);
        let mark = if flag("wc") {
            '@'
        } else if flag("conflict") {
            '×'
        } else if flag("immutable") {
            '◆'
        } else {
            '○'
        };
        let change = str_of(n, "change");
        let id = str_of(n, "id");
        let was = baseline.and_then(|b| b.get(change)).and_then(Value::as_str);
        let mut commit = short(id, 8);
        if baseline.is_some() && was.is_none() {
            commit.push_str(" (new)");
        } else if let Some(was) = was
            && was != id
        {
            commit = format!("{}→{commit}", short(was, 8));
        }
        let mut refs: Vec<String> = arr(n, "bookmarks")
            .iter()
            .map(|b| {
                format!(
                    "{}{}",
                    str_of(b, "name"),
                    if b["conflict"].as_bool() == Some(true) {
                        "??"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        refs.extend(
            arr(n, "remotes")
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned),
        );
        refs.extend(
            arr(n, "tags")
                .iter()
                .filter_map(Value::as_str)
                .map(|t| format!("tag:{t}")),
        );
        refs.extend(
            arr(n, "workspaces")
                .iter()
                .filter_map(Value::as_str)
                .map(|w| format!("{w}@")),
        );
        let mut flags: Vec<String> = Vec::new();
        if flag("conflict") {
            flags.push("conflict".into());
        }
        if flag("divergent") {
            flags.push("divergent".into());
        }
        if flag("hidden") {
            flags.push("hidden".into());
        }
        let files = n["files"].as_u64().unwrap_or(0);
        if flag("empty") {
            flags.push("empty".into());
        } else if !flag("immutable") && files > 0 {
            flags.push(format!("{files} file{}", if files == 1 { "" } else { "s" }));
        }
        if touched.contains(change) {
            flags.push("edited by plan".into());
        } else if was.is_some_and(|was| was != id) {
            flags.push("auto-rebased".into());
        }
        if let Some(v) = s["jjr"]["verification"][change].as_str()
            && v != "unknown"
        {
            flags.push(v.to_owned());
        }
        let parents: Vec<String> = arr(n, "edges")
            .iter()
            .map(|e| match e["to"].as_str() {
                None => "~(outside revset)".to_owned(),
                Some(to) => {
                    let prefix = if e["indirect"].as_bool() == Some(true) {
                        "~"
                    } else {
                        ""
                    };
                    let target = by_commit
                        .get(to)
                        .map_or_else(|| short(to, 8), |p| short(str_of(p, "change"), ID_LEN));
                    format!("{prefix}{target}")
                }
            })
            .collect();
        let description = first_line(str_of(n, "description"));
        lines.push(format!(
            "{mark} {} {commit} {}{}{}{}",
            short(change, ID_LEN),
            if description.is_empty() {
                "(no description)"
            } else {
                description
            },
            if refs.is_empty() {
                String::new()
            } else {
                format!(" [{}]", refs.join(", "))
            },
            if flags.is_empty() {
                String::new()
            } else {
                format!(" ({})", flags.join(", "))
            },
            if parents.is_empty() {
                String::new()
            } else {
                format!(" ← {}", parents.join(", "))
            },
        ));
    }
    let jjr = &s["jjr"];
    if jjr.is_object() {
        lines.push(String::new());
        let sum = &jjr["summary"];
        lines.push(format!(
            "jjr: {} shape, {}; {} mutable, {} conflicted, {} divergent",
            str_of(sum, "shape"),
            str_of(sum, "status"),
            sum["mutableCount"],
            sum["conflictedCount"],
            sum["divergentCount"]
        ));
        for d in arr(jjr, "diagnostics") {
            lines.push(format!(
                "  [{}] {}: {}",
                str_of(d, "severity"),
                str_of(d, "code"),
                str_of(d, "message")
            ));
            if let Some(fix) = d["suggestedCommand"].as_str() {
                lines.push(format!("    fix: {fix}"));
            }
        }
    }
    lines.join("\n")
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_verification(v: &Value) -> String {
    let command = v["command"].as_str();
    let mut lines = vec![format!(
        "Verified {} at operation {} with {}.",
        str_of(v, "range"),
        short(str_of(v, "op"), ID_LEN),
        command.map_or_else(|| "no verify command".to_owned(), |c| format!("`{c}`"))
    )];
    let results = arr(v, "results");
    for r in results {
        let mark = match str_of(r, "state") {
            "green" => '✓',
            "red" => '✗',
            _ => '?',
        };
        lines.push(format!(
            "{mark} {} {} {}",
            short(str_of(r, "changeId"), ID_LEN),
            short(str_of(r, "commitId"), 8),
            str_of(r, "title")
        ));
        if r["formatted"].as_bool() == Some(false) {
            let files: Vec<&str> = arr(r, "unformattedFiles")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            lines.push(format!("    unformatted: {}", files.join(", ")));
        }
        if str_of(r, "state") == "red" && !str_of(r, "output").is_empty() {
            lines.push(indent(str_of(r, "output")));
        }
    }
    if results.is_empty() {
        lines.push("No mutable revisions in that range.".into());
    }
    let f = &v["formatter"];
    lines.push(if let Some(err) = f["error"].as_str() {
        format!("jj fix failed: {err}")
    } else if f["configured"].as_bool() == Some(true) {
        format!(
            "jj fix: {} of {} revisions would change.",
            f["fixed"], f["checked"]
        )
    } else {
        "No jj fix tools are configured.".into()
    });
    let sum = &v["summary"];
    let skipped = v["skipped"].as_u64().unwrap_or(0);
    lines.push(format!(
        "{} green, {} red, {} unknown{}.",
        sum["green"],
        sum["red"],
        sum["unknown"],
        if skipped > 0 {
            format!("; {skipped} more not checked")
        } else {
            String::new()
        }
    ));
    if let Some(hint) = v["hint"].as_str() {
        lines.push(hint.to_owned());
    }
    lines.join("\n")
}

fn render_publish_plan(p: &Value) -> String {
    let mut lines = vec![format!(
        "Publishing {} with {} ({}), bottom layer first:",
        short(str_of(p, "head"), ID_LEN),
        str_of(&p["adapter"], "name"),
        str_of(p, "forge")
    )];
    for l in arr(p, "layers") {
        let mark = if l["publishable"].as_bool() == Some(true) {
            '✓'
        } else {
            '·'
        };
        lines.push(format!(
            "{mark} {} {} {}",
            short(str_of(l, "changeId"), ID_LEN),
            short(str_of(l, "commitId"), 8),
            str_of(l, "title")
        ));
        for r in arr(l, "reasons").iter().filter_map(Value::as_str) {
            lines.push(format!("    keep local: {r}"));
        }
        for w in arr(l, "warnings").iter().filter_map(Value::as_str) {
            lines.push(format!("    warning: {w}"));
        }
    }
    let commands: Vec<&str> = arr(p, "commands")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    lines.push(if commands.is_empty() {
        "Nothing can be published yet.".into()
    } else {
        format!(
            "Commands:\n{}",
            commands
                .iter()
                .map(|c| format!("  {c}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    });
    let caveats: Vec<&str> = arr(&p["adapter"], "caveats")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if !caveats.is_empty() {
        lines.push(format!("Caveats: {}", caveats.join(" ")));
    }
    lines.join("\n")
}

fn render_recipe(r: &JjrRecipe) -> String {
    let mut lines = vec![
        format!("{}: {}", r.id, r.pattern),
        r.summary.clone(),
        String::new(),
    ];
    for (i, step) in r.steps.iter().enumerate() {
        lines.push(format!("{}. {}", i + 1, step.title));
        lines.push(format!("   {}", step.command));
        lines.push(match (&step.args, step.dry_runnable) {
            (Some(args), true) => format!(
                "   dry_run args: {}",
                serde_json::to_string(args).unwrap_or_default()
            ),
            _ => "   not dry-runnable: run it yourself or adapt it".into(),
        });
        lines.push(format!("   holds: {}", step.invariant));
    }
    lines.join("\n")
}

/// One tool, as `tools/list` describes it.
struct Tool {
    name: &'static str,
    title: &'static str,
    description: String,
    input_schema: Value,
    read_only: bool,
    destructive: bool,
    idempotent: Option<bool>,
    open_world: bool,
}

fn str_prop(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn str_list(description: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": description })
}

fn tools() -> Vec<Tool> {
    let revset = str_prop(
        "Revset to draw. Default: revsets.log from jj config, else all(). At most 400 revisions.",
    );
    let at = str_prop(
        "Operation id (8 or more hex characters, from op_log) to look at instead of the current state.",
    );
    let rev = str_prop(
        "A revision: change id or prefix, commit id, bookmark, or a revset that resolves to one revision. Default: the working copy (@).",
    );
    let tool = |name,
                title,
                description: String,
                input_schema,
                read_only,
                destructive,
                idempotent,
                open_world| Tool {
        name,
        title,
        description,
        input_schema,
        read_only,
        destructive,
        idempotent,
        open_world,
    };
    let recipe_list: Vec<String> = RECIPES
        .iter()
        .map(|(id, uses)| format!("{id} ({})", uses.join(", ")))
        .collect();
    let forges: Vec<&str> = ForgeKind::ALL.iter().map(|f| f.as_str()).collect();
    let recipe_ids: Vec<&str> = RECIPES.iter().map(|(id, _)| *id).collect();
    vec![
        tool(
            "graph",
            "Revision graph",
            "Draw the revision graph: the dry-run preview while a plan is open, the live repository otherwise, or an earlier operation with `at`. One line per revision, newest first: change id, commit id (old→new when the plan rewrote it), title, bookmarks and workspaces, state, and parents (←). Then the jjr shape and diagnostics, each with a fix to dry-run.".into(),
            json!({ "type": "object", "properties": {
                "revset": revset, "at": at,
                "format": { "type": "string", "enum": ["text", "json"], "description": "\"json\" returns every field of every revision, including touched file paths." },
            } }),
            true, false, None, false,
        ),
        tool(
            "dry_run",
            "Dry-run a jj command",
            format!(
                "Add one jj command to the plan as a dry run. jj runs it for real on top of the previous step, as an operation it leaves out of the operation log, so the repository, working copy and Git refs stay as they are until apply_plan. The jjr guardrails check the step first and refuse it, with the reason and what to do instead, when it would rewrite immutable history, stack on a divergent change, edit a megamerge, and so on. Allowed commands: {}, op restore and op revert. Refused: anything interactive (split needs paths), --ignore-immutable, and commands with effects outside the repository such as git push. Returns jj's output, guardrail warnings, and the graph after the step.",
                ALLOWED.join(", ")
            ),
            json!({ "type": "object", "properties": {
                "command": str_prop("The jj command line, quoted as in a shell, for example `rebase -s xyz -o main` or `describe xyz -m \"Fix the parser\"`. A leading \"jj\" is dropped."),
                "args": str_list("The command as a list of arguments, instead of `command`."),
                "revset": revset,
            } }),
            false, false, Some(false), false,
        ),
        tool(
            "plan_undo",
            "Undo dry-run steps",
            "Take the last step (or `count` steps) off the plan. They stay available to plan_redo until another dry_run.".into(),
            json!({ "type": "object", "properties": { "count": { "type": "integer", "minimum": 1, "description": "Steps to undo (default 1)." }, "revset": revset } }),
            false, false, None, false,
        ),
        tool(
            "plan_redo",
            "Redo dry-run steps",
            "Put back the last undone step (or `count` of them), replayed on the current state.".into(),
            json!({ "type": "object", "properties": { "count": { "type": "integer", "minimum": 1, "description": "Steps to redo (default 1)." }, "revset": revset } }),
            false, false, None, false,
        ),
        tool(
            "plan_discard",
            "Discard the dry run",
            "Forget the whole plan. Nothing in the repository changes; the plan's operations are left for `jj util gc`.".into(),
            json!({ "type": "object", "properties": { "revset": revset } }),
            false, false, Some(true), false,
        ),
        tool(
            "apply_plan",
            "Apply the dry run",
            "Make the plan real: `jj op integrate` on its last step, then `jj workspace update-stale`. Edits made to the working copy while the plan was open are kept. Returns the operation to pass to restore_operation to undo the whole apply. Refused while the plan is stale.".into(),
            json!({ "type": "object", "properties": { "revset": revset } }),
            false, true, Some(false), false,
        ),
        tool(
            "restore_operation",
            "Restore an operation",
            "Run `jj op restore` for real: put every change, bookmark and working copy back as they were at an earlier operation, and drop any open plan. Use it to undo apply_plan with the operation it returned. To preview a restore first, dry_run `op restore <id>` instead.".into(),
            json!({ "type": "object", "properties": { "op": str_prop("Operation id, 8 or more hex characters."), "revset": revset }, "required": ["op"] }),
            false, true, Some(true), false,
        ),
        tool(
            "op_log",
            "Operation log",
            "The newest operations, newest first. Pass an id as `at` to graph, show or evolog to look at the repository as it was, or dry_run `op restore <id>` to preview going back.".into(),
            json!({ "type": "object", "properties": {} }),
            true, false, None, false,
        ),
        tool(
            "show",
            "Show a revision",
            "A revision's description and changed files (`stat`) or full Git-style diff (`diff`), as of the plan's last step while a dry run is open.".into(),
            json!({ "type": "object", "properties": { "rev": rev, "mode": { "type": "string", "enum": ["stat", "diff"], "description": "Default: stat." }, "at": at } }),
            true, false, None, false,
        ),
        tool(
            "evolog",
            "Evolution of a change",
            "Every version a change has had, newest first, with the operation that made each. dry_run `restore --from <commit> --into <change>` puts one version back without rewinding anything else.".into(),
            json!({ "type": "object", "properties": { "rev": rev, "at": at } }),
            true, false, None, false,
        ),
        tool(
            "diagnose",
            "Diagnose the graph",
            "The jjr reading of the graph: its canonical shape, diagnostics with dry-runnable fixes (structural changes above behavioral ones, edited megamerges, conflicts, arms based on an old trunk, deep stacks, Git features jj ignores), suggested recipes, and a short narrated summary.".into(),
            json!({ "type": "object", "properties": { "revset": revset, "at": at } }),
            true, false, None, true,
        ),
        tool(
            "preflight",
            "Pre-flight check",
            "Where trunk() and immutable_heads() resolve, divergent changes, colocation, remotes, forge, and Git features jj does not support. Every guardrail depends on these.".into(),
            json!({ "type": "object", "properties": { "at": at } }),
            true, false, None, false,
        ),
        tool(
            "guard",
            "Check an action against the guardrails",
            "Ask the jjr guardrails about an action without doing it. dry_run already checks every jj command it runs; use this for what it cannot run: pushing changes (`push`), a raw Git command in a colocated repository (`git-interop`), moving bookmarks (`bookmark`), or adding a workspace (`workspace-add`). Change ids may be prefixes.".into(),
            json!({ "type": "object", "properties": {
                "action": { "type": "object", "description": "The action to check.", "properties": {
                    "type": { "type": "string", "enum": ["push", "git-interop", "bookmark", "workspace-add", "mutate"] },
                    "targetChanges": str_list("push, bookmark, mutate: the changes affected."),
                    "bookmark": str_prop("push: the bookmark being pushed."),
                    "bookmarks": str_list("bookmark: the bookmark names."),
                    "rawGitCommand": str_prop("git-interop: the Git command line, for example \"git commit -am wip\"."),
                    "reason": { "type": "string", "enum": ["switch-branch", "parallel-build-or-agent"], "description": "workspace-add: why the workspace is wanted." },
                    "command": str_prop("mutate: the jj command, for display."),
                    "args": str_list("mutate: the jj argument list."),
                }, "required": ["type"] },
                "useJev": { "type": "boolean", "description": "Also ask TypeSafe Jev for a scratchpad and blast-radius risk reading." },
                "diffExcerpt": str_prop("With useJev: the diff being acted on."),
                "at": at,
            }, "required": ["action"] }),
            true, false, None, true,
        ),
        tool(
            "verify_stack",
            "Verify a stack",
            "Check each mutable revision in `range`, as it stands in the plan or the repository, without keeping any change: `jj fix` for formatting and the configured build-and-test command (jj-graph --verify-command, or jj config jjr.verify-command) through `jj run`. The results feed the Publishing Gate and publish_plan. Can take minutes.".into(),
            json!({ "type": "object", "properties": { "range": str_prop("Revset of revisions to verify. Default: trunk()..@."), "revset": revset } }),
            false, false, Some(true), false,
        ),
        tool(
            "publish_plan",
            "Plan publishing",
            "Which bottom layers of the stack under `rev` can be published now (conflict-free, non-empty, formatted, verified green, not a local megamerge) and the forge commands to do it. Run verify_stack first so layers can be green. This tool publishes nothing.".into(),
            json!({ "type": "object", "properties": {
                "rev": str_prop("Head of the stack: change id or prefix. Default: the working copy."),
                "forge": { "type": "string", "enum": forges, "description": "Default: jj config jjr.forge, else github-bookmarks." },
                "at": at,
            } }),
            true, false, None, false,
        ),
        tool(
            "triage",
            "Triage a change",
            "Classify a change in one pass with TypeSafe Jev (or its calibrated offline fallback): its intent (structural, behavioral, test-harness, activation, ...), whether it tangles unrelated work, how ready it is to publish, debug code or secrets left in, and new APIs without a consumer.".into(),
            json!({ "type": "object", "properties": { "rev": str_prop("Change id, prefix or `@`. Default: the working copy."), "at": at } }),
            true, false, None, true,
        ),
        tool(
            "assess_dependency",
            "Stack or parallelize two changes",
            "The Two-Part Dependency Gate: does `child` need `base` to build or make sense, and can `base` be reviewed on its own? Answers stack, parallelize, collapse or confirm (ask the user), with the jj command for the outcome. Give both booleans to decide it yourself; otherwise Jev reads both diffs.".into(),
            json!({ "type": "object", "properties": {
                "base": str_prop("Change id or prefix of the lower change."),
                "child": str_prop("Change id or prefix of the change that may depend on it."),
                "childCausallyDependsOnBase": { "type": "boolean" },
                "baseIndependentlyReviewable": { "type": "boolean" },
                "at": at,
            }, "required": ["base", "child"] }),
            true, false, None, true,
        ),
        tool(
            "suggest_name",
            "Suggest a description",
            "A conventional commit title and bookmark slug for a change, from its diff (an LLM when JJR_LLM_API_KEY or OPENAI_API_KEY is set, a deterministic rule otherwise). Dry-run `describe <change> -m <title>` to use it.".into(),
            json!({ "type": "object", "properties": { "rev": str_prop("Change id, prefix or `@`. Default: the working copy."), "at": at } }),
            true, false, None, true,
        ),
        tool(
            "recipe",
            "Workflow recipe",
            format!(
                "The steps of a jjr workflow pattern, each with the exact jj command and, when it can be previewed, the args to pass to dry_run. Patterns and the parameters they use (? = optional): {}.",
                recipe_list.join("; ")
            ),
            json!({ "type": "object", "properties": {
                "pattern": { "type": "string", "enum": recipe_ids },
                "changeId": str_prop("The change the pattern works on."),
                "description": str_prop("Description for the change the pattern creates."),
                "prerequisite": str_prop("edit-workflow: what has to land below the edited change."),
                "area": str_prop("characterization-tests: the code being characterized."),
                "testCommand": str_prop("The test command to run in revisions. Default: the configured verify command."),
                "paths": str_list("tdd-red-test: implementation files the probe takes away; extract-shared-primitive: files holding the primitive."),
                "redSnapshot": str_prop("tdd-red-test: a red snapshot from the change's evolog, such as `xkpunxsx/2` or a commit id."),
                "subject": str_prop("branch-by-abstraction: the seam; expand-contract: what is being migrated."),
                "from": str_prop("expand-contract: the old path; extract-shared-primitive: the change holding the primitive now."),
                "to": str_prop("expand-contract: the new path."),
                "flag": str_prop("isolate-activation: the feature flag that switches the behavior on."),
                "arms": str_list("Change ids of parallel arms."),
                "prefix": str_prop("Description prefix for a local-only megamerge."),
                "range": str_prop("stack-validation: revset of the stack. Default: trunk()..@."),
                "workspaces": str_list("compose-agent-workspaces: workspace names."),
                "includeParkedSiblings": { "type": "boolean", "description": "post-merge-convergence: also rebase parked sibling arms." },
            }, "required": ["pattern"] }),
            true, false, None, false,
        ),
    ]
}

/// The MCP server for one jj-graph engine.
pub struct McpServer {
    app: App,
    verify_command: Option<String>,
    /// The graph the agent last saw: short change ids are expanded against it.
    last_state: Option<Value>,
    tools: Vec<Tool>,
}

impl McpServer {
    pub fn new(app: App, verify_command: Option<String>) -> Self {
        Self {
            app,
            verify_command,
            last_state: None,
            tools: tools(),
        }
    }

    pub fn app(&self) -> &App {
        &self.app
    }

    fn get(&mut self, route: &str, params: &[(&str, Option<&str>)]) -> AppResult<Value> {
        let query: Query = params
            .iter()
            .filter_map(|(k, v)| {
                v.filter(|v| !v.is_empty())
                    .map(|v| ((*k).to_owned(), v.to_owned()))
            })
            .collect();
        self.app.handle("GET", route, &query, None)
    }

    fn post(&mut self, route: &str, body: Value) -> AppResult<Value> {
        self.app.handle("POST", route, &Query::new(), Some(&body))
    }

    fn remember(&mut self, state: &Value) {
        if state.get("nodes").is_some() {
            self.last_state = Some(state.clone());
        }
    }

    /// Expand change-id prefixes the graph showed to full ids, which survive a plan's replay.
    fn expand_ids(&self, args: &[String]) -> Vec<String> {
        let nodes = self
            .last_state
            .as_ref()
            .map(|s| arr(s, "nodes"))
            .unwrap_or(&[]);
        args.iter()
            .enumerate()
            .map(|(i, a)| {
                let after_message = i > 0 && (args[i - 1] == "-m" || args[i - 1] == "--message");
                if !SHORT_CHANGE_ID.is_match(a) || after_message {
                    return a.clone();
                }
                let mut hits: Vec<&str> = nodes
                    .iter()
                    .map(|n| str_of(n, "change"))
                    .filter(|c| c.starts_with(a.as_str()))
                    .collect();
                hits.dedup();
                let unique: std::collections::HashSet<&str> = hits.iter().copied().collect();
                if unique.len() == 1 {
                    hits[0].to_owned()
                } else {
                    a.clone()
                }
            })
            .collect()
    }

    /// A revision in the form /api/show and /api/evolog take, resolving `@`, `x-` and other revsets.
    fn revision(&mut self, rev: Option<&str>, at: Option<&str>) -> AppResult<String> {
        if let Some(rev) = rev
            && REV_ID.is_match(rev)
        {
            return Ok(rev.to_owned());
        }
        let s = self.get(
            "/api/state",
            &[("revset", Some(rev.unwrap_or("@"))), ("at", at)],
        )?;
        let nodes = arr(&s, "nodes");
        if nodes.len() != 1 {
            return Err(AppError::bad(format!(
                "\"{}\" resolves to {} revisions; name exactly one.",
                rev.unwrap_or("@"),
                nodes.len()
            )));
        }
        Ok(str_of(&nodes[0], "id").to_owned())
    }

    fn run_tool(&mut self, name: &str, a: &Value) -> AppResult<String> {
        let s = |k: &str| a.get(k).and_then(Value::as_str);
        let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
        match name {
            "graph" => {
                let state = self.get("/api/state", &[("revset", s("revset")), ("at", s("at"))])?;
                self.remember(&state);
                Ok(if s("format") == Some("json") {
                    state.to_string()
                } else {
                    render_state(&state)
                })
            }
            "dry_run" => {
                let args: Vec<String> = match (
                    a.get("args").and_then(Value::as_array),
                    s("command"),
                ) {
                    (Some(list), _) => list
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .map(ToOwned::to_owned)
                                .unwrap_or_else(|| v.to_string())
                        })
                        .collect(),
                    (None, Some(command)) => split_command_line(command)?,
                    (None, None) => {
                        return Err(AppError::bad(
                            "Give the jj command as `command` (a string) or `args` (a list of strings).",
                        ));
                    }
                };
                if self.last_state.is_none() {
                    let state = self.get("/api/state", &[("revset", s("revset"))])?;
                    self.remember(&state);
                }
                let list = self.expand_ids(&args);
                let mut body = json!({ "args": list });
                if let Some(revset) = s("revset") {
                    body["revset"] = json!(revset);
                }
                let r = self.post("/api/dry", body)?;
                let state = r["state"].clone();
                self.remember(&state);
                let changed = r["result"]["changed"].as_bool() == Some(true);
                let mut lines = vec![if changed {
                    let steps = arr(&state["dry"], "steps");
                    format!(
                        "Step {}: {}",
                        steps.len(),
                        steps.last().map(|s| str_of(s, "label")).unwrap_or("")
                    )
                } else {
                    "Nothing changed: the repository or plan already has this effect, so no step was added.".to_owned()
                }];
                let output = str_of(&r["result"], "output");
                if changed && !output.is_empty() {
                    lines.push(output.to_owned());
                }
                for w in arr(&r["result"], "warnings") {
                    let remediation = w["remediation"]
                        .as_str()
                        .map(|r| format!(" {r}"))
                        .unwrap_or_default();
                    lines.push(format!(
                        "warning [{}]: {}{remediation}",
                        str_of(w, "rule"),
                        str_of(w, "message")
                    ));
                }
                Ok(format!("{}\n\n{}", lines.join("\n"), render_state(&state)))
            }
            "plan_undo" => {
                let n = self.app.plan().steps.len();
                if n == 0 {
                    return Err(AppError::bad("There is no dry-run step to undo."));
                }
                let count = a.get("count").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
                let r = self.post(
                    "/api/goto",
                    json!({ "steps": n.saturating_sub(count), "revset": s("revset") }),
                )?;
                self.remember(&r["state"]);
                Ok(format!(
                    "Undid {} step(s).\n\n{}",
                    count.min(n),
                    render_state(&r["state"])
                ))
            }
            "plan_redo" => {
                let n = self.app.plan().redo.len();
                if n == 0 {
                    return Err(AppError::bad("There is nothing to redo."));
                }
                let count = a.get("count").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
                let target = self.app.plan().steps.len() + count.min(n);
                let r = self.post(
                    "/api/goto",
                    json!({ "steps": target, "revset": s("revset") }),
                )?;
                self.remember(&r["state"]);
                Ok(format!(
                    "Redid {} step(s).\n\n{}",
                    count.min(n),
                    render_state(&r["state"])
                ))
            }
            "plan_discard" => {
                let r = self.post("/api/discard", json!({ "revset": s("revset") }))?;
                self.remember(&r["state"]);
                Ok(format!(
                    "Discarded the plan.\n\n{}",
                    render_state(&r["state"])
                ))
            }
            "apply_plan" => {
                let r = self.post("/api/apply", json!({ "revset": s("revset") }))?;
                self.remember(&r["state"]);
                let output = str_of(&r["result"], "output");
                Ok(format!(
                    "Applied {} step(s). To undo the whole apply, call restore_operation with op \"{}\".{}\n\n{}",
                    r["result"]["applied"],
                    str_of(&r["result"], "undoOp"),
                    if output.is_empty() {
                        String::new()
                    } else {
                        format!("\n{output}")
                    },
                    render_state(&r["state"])
                ))
            }
            "restore_operation" => {
                let op = s("op").unwrap_or_default();
                let r = self.post("/api/restore", json!({ "op": op, "revset": s("revset") }))?;
                self.remember(&r["state"]);
                let output = str_of(&r["result"], "output");
                Ok(format!(
                    "Restored the repository to operation {}.{}\n\n{}",
                    short(op, ID_LEN),
                    if output.is_empty() {
                        String::new()
                    } else {
                        format!("\n{output}")
                    },
                    render_state(&r["state"])
                ))
            }
            "op_log" => {
                let state = self.get("/api/state", &[("revset", Some("@"))])?;
                let head = str_of(&state, "head");
                let mut lines: Vec<String> = arr(&state, "ops")
                    .iter()
                    .map(|o| {
                        format!(
                            "{} {} {} {}{}",
                            if str_of(o, "id") == head { '▸' } else { ' ' },
                            short(str_of(o, "id"), ID_LEN),
                            str_of(o, "time"),
                            str_of(o, "description"),
                            if o["snapshot"].as_bool() == Some(true) {
                                " (snapshot)"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect();
                if state["dry"]["active"].as_bool() == Some(true) {
                    lines.insert(
                        0,
                        format!(
                            "A dry run of {} step(s) is open on {}; its steps are not in the log.",
                            arr(&state["dry"], "steps").len(),
                            short(str_of(&state["dry"], "base"), ID_LEN)
                        ),
                    );
                }
                Ok(lines.join("\n"))
            }
            "show" => {
                let rev = self.revision(s("rev"), s("at"))?;
                let r = self.get(
                    "/api/show",
                    &[("rev", Some(&rev)), ("mode", s("mode")), ("at", s("at"))],
                )?;
                Ok(clip(str_of(&r, "text")))
            }
            "evolog" => {
                let rev = self.revision(s("rev"), s("at"))?;
                let r = self.get("/api/evolog", &[("rev", Some(&rev)), ("at", s("at"))])?;
                Ok(arr(&r, "versions")
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let description = str_of(v, "description");
                        format!(
                            "{}. {} {} {}{}",
                            i + 1,
                            short(str_of(v, "commit"), 12),
                            str_of(v, "time"),
                            if description.is_empty() {
                                "(no description)"
                            } else {
                                description
                            },
                            v["operation"]
                                .as_str()
                                .map(|o| format!(" ← {o}"))
                                .unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            "diagnose" => Ok(pretty(&self.get(
                "/api/jjr/diagnose",
                &[("revset", s("revset")), ("at", s("at"))],
            )?)),
            "preflight" => Ok(pretty(&self.get("/api/jjr/preflight", &[("at", s("at"))])?)),
            "guard" => {
                let mut body = json!({ "action": a.get("action").cloned().unwrap_or(Value::Null) });
                for key in ["useJev", "diffExcerpt", "at"] {
                    if let Some(v) = a.get(key) {
                        body[key] = v.clone();
                    }
                }
                Ok(pretty(&self.post("/api/jjr/guard", body)?))
            }
            "verify_stack" => {
                let r = self.post(
                    "/api/jjr/verify",
                    json!({ "range": s("range"), "revset": s("revset") }),
                )?;
                self.remember(&r["state"]);
                Ok(render_verification(&r))
            }
            "publish_plan" => Ok(render_publish_plan(&self.post(
                "/api/jjr/publish-plan",
                json!({ "rev": s("rev"), "forge": s("forge"), "at": s("at") }),
            )?)),
            "triage" => Ok(pretty(
                &self.post("/api/jjr/triage", json!({ "rev": s("rev"), "at": s("at") }))?,
            )),
            "assess_dependency" => Ok(pretty(&self.post("/api/jjr/dependency", a.clone())?)),
            "suggest_name" => Ok(pretty(&self.post(
                "/api/jjr/suggest-name",
                json!({ "rev": s("rev"), "at": s("at") }),
            )?)),
            "recipe" => {
                let pattern = s("pattern").unwrap_or_default();
                let Some((_, uses)) = RECIPES.iter().find(|(id, _)| *id == pattern) else {
                    let known: Vec<&str> = RECIPES.iter().map(|(id, _)| *id).collect();
                    return Err(AppError::bad(format!(
                        "Unknown pattern \"{pattern}\". Known: {}.",
                        known.join(", ")
                    )));
                };
                let missing: Vec<&str> = uses
                    .iter()
                    .filter(|u| !u.ends_with('?'))
                    .filter(|u| {
                        a.get(**u)
                            .is_none_or(|v| v.is_null() || v.as_str() == Some(""))
                    })
                    .copied()
                    .collect();
                if !missing.is_empty() {
                    return Err(AppError::bad(format!(
                        "{pattern} needs: {}.",
                        missing.join(", ")
                    )));
                }
                let recipe = make_recipe(pattern, a, self.verify_command.as_deref())?;
                Ok(render_recipe(&recipe))
            }
            other => Err(AppError::bad(format!("Unknown tool: {other}"))),
        }
    }

    fn call_tool(&mut self, name: &str, args: &Value) -> Option<Value> {
        let tool = self.tools.iter().find(|t| t.name == name)?;
        let required: Vec<String> = tool.input_schema["required"]
            .as_array()
            .map(|r| {
                r.iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let missing: Vec<String> = required
            .into_iter()
            .filter(|k| args.get(k).is_none_or(Value::is_null))
            .collect();
        let result = if missing.is_empty() {
            self.run_tool(name, args)
        } else {
            Err(AppError::bad(format!(
                "Missing argument{}: {}.",
                if missing.len() > 1 { "s" } else { "" },
                missing.join(", ")
            )))
        };
        Some(match result {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(err) => {
                json!({ "content": [{ "type": "text", "text": err.message }], "isError": true })
            }
        })
    }

    fn listing(&self) -> Value {
        Value::Array(
            self.tools
                .iter()
                .map(|t| {
                    let mut annotations = json!({ "title": t.title, "readOnlyHint": t.read_only, "openWorldHint": t.open_world });
                    if !t.read_only {
                        annotations["destructiveHint"] = json!(t.destructive);
                    }
                    if let Some(idempotent) = t.idempotent {
                        annotations["idempotentHint"] = json!(idempotent);
                    }
                    json!({ "name": t.name, "title": t.title, "description": t.description, "inputSchema": t.input_schema, "annotations": annotations })
                })
                .collect(),
        )
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let asked = params["protocolVersion"].as_str().unwrap_or("");
                let version = if PROTOCOL_VERSIONS.contains(&asked) {
                    asked
                } else {
                    PROTOCOL_VERSIONS[0]
                };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "jj-graph", "title": "jj-graph", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": instructions(),
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.listing() })),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or("");
                let args = params
                    .get("arguments")
                    .filter(|a| !a.is_null())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                self.call_tool(name, &args)
                    .ok_or_else(|| (-32602, format!("Unknown tool: {name}")))
            }
            // Not a tool: the full state the web UI draws, graph, jjr reading
            // and this server's plan included, for a client that shows the
            // agent's work to its user (the OpenCode plugin's views).
            "jj-graph/state" => {
                let revset = params["revset"].as_str();
                self.get("/api/state", &[("revset", revset)])
                    .map_err(|err| (-32000, err.message))
            }
            other => Err((-32601, format!("Method not found: {other}"))),
        }
    }

    /// One JSON-RPC message (or batch) in, its response out; `None` when none is due.
    pub fn handle(&mut self, message: &Value) -> Option<Value> {
        if let Some(batch) = message.as_array() {
            let out: Vec<Value> = batch.iter().filter_map(|m| self.handle(m)).collect();
            return (!out.is_empty()).then_some(Value::Array(out));
        }
        let Some(obj) = message.as_object() else {
            return Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Invalid request." } }),
            );
        };
        let method = obj.get("method").and_then(Value::as_str);
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_none() {
            // Responses to requests we never send need no answer.
            if method.is_none() && (obj.contains_key("result") || obj.contains_key("error")) {
                return None;
            }
            return Some(
                json!({ "jsonrpc": "2.0", "id": obj.get("id").cloned().unwrap_or(Value::Null), "error": { "code": -32600, "message": "Invalid request." } }),
            );
        }
        let id = obj.get("id").cloned();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        let result = self.request(method.unwrap_or_default(), &params);
        let id = id?;
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        })
    }
}

/// Serve `server` over newline-delimited JSON-RPC on stdin and stdout.
pub fn serve_stdio(server: &mut McpServer) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(message) => server.handle(&message),
            Err(_) => Some(
                json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error." } }),
            ),
        };
        if let Some(response) = response {
            writeln!(stdout, "{response}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}
