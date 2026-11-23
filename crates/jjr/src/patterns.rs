//! SDLC patterns: dry-runnable workflow recipes, forge adapters, the
//! six-phase lifecycle, time-travel recovery plans, and the recipes a graph
//! calls for.
//!
//! Every recipe produces exact, copyable `jj` commands and the argv a dry
//! run takes (`jj --at-op <tip> --no-integrate-operation ...`). Steps that
//! run external programs or need a human (`jj run`, `jj resolve`) are not
//! dry-runnable.
//!
//! Port of `jjr/patterns.mjs`.

use serde::Deserialize;
use serde::Serialize;

use crate::graph::JjrChange;
use crate::graph::JjrGraph;
use crate::types::ChangeIntent;
use crate::types::ForgeKind;
use crate::types::Zone;
use crate::types::format_short_id;
use crate::types::short;

/// One step of a recipe. `args` is the jj argv to pass to a dry run when
/// the step can be previewed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternStep {
    pub title: String,
    pub args: Option<Vec<String>>,
    pub command: String,
    pub dry_runnable: bool,
    pub invariant: String,
}

/// A workflow pattern as a sequence of jj steps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JjrRecipe {
    pub id: String,
    pub pattern: String,
    pub summary: String,
    pub steps: Vec<PatternStep>,
}

/// `JSON.stringify` of a string: how jjr quotes free text in a command.
fn q(s: &str) -> String {
    serde_json::Value::from(s).to_string()
}

fn argv(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn step(
    title: &str,
    args: Option<Vec<String>>,
    command: impl Into<String>,
    dry_runnable: bool,
    invariant: impl Into<String>,
) -> PatternStep {
    PatternStep {
        title: title.to_owned(),
        args,
        command: command.into(),
        dry_runnable,
        invariant: invariant.into(),
    }
}

fn recipe(
    id: &str,
    pattern: &str,
    summary: impl Into<String>,
    steps: Vec<PatternStep>,
) -> JjrRecipe {
    JjrRecipe {
        id: id.to_owned(),
        pattern: pattern.to_owned(),
        summary: summary.into(),
        steps,
    }
}

/// A JavaScript-truthy string: present and non-empty.
fn present(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// How a review tool takes a stack.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAdapter {
    pub kind: ForgeKind,
    pub name: &'static str,
    pub model_alignment: &'static str,
    pub rewrite_propagation: &'static str,
    pub strengths: &'static [&'static str],
    pub caveats: &'static [&'static str],
    pub needs_bookmark: bool,
    /// Uploads a whole stack from its top change.
    pub stack_aware: bool,
}

impl ForgeAdapter {
    /// The command that publishes `change_id` with this forge.
    pub fn publish(&self, change_id: &str) -> String {
        let id = short(change_id);
        match self.kind {
            ForgeKind::Gerrit => format!("jj gerrit upload -r {id}"),
            ForgeKind::GithubBookmarks => format!("jj git push -c {id}"),
            ForgeKind::GithubStack => format!("jj-stack submit {id}"),
            ForgeKind::GithubSpr => format!("jj-spr diff -r {id}"),
        }
    }
}

// Forge Integration Matrix: how each publishing bridge maps jj's model.
static GERRIT: ForgeAdapter = ForgeAdapter {
    kind: ForgeKind::Gerrit,
    name: "Gerrit (jj gerrit upload)",
    model_alignment: "Native 1:1: the Gerrit Change-Id matches the jj change id",
    rewrite_propagation: "Re-uploading creates a new patch set on the same Gerrit change",
    strengths: &[
        "Zero bookmark overhead",
        "Native stacks",
        "Automatic trailers",
    ],
    caveats: &[
        "Server-side trailers can alter remote commit ids unless local commit trailers are configured (templates.commit_trailers)",
    ],
    needs_bookmark: false,
    stack_aware: true,
};

static GITHUB_BOOKMARKS: ForgeAdapter = ForgeAdapter {
    kind: ForgeKind::GithubBookmarks,
    name: "GitHub native bookmarks (jj git push)",
    model_alignment: "Moderate: one bookmark = one Git branch",
    rewrite_propagation: "Safe force-push (--force-with-lease semantics)",
    strengths: &[
        "Works everywhere with no extra tooling",
        "jj git push -c creates the bookmark",
    ],
    caveats: &[
        "Force-pushes can disrupt GitHub incremental review diffs",
        "Stacks need one bookmark per layer",
    ],
    needs_bookmark: true,
    stack_aware: false,
};

static GITHUB_STACK: ForgeAdapter = ForgeAdapter {
    kind: ForgeKind::GithubStack,
    name: "GitHub native stacks (jj-stack / gh stack)",
    model_alignment: "High: one local change = one PR",
    rewrite_propagation: "jj-stack tracks PRs by change id and updates bases and branches automatically",
    strengths: &[
        "Native GitHub stack UI",
        "Hides bookkeeping branches",
        "Crash-recoverable",
    ],
    caveats: &[
        "Reordering middle commits with manual gh stack requires unstacking first to avoid false-merged PR states",
    ],
    needs_bookmark: false,
    stack_aware: true,
};

static GITHUB_SPR: ForgeAdapter = ForgeAdapter {
    kind: ForgeKind::GithubSpr,
    name: "GitHub append-only (jj-spr)",
    model_alignment: "High locally, translated remotely",
    rewrite_propagation: "Amend and squash freely locally; jj-spr appends commits to PR branches and squash-lands",
    strengths: &[
        "Preserves GitHub \"since last review\" diffs",
        "--cherry-pick lands independent PRs in any order",
    ],
    caveats: &[
        "Requires direct repository write access (no fork PRs)",
        "Incompatible with GitHub native stacks",
    ],
    needs_bookmark: false,
    stack_aware: false,
};

/// The adapter for a forge.
pub fn forge_adapter(kind: ForgeKind) -> &'static ForgeAdapter {
    match kind {
        ForgeKind::Gerrit => &GERRIT,
        ForgeKind::GithubBookmarks => &GITHUB_BOOKMARKS,
        ForgeKind::GithubStack => &GITHUB_STACK,
        ForgeKind::GithubSpr => &GITHUB_SPR,
    }
}

/// Every forge adapter, in the order jjr documents them.
pub fn forge_adapters() -> Vec<&'static ForgeAdapter> {
    ForgeKind::ALL.into_iter().map(forge_adapter).collect()
}

/// Options for [`JjrPatterns::verify_red_test`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RedTestOptions {
    /// The change under test (its tests and implementation together).
    pub change_id: Option<String>,
    pub description: Option<String>,
    pub test_command: Option<String>,
}

/// The recipe constructors.
pub struct JjrPatterns;

impl JjrPatterns {
    /// Squash workflow: describe the intent first, work in an empty `@` on
    /// top, flush finished hunks down. Failed experiments are `jj abandon`ed.
    pub fn squash_workflow(description: &str) -> JjrRecipe {
        recipe(
            "squash-workflow",
            "Squash Workflow (Describe, Scratchpad, Flush)",
            "Name the unit of work before writing it, experiment in an empty @, and move finished hunks down.",
            vec![
                step(
                    "Describe the intended change",
                    Some(argv(&["describe", "-m", description])),
                    format!("jj describe -m {}", q(description)),
                    true,
                    "@ names one coherent intention before any code exists.",
                ),
                step(
                    "Open an empty scratchpad on top",
                    Some(argv(&["new"])),
                    "jj new",
                    true,
                    "Experiments happen in @; the described change stays clean.",
                ),
                step(
                    "Flush finished hunks down",
                    Some(argv(&["squash"])),
                    "jj squash   # or: jj squash <path>, jj squash -i",
                    true,
                    "Failed experiments are discarded with `jj abandon`.",
                ),
            ],
        )
    }

    /// Edit workflow: edit the target in place, insert newly discovered
    /// prerequisites below `@`, and walk the stack with `next`/`prev --edit`.
    pub fn edit_workflow(change_id: &str, prerequisite: Option<&str>) -> JjrRecipe {
        let mut steps = vec![step(
            "Edit the target change in place",
            Some(argv(&["edit", change_id])),
            format!("jj edit {}", short(change_id)),
            true,
            "Edits amend the change directly; its change id stays stable.",
        )];
        if let Some(prerequisite) = present(prerequisite) {
            steps.push(step(
                "Insert a newly discovered prerequisite below @",
                Some(argv(&["new", "-B", "@", "-m", prerequisite])),
                format!("jj new -B @ -m {}", q(prerequisite)),
                true,
                "Descendants auto-rebase onto the prerequisite.",
            ));
        }
        steps.push(step(
            "Walk the stack",
            Some(argv(&["next", "--edit"])),
            "jj next --edit   # or: jj prev --edit",
            true,
            "Each step edits one node of the stack in place.",
        ));
        recipe(
            "edit-workflow",
            "Edit Workflow (In-Place Stack Editing)",
            "Put @ on the change itself for focused single-node work; descendants rebase automatically.",
            steps,
        )
    }

    /// Tidy First?: insert a structural refactor beneath active behavioral work.
    pub fn tidy_first_below(behavioral_change_id: &str, description: &str) -> JjrRecipe {
        let id = behavioral_change_id;
        let msg = format!("refactor: {description}");
        recipe(
            "tidy-first",
            "Tidy First? (Structural Below Behavioral)",
            "Isolate zero-behavior-change cleanup beneath behavioral work for low-risk review and clean revert.",
            vec![
                step(
                    "Insert structural change directly below active work",
                    Some(argv(&["new", "-B", id, "-m", &msg])),
                    format!("jj new -B {} -m {}", short(id), q(&msg)),
                    true,
                    "Descendants auto-rebase onto the structural commit cleanly.",
                ),
                step(
                    "Split tangled edits if already mixed in the behavioral change",
                    Some(argv(&["split", "-r", id])),
                    format!("jj split -r {}", short(id)),
                    false,
                    "Structural layer builds and passes tests on its own.",
                ),
            ],
        )
    }

    /// Characterization tests before a refactor of untested code: a
    /// test-only change slipped below the refactor locks existing behavior
    /// down first. `test_command` defaults to `<test command>`.
    pub fn characterization_tests_below(
        refactor_change_id: &str,
        area: &str,
        test_command: Option<&str>,
    ) -> JjrRecipe {
        let id = refactor_change_id;
        let s = short(id);
        let test_command = test_command.unwrap_or("<test command>");
        let msg = format!("test: characterize {area}");
        recipe(
            "characterization-tests",
            "Characterization Tests Before Refactors",
            "Lock down existing behavior in a test-only change below the refactor, so reviewers and CI see it hold before structure moves.",
            vec![
                step(
                    "Insert a test-only change below the refactor",
                    Some(argv(&["new", "--no-edit", "-B", id, "-m", &msg])),
                    format!("jj new --no-edit -B {s} -m {}", q(&msg)),
                    true,
                    "The refactor now sits on top of its safety net.",
                ),
                step(
                    "Write the characterization tests there",
                    Some(vec!["edit".to_owned(), format!("{id}-")]),
                    format!("jj edit {s}-"),
                    true,
                    "The tests pass against the old structure.",
                ),
                step(
                    "Verify both sides of the refactor",
                    None,
                    format!("jj run --ignore-changes -r '{s}- | {s}' -- {test_command}"),
                    false,
                    "Behavior is identical before and after the structural change.",
                ),
            ],
        )
    }

    /// TDD Red-Test Verification: temporarily lift the implementation into a
    /// parallel sibling so the tests prove they fail without it, then fold the
    /// tests back. `jj split` keeps the change id on the selected
    /// (implementation) side and gives the remaining tests a new id, so the
    /// tests fold into the implementation and the change keeps its id. No red
    /// commit stays in the DAG. `test_command` defaults to `npm test`.
    pub fn verify_red_test(impl_files: &[String], opts: &RedTestOptions) -> JjrRecipe {
        let change_id = present(opts.change_id.as_deref());
        let description = present(opts.description.as_deref());
        let test_command = opts.test_command.as_deref().unwrap_or("npm test");
        let target = change_id.map_or("<change>", short);
        let edit_change = |title: &str, invariant: &str| {
            change_id.map(|id| {
                step(
                    title,
                    Some(argv(&["edit", id])),
                    format!("jj edit {target}"),
                    true,
                    invariant,
                )
            })
        };

        let mut split_args = argv(&["split", "--parallel"]);
        if let Some(d) = description {
            split_args.extend(argv(&["-m", d]));
        }
        split_args.extend(impl_files.iter().cloned());
        let split_message = description
            .map(|d| format!("-m {} ", q(d)))
            .unwrap_or_default();

        let mut steps = Vec::new();
        steps.extend(edit_change(
            "Put the working copy on the change under test",
            "@ holds the behavior together with its tests.",
        ));
        steps.push(step(
            "Lift implementation into a parallel sibling change",
            Some(split_args),
            format!(
                "jj split --parallel {split_message}{}",
                impl_files.join(" ")
            ),
            true,
            "The implementation keeps the change id; @ becomes a tests-only sibling.",
        ));
        steps.push(step(
            "Run the tests without the implementation (expect red)",
            None,
            format!("jj run --ignore-changes -r @ -- {test_command}"),
            false,
            "A failing run proves the tests exercise the new behavior.",
        ));
        steps.push(step(
            "Fold the tests back into the implementation change",
            change_id.map(|id| {
                argv(&[
                    "squash",
                    "--from",
                    "@",
                    "--into",
                    id,
                    "--use-destination-message",
                ])
            }),
            format!("jj squash --from @ --into {target} --use-destination-message"),
            change_id.is_some(),
            "One self-verifying green revision again, under its original change id.",
        ));
        steps.extend(edit_change(
            "Return to the change",
            "The temporary tests-only change is gone.",
        ));
        recipe(
            "tdd-red-test",
            "TDD Red-Test Verification",
            "Verify tests fail without the implementation, without polluting final history with failing commits.",
            steps,
        )
    }

    /// Branch by Abstraction: a five-step buildable subsystem swap.
    pub fn branch_by_abstraction(seam_name: &str) -> JjrRecipe {
        let seam = seam_name;
        let extract = format!("refactor: extract {seam} interface");
        let dark = format!("feat: add new {seam} implementation (dark)");
        let activate = format!("feat: activate new {seam}");
        let remove = format!("chore: remove legacy {seam}");
        let inline = format!("refactor: inline {seam} seam");
        recipe(
            "branch-by-abstraction",
            "Branch by Abstraction (5-Step Subsystem Swap)",
            format!(
                "Replace a legacy subsystem behind \"{seam}\" with zero broken intermediate commits."
            ),
            vec![
                step(
                    "1. Introduce abstraction seam",
                    Some(argv(&["new", "trunk()", "-m", &extract])),
                    format!("jj new trunk() -m \"{extract}\""),
                    true,
                    "Zero behavior change; existing test suite stays green.",
                ),
                step(
                    "2. Implement replacement dark (unwired)",
                    Some(argv(&["new", "-m", &dark])),
                    format!("jj new -m \"{dark}\""),
                    true,
                    "Covered by unit tests; not wired to production traffic.",
                ),
                step(
                    "3. Flip activation switch",
                    Some(argv(&["new", "-m", &activate])),
                    format!("jj new -m \"{activate}\""),
                    true,
                    "Tiny isolated change; one-commit rollback if production regresses.",
                ),
                step(
                    "4. Remove legacy implementation",
                    Some(argv(&["new", "-m", &remove])),
                    format!("jj new -m \"{remove}\""),
                    true,
                    "Landed only after the new path stabilizes.",
                ),
                step(
                    "5. Contract abstraction (optional)",
                    Some(argv(&["new", "-m", &inline])),
                    format!("jj new -m \"{inline}\""),
                    true,
                    "Keep the seam if it remains useful for testing.",
                ),
            ],
        )
    }

    /// Parallel Change (Expand & Contract) for breaking API, signature, or
    /// schema changes: expand, migrate, contract, each buildable on its own.
    /// `from` and `to` default to "the old path" and "the new path".
    pub fn expand_contract(subject: &str, from: Option<&str>, to: Option<&str>) -> JjrRecipe {
        let from = from.unwrap_or("the old path");
        let to = to.unwrap_or("the new path");
        let expand = format!("feat: expand {subject} with {to}");
        let migrate = format!("refactor: migrate {subject} callers to {to}");
        let contract = format!("chore: contract {subject}, remove {from}");
        recipe(
            "expand-contract",
            "Parallel Change (Expand & Contract)",
            format!(
                "Change {subject} without a breaking intermediate state: add {to} beside {from}, migrate, then delete {from}."
            ),
            vec![
                step(
                    "1. Expand: add the new path alongside the old",
                    Some(argv(&["new", "trunk()", "-m", &expand])),
                    format!("jj new trunk() -m {}", q(&expand)),
                    true,
                    format!("Existing callers of {from} keep working; {to} is exercised by tests."),
                ),
                step(
                    "2. Migrate: move callers and data (dual-write, backfill)",
                    Some(argv(&["new", "-m", &migrate])),
                    format!("jj new -m {}", q(&migrate)),
                    true,
                    "Each migration step builds on its own; repeat per group of consumers.",
                ),
                step(
                    "3. Contract: delete the legacy path",
                    Some(argv(&["new", "-m", &contract])),
                    format!("jj new -m {}", q(&contract)),
                    true,
                    "Lands only once every consumer has migrated, often as a later topic.",
                ),
            ],
        )
    }

    /// Separate plumbing from activation: flip the user-facing switch in its
    /// own tiny change on top of the finished, dark implementation.
    pub fn isolate_activation(stack_head_change_id: &str, flag: &str) -> JjrRecipe {
        let id = stack_head_change_id;
        let msg = format!("feat: activate {flag}");
        recipe(
            "isolate-activation",
            "Isolated Activation Switch",
            format!(
                "Keep the implementation dark and flip {flag} in a tiny top-level change, so a rollback reverts one switch."
            ),
            vec![
                step(
                    "Add the activation switch on top of the plumbing",
                    Some(argv(&["new", id, "-m", &msg])),
                    format!("jj new {} -m {}", short(id), q(&msg)),
                    true,
                    "The switch lands last and reverts alone.",
                ),
                step(
                    "If the switch is still mixed into the plumbing, split it out",
                    None,
                    format!("jj split -r {}", short(id)),
                    false,
                    "Plumbing changes behavior only once the switch flips.",
                ),
            ],
        )
    }

    /// Local octopus megamerge for simultaneous multi-arm integration
    /// testing. `prefix` defaults to `local: dev megamerge`.
    pub fn local_megamerge(arms: &[String], prefix: Option<&str>) -> JjrRecipe {
        let prefix = prefix.unwrap_or("local: dev megamerge");
        let mut args = argv(&["new"]);
        args.extend(arms.iter().cloned());
        args.extend(argv(&["-m", prefix]));
        let shorts: Vec<&str> = arms.iter().map(|id| short(id)).collect();
        recipe(
            "local-megamerge",
            "Local-Only Octopus Megamerge",
            "Compose parallel feature arms locally for full-app testing without coupling their histories.",
            vec![
                step(
                    "Create tagged octopus merge combining parallel arms",
                    Some(args),
                    format!("jj new {} -m {}", shorts.join(" "), q(prefix)),
                    true,
                    "Tagged with local prefix; MegamergeFence hard-blocks pushing it.",
                ),
                step(
                    "Open empty working copy on top for integration fixes",
                    Some(argv(&["new"])),
                    "jj new",
                    true,
                    "Keeps the megamerge node itself clean.",
                ),
                step(
                    "Route scattered fixups back to their owning arms",
                    Some(argv(&["absorb"])),
                    "jj absorb",
                    true,
                    "Unambiguous hunks flow automatically to the ancestor that last touched those lines.",
                ),
            ],
        )
    }

    /// Route integration fixups made atop (or inside) a megamerge to their arms.
    pub fn absorb_fixups(polluted_megamerge_id: Option<&str>) -> JjrRecipe {
        let mut steps = Vec::new();
        if let Some(id) = present(polluted_megamerge_id) {
            steps.push(step(
                "Move edits out of the megamerge itself",
                Some(argv(&["absorb", "--from", id])),
                format!("jj absorb --from {}", short(id)),
                true,
                "The megamerge returns to a pure composition node.",
            ));
        }
        steps.push(step(
            "Absorb working-copy fixups",
            Some(argv(&["absorb"])),
            "jj absorb",
            true,
            "Unambiguous hunks land in their owning arms.",
        ));
        steps.push(step(
            "Squash each ambiguous hunk into its arm",
            None,
            "jj squash --into <arm> <paths>   # Jev routeHunk ranks candidate arms",
            false,
            "Nothing that belongs to an arm stays in @ or the megamerge.",
        ));
        recipe(
            "absorb-fixups",
            "Absorb Fixups Into Their Arms",
            "Send each fixup hunk to the arm that last touched those lines; ambiguous hunks stay for a manual squash.",
            steps,
        )
    }

    /// When composition reveals a primitive several arms need, extract it
    /// into a common ancestor beneath them instead of stacking one arm on
    /// another. `from` (where the primitive's hunks live now) defaults to `@`.
    pub fn extract_shared_primitive(
        arms: &[String],
        description: &str,
        from: Option<&str>,
        paths: &[String],
    ) -> JjrRecipe {
        let from = from.unwrap_or("@");
        let common = arms
            .iter()
            .map(|id| format!("{id}-"))
            .collect::<Vec<_>>()
            .join(" & ");
        let common_short = arms
            .iter()
            .map(|id| format!("{}-", short(id)))
            .collect::<Vec<_>>()
            .join(" & ");

        let mut insert_args = argv(&["new", "--no-edit"]);
        for id in arms {
            insert_args.extend(["-B".to_owned(), id.clone()]);
        }
        insert_args.extend(argv(&["-m", description]));
        let insert_flags = arms
            .iter()
            .map(|id| format!("-B {}", short(id)))
            .collect::<Vec<_>>()
            .join(" ");

        let squash_args = (!paths.is_empty()).then(|| {
            let mut args = argv(&["squash", "--from", from, "--into", &common]);
            args.extend(paths.iter().cloned());
            args
        });
        let shown_from = if from == "@" { "@" } else { short(from) };
        let shown_paths = if paths.is_empty() {
            "-i".to_owned()
        } else {
            paths.join(" ")
        };
        recipe(
            "extract-shared-primitive",
            "Extract Shared Primitive Into a Common Ancestor",
            "Let dependencies emerge empirically: the primitive goes beneath every arm that needs it; the arms stay parallel.",
            vec![
                step(
                    "Insert one change beneath every arm",
                    Some(insert_args),
                    format!("jj new --no-edit {insert_flags} -m {}", q(description)),
                    true,
                    "The new change is the common parent of the arms; they remain siblings.",
                ),
                step(
                    "Move the primitive into it",
                    squash_args,
                    format!("jj squash --from {shown_from} --into '{common_short}' {shown_paths}"),
                    !paths.is_empty(),
                    "Each arm now depends on the primitive, and on nothing else.",
                ),
            ],
        )
    }

    /// Clean conflict resolution: resolve in a child, inspect, squash down.
    pub fn resolve_conflict_cleanly(conflicted_change_id: &str) -> JjrRecipe {
        let id = conflicted_change_id;
        recipe(
            "resolve-conflict",
            "Clean Conflict Resolution",
            "Resolve in a child commit so the resolution is reviewable on its own, then fold it into the conflicted change.",
            vec![
                step(
                    "Open a resolution child on the conflicted change",
                    Some(argv(&["new", id])),
                    format!("jj new {}", short(id)),
                    true,
                    "The conflicted change is untouched while you work.",
                ),
                step(
                    "Resolve the conflict markers",
                    None,
                    "jj resolve   # or edit the markers in your editor",
                    false,
                    "No conflict markers remain in @.",
                ),
                step(
                    "Inspect the exact resolution",
                    None,
                    "jj diff",
                    false,
                    "The diff of @ is the resolution and nothing else.",
                ),
                step(
                    "Fold the resolution down",
                    Some(argv(&["squash"])),
                    "jj squash",
                    true,
                    "The resolution propagates cleanly to every descendant.",
                ),
            ],
        )
    }

    /// Stack-wide validation before publishing: format every mutable
    /// revision with `jj fix`, then build and test each one with `jj run`.
    /// `range` defaults to `trunk()..@` and `test_command` to `<test command>`.
    pub fn stack_validation(range: Option<&str>, test_command: Option<&str>) -> JjrRecipe {
        let range = range.unwrap_or("trunk()..@");
        let test_command = test_command.unwrap_or("<test command>");
        let revs = format!("({range}) & mutable()");
        let roots = format!("roots({revs})");
        recipe(
            "stack-validation",
            "Stack-Wide Validation",
            "Every publishable node is formatted, builds, and passes its tests on its own, so the stack stays bisectable.",
            vec![
                step(
                    "Format every mutable revision in the range",
                    Some(argv(&["fix", "-s", &roots])),
                    format!("jj fix -s '{roots}'"),
                    true,
                    "Fixes land in the revision that introduced the code; descendants keep them.",
                ),
                step(
                    "Build and test every revision",
                    None,
                    format!("jj run --ignore-changes -r '{revs}' -- {test_command}"),
                    false,
                    "Each revision is green on its own (jj bisect run stays meaningful).",
                ),
            ],
        )
    }

    /// Multi-agent composition: an orchestrator joins the agents' working
    /// copies (`<workspace>@`) in a local megamerge, with no Git worktree
    /// branch locks. `prefix` defaults to `local: agents megamerge`.
    pub fn compose_agent_workspaces(workspaces: &[String], prefix: Option<&str>) -> JjrRecipe {
        let prefix = prefix.unwrap_or("local: agents megamerge");
        let heads: Vec<String> = workspaces.iter().map(|w| format!("{w}@")).collect();
        let mut args = argv(&["new"]);
        args.extend(heads.iter().cloned());
        args.extend(argv(&["-m", prefix]));
        recipe(
            "compose-agent-workspaces",
            "Compose Agent Workspaces",
            "Parallel agents work in their own jj workspaces; the orchestrator composes their outputs in one local megamerge.",
            vec![
                step(
                    "Join the agents' working copies in a local megamerge",
                    Some(args),
                    format!("jj new {} -m {}", heads.join(" "), q(prefix)),
                    true,
                    "Never pushed; MegamergeFence blocks it.",
                ),
                step(
                    "Open an empty scratchpad on top",
                    Some(argv(&["new"])),
                    "jj new",
                    true,
                    "Integration fixes start in @.",
                ),
                step(
                    "Route integration fixes back to each agent's arm",
                    Some(argv(&["absorb"])),
                    "jj absorb",
                    true,
                    "Each fix lands in the arm that owns the lines.",
                ),
            ],
        )
    }

    /// Post-merge convergence loop: sync upstream and return to the minimal
    /// resting state. (jj 0.47 accepts several revisions for `-s` without the
    /// old `all:` prefix.)
    pub fn post_merge_convergence(include_parked_siblings: bool) -> JjrRecipe {
        let root_expr = if include_parked_siblings {
            "roots(mutable())"
        } else {
            "roots(trunk()..@)"
        };
        recipe(
            "post-merge-convergence",
            "Post-Merge Convergence Loop",
            "Fetch landed upstream commits, collapse empty rebased changes, and rebase active roots onto trunk().",
            vec![
                step(
                    "Fetch upstream and drop landed remote branches",
                    None,
                    "jj git fetch",
                    false,
                    "Landed commits cross into immutable(); deleted remotes clear local bookmarks.",
                ),
                step(
                    "Atomic bulk rebase onto trunk()",
                    Some(argv(&[
                        "rebase",
                        "-s",
                        root_expr,
                        "-o",
                        "trunk()",
                        "--skip-emptied",
                    ])),
                    format!("jj rebase -s '{root_expr}' -o 'trunk()' --skip-emptied"),
                    true,
                    "Changes whose diffs already landed become empty and collapse.",
                ),
                step(
                    "Confirm the resting state",
                    None,
                    "jj log -r 'mutable()'",
                    false,
                    "Once everything landed, a single empty @ sits directly atop trunk().",
                ),
            ],
        )
    }

    /// The command that publishes `change_id` with `forge`.
    pub fn publish_command(forge: ForgeKind, change_id: &str) -> String {
        forge_adapter(forge).publish(change_id)
    }
}

/// One phase of the SDLC lifecycle and the recipes that serve it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SdlcPhase {
    pub phase: u8,
    pub name: &'static str,
    pub discipline: &'static str,
    pub recipes: &'static [&'static str],
}

static SDLC_LIFECYCLE: [SdlcPhase; 6] = [
    SdlcPhase {
        phase: 1,
        name: "Discovery / Spike",
        discipline: "Work anonymously and freely in @; ignore commit hygiene while exploring the design space.",
        recipes: &["squash-workflow"],
    },
    SdlcPhase {
        phase: 2,
        name: "Safety Net",
        discipline: "Before modifying untested legacy code, insert characterization tests below active work (jj new -B).",
        recipes: &["characterization-tests"],
    },
    SdlcPhase {
        phase: 3,
        name: "Structural Prep (Tidy / Expand)",
        discipline: "Extract prerequisite refactors, interface seams, or backward-compatible schema expansions beneath behavioral work.",
        recipes: &["tidy-first", "expand-contract", "branch-by-abstraction"],
    },
    SdlcPhase {
        phase: 4,
        name: "Behavioral Implementation",
        discipline: "Build cohesive vertical slices with bundled tests: parallel siblings when independent, shallow causal stacks when strictly ordered.",
        recipes: &["tdd-red-test", "edit-workflow", "squash-workflow"],
    },
    SdlcPhase {
        phase: 5,
        name: "Integration & Verification",
        discipline: "Compose arms in a megamerge, route fixups with jj absorb, format with jj fix, and verify every publishable node is green.",
        recipes: &[
            "local-megamerge",
            "absorb-fixups",
            "extract-shared-primitive",
            "resolve-conflict",
            "stack-validation",
        ],
    },
    SdlcPhase {
        phase: 6,
        name: "Activation & Cleanup (Contract)",
        discipline: "Publish layer by layer as each becomes self-contained, flip flags in an isolated change, then contract and converge.",
        recipes: &[
            "isolate-activation",
            "expand-contract",
            "post-merge-convergence",
        ],
    },
];

/// The six-phase lifecycle: the graph state and discipline of each phase,
/// with the recipes (by id) that serve it.
pub fn sdlc_lifecycle() -> &'static [SdlcPhase] {
    &SDLC_LIFECYCLE
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryScope {
    SingleChange,
    RepoWide,
    Undo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimeAxis {
    Evolog,
    OpLog,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlastRadius {
    SingleChange,
    RepoWide,
}

/// What to recover and to which point.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeTravelParams {
    pub scope: RecoveryScope,
    #[serde(default)]
    pub target_op_id: Option<String>,
    #[serde(default)]
    pub target_change_id: Option<String>,
    #[serde(default)]
    pub target_evolog_commit: Option<String>,
    /// Name the earlier version as `<change>/<offset>` instead of by commit id.
    #[serde(default)]
    pub target_evolog_offset: Option<u32>,
}

/// A recovery plan along one of jj's two time axes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeTravelPlan {
    pub axis: TimeAxis,
    pub args: Vec<String>,
    pub command: String,
    pub explanation: String,
    pub blast_radius: BlastRadius,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PatternError(pub String);

/// The jj command that recovers along the right time axis: the evolution
/// log for one change, the operation log for the whole repository.
///
/// Prefers a surgical single-change `evolog` restore over a repository-wide
/// `op restore` whenever sibling arms have independent work worth keeping.
/// The earlier version is named by its hidden commit id or by an offset
/// (`<change>/1`). Every input yields a plan; the `Result` leaves room for
/// stricter validation.
pub fn plan_time_travel_recovery(
    params: &TimeTravelParams,
) -> Result<TimeTravelPlan, PatternError> {
    let change_id = present(params.target_change_id.as_deref());
    // The earlier version: (as jj names it, as jjr shows it).
    let version = match (
        present(params.target_evolog_commit.as_deref()),
        params.target_evolog_offset,
        change_id,
    ) {
        (Some(commit), _, _) => Some((commit.to_owned(), short(commit).to_owned())),
        (None, Some(offset), Some(change)) if offset > 0 => Some((
            format!("{change}/{offset}"),
            format!("{}/{offset}", short(change)),
        )),
        _ => None,
    };
    if params.scope == RecoveryScope::SingleChange
        && let Some(change) = change_id
        && let Some((full, shown)) = version
    {
        let s = short(change);
        return Ok(TimeTravelPlan {
            axis: TimeAxis::Evolog,
            args: vec![
                "restore".to_owned(),
                "--from".to_owned(),
                full,
                "--to".to_owned(),
                change.to_owned(),
            ],
            command: format!("jj restore --from {shown} --to {s}"),
            explanation: format!(
                "Restores only change {s} to snapshot {shown} without disturbing sibling arms or repo bookmarks."
            ),
            blast_radius: BlastRadius::SingleChange,
        });
    }

    if let Some(op) = present(params.target_op_id.as_deref()) {
        let shown = format_short_id(op, 12);
        return Ok(TimeTravelPlan {
            axis: TimeAxis::OpLog,
            args: argv(&["op", "restore", op]),
            command: format!("jj op restore {shown}"),
            explanation: format!(
                "Rewinds the entire repository (commits, bookmarks, working copy) to operation {shown}."
            ),
            blast_radius: BlastRadius::RepoWide,
        });
    }

    Ok(TimeTravelPlan {
        axis: TimeAxis::OpLog,
        args: argv(&["undo"]),
        command: "jj undo".to_owned(),
        explanation: "Reverts the immediately preceding jj operation.".to_owned(),
        blast_radius: BlastRadius::RepoWide,
    })
}

/// The recipes the graph's state calls for: clean conflict resolution,
/// megamerge composition or fixup routing, Tidy First?, characterization
/// tests, stack validation, and convergence.
pub fn suggest_patterns_for_graph(graph: &JjrGraph) -> Vec<JjrRecipe> {
    let mut recipes = Vec::new();
    let mutable = graph.mutable();
    let roots: Vec<&JjrChange> = graph
        .mutable_roots()
        .into_iter()
        .filter(|r| !graph.is_scratchpad(r))
        .collect();
    let wc = graph.working_copy();
    let megamerge = mutable.iter().copied().find(|c| graph.is_megamerge(c));

    // Where a conflict starts, not the descendants that inherit it.
    let conflicted = graph.conflicted().into_iter().find(|c| {
        c.zone == Zone::Mutable
            && !c
                .parents
                .iter()
                .any(|p| graph.get(p).is_some_and(JjrChange::is_conflicted))
    });
    if let Some(c) = conflicted {
        recipes.push(JjrPatterns::resolve_conflict_cleanly(&c.change_id));
    }

    if let Some(m) = megamerge {
        recipes.push(JjrPatterns::absorb_fixups(if m.current_commit.is_empty {
            None
        } else {
            Some(&m.change_id)
        }));
    } else if roots.len() >= 2 {
        let arms: Vec<String> = roots.iter().take(4).map(|r| r.change_id.clone()).collect();
        recipes.push(JjrPatterns::local_megamerge(&arms, None));
    }

    let active_behavioral = wc
        .filter(|w| w.intent == ChangeIntent::Behavioral)
        .or_else(|| {
            mutable
                .iter()
                .copied()
                .find(|c| c.intent == ChangeIntent::Behavioral)
        });
    if let Some(b) = active_behavioral {
        recipes.push(JjrPatterns::tidy_first_below(
            &b.change_id,
            "prep seam before feature",
        ));
    }

    let structural = mutable
        .iter()
        .copied()
        .find(|c| c.intent == ChangeIntent::Structural);
    if let Some(s) = structural
        && !graph
            .mutable_ancestors_of(&s.change_id)
            .iter()
            .any(|a| a.intent == ChangeIntent::TestHarness)
    {
        recipes.push(JjrPatterns::characterization_tests_below(
            &s.change_id,
            "current behavior",
            None,
        ));
    }

    if mutable.iter().any(|c| !graph.is_scratchpad(c)) {
        recipes.push(JjrPatterns::stack_validation(None, None));
    }

    if !mutable.is_empty() {
        recipes.push(JjrPatterns::post_merge_convergence(roots.len() > 1));
    }

    recipes
}
